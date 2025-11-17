import { chainConfig } from "../config/dist/index.js";
import { base } from "viem/chains";
import { createPublicClient, createWalletClient, http, webSocket, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";
import { readContract } from "viem/actions";
import { appendFile } from "node:fs/promises";

import { morphoBlueAbi } from "../ponder/abis/MorphoBlue.js";
import { AGGREGATOR_V2V3_ABI } from "./utils/chainlinkAbi.js";

// 预测型策略：由 oracle-scheduler 的 WS 推送驱动，
// 在偏差/心跳窗口内用预测价快速评估清算并发起交易（适合大额）。

const MARKET = {
  chainId: base.id,
  marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" as const,
  morphoAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address,
  // Chainlink OCR2 aggregator (for events) and Feed proxy (for latestRoundData/roundId)
  aggregator: "0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8" as Address,
};
// Feed proxy used for prevRoundId reads to match on-chain gating
const FEED_PROXY = "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F" as Address;

const FLASH_LIQUIDATOR_ABI = [
  {
    inputs: [
      { internalType: "address", name: "borrower", type: "address" },
      { internalType: "uint256", name: "requestedRepay", type: "uint256" },
      { internalType: "uint80", name: "prevRoundId", type: "uint80" },
      { internalType: "uint256", name: "minProfit", type: "uint256" },
    ],
    name: "flashLiquidate",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

type Win = { start: number; end: number; state?: string; deltaBps?: number };
type Sched = { heartbeat?: Win; deviation?: Win };

async function main() {
  const cfg = chainConfig(MARKET.chainId);
  const forceHttp = process.env.WORKER_FORCE_HTTP === '1' || process.env.FORCE_HTTP === '1';
  // Cache a single WS transport per URL in this process
  const wsCache = new Map<string, ReturnType<typeof webSocket>>();
  function getWs(url: string) {
    const ex = wsCache.get(url);
    if (ex) return ex;
    const t = webSocket(url);
    wsCache.set(url, t);
    return t;
  }
  const publicClient = createPublicClient({ chain: base, transport: (!forceHttp && cfg.wsRpcUrl) ? getWs(cfg.wsRpcUrl) : http(cfg.rpcUrl) });
  const flashLiquidator =
    (process.env[`FLASH_LIQUIDATOR_ADDRESS_${MARKET.chainId}`] as Address | undefined) ??
    (process.env.FLASH_LIQUIDATOR_ADDRESS as Address | undefined);
  if (!flashLiquidator) {
    throw new Error("FLASH_LIQUIDATOR_ADDRESS_<chainId> or FLASH_LIQUIDATOR_ADDRESS missing in .env");
  }
  const minProfitDefault =
    BigInt(process.env.FLASH_LIQUIDATOR_MIN_PROFIT ?? "100000"); // 0.1 USDC

  console.log("🚀 启动预测型 Worker: Base cbBTC/USDC (WS 驱动)");
  console.log(`⚙️  Flash liquidator: ${flashLiquidator}`);
  console.log("📡  触发来源：优先使用 scheduler 推送的 shots；若无 shots 但当前时刻位于 scheduler 窗口内，同样按 200ms 节奏尝试。");

  function decodeRevertString(data?: string): string | undefined {
    if (!data || typeof data !== 'string') return undefined;
    // Error(string): 0x08c379a0 | offset(32) | strLen(32) | strBytes
    if (!data.startsWith('0x08c379a0')) return undefined;
    try {
      const hex = data.slice(10); // strip selector
      const lenHex = '0x' + hex.slice(64, 128);
      const len = Number(BigInt(lenHex));
      const strHex = hex.slice(128, 128 + len * 2);
      const bytes = Buffer.from(strHex, 'hex');
      return bytes.toString('utf8');
    } catch { return undefined; }
  }

  function parseList(key: string): string[] | undefined {
    const v = process.env[key];
    if (!v) return undefined;
    const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  const multiPrivKeys = parseList(`LIQUIDATION_PRIVATE_KEYS_${MARKET.chainId}`);
  const executors: { wc: ReturnType<typeof createWalletClient>; label: string }[] = [];
  if (multiPrivKeys && multiPrivKeys.length > 0) {
    for (let i = 0; i < multiPrivKeys.length; i++) {
      const account = privateKeyToAccount(multiPrivKeys[i]! as `0x${string}`);
      const wc = createWalletClient({ chain: base, transport: http(cfg.rpcUrl), account });
      executors.push({ wc, label: `exec#${i}(${account.address})` });
    }
    console.log(`🔱 多执行器私钥配置: ${executors.length} 个`);
  } else {
    const singleKey =
      process.env[`LIQUIDATION_PRIVATE_KEY_${MARKET.chainId}`] ??
      process.env.LIQUIDATION_PRIVATE_KEY;
    if (!singleKey) {
      throw new Error(
        `LIQUIDATION_PRIVATE_KEYS_${MARKET.chainId} 或 LIQUIDATION_PRIVATE_KEY_${MARKET.chainId} 未配置`,
      );
    }
    const account = privateKeyToAccount(singleKey as `0x${string}`);
    executors.push({
      wc: createWalletClient({ chain: base, transport: http(cfg.rpcUrl), account }),
      label: `default(${account.address})`,
    });
  }

  // 候选账户（与确认型相同）
  const PONDER_API_URL = "http://localhost:42069";
  const CANDIDATE_REFRESH_MS = 60_000;
  const CANDIDATE_BATCH = 50;
  const candidateSet = new Set<string>();
  let candidates: Address[] = [];
  let nextIdx = 0;

  async function fetchCandidates(): Promise<void> {
    try {
      const res = await fetch(new URL(`/chain/${MARKET.chainId}/candidates`, PONDER_API_URL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marketIds: [MARKET.marketId] }),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, Address[]>;
        for (const a of data[MARKET.marketId] ?? []) candidateSet.add(a.toLowerCase());
      } else {
        // fallback: hydrate from logs (confirmed chain logs)
        const head = await publicClient.getBlockNumber();
        const fromBlock = head > 10_000n ? head - 10_000n : 0n;
        const borrowEvent = (await import("viem")).getAbiItem({ abi: morphoBlueAbi, name: "Borrow" }) as any;
        const supplyColEvent = (await import("viem")).getAbiItem({ abi: morphoBlueAbi, name: "SupplyCollateral" }) as any;
        const step = 2_000n;
        for (let start = fromBlock; start <= head; start += step) {
          const end = start + step - 1n > head ? head : start + step - 1n;
          try {
            const [borrows, supplies] = await Promise.all([
              publicClient.getLogs({ address: MARKET.morphoAddress, event: borrowEvent, args: { id: MARKET.marketId as any }, fromBlock: start, toBlock: end } as any),
              publicClient.getLogs({ address: MARKET.morphoAddress, event: supplyColEvent, args: { id: MARKET.marketId as any }, fromBlock: start, toBlock: end } as any),
            ]);
            for (const log of borrows as any[]) candidateSet.add((log.args.onBehalf as string).toLowerCase());
            for (const log of supplies as any[]) candidateSet.add((log.args.onBehalf as string).toLowerCase());
          } catch {}
        }
      }
      candidates = [...candidateSet] as Address[];
      console.log(`👥 Candidates loaded: ${candidates.length}`);
    } catch (e) {
      console.warn("⚠️ candidates fetch error:", e);
    }
  }

  function pickBatch(): Address[] {
    if (candidates.length === 0) return [];
    const out: Address[] = [];
    for (let i = 0; i < CANDIDATE_BATCH && i < candidates.length; i++) out.push(candidates[(nextIdx + i) % candidates.length]!);
    nextIdx = (nextIdx + CANDIDATE_BATCH) % Math.max(1, candidates.length);
    return out;
  }

  // 接收 scheduler 推送
  const wsUrl = `ws://localhost:48201/ws/schedule?chainId=${MARKET.chainId}&oracle=${MARKET.aggregator}`;
  let latest: Sched | undefined;
  let shotQueue: number[] = [];
  const ws = new WebSocket(wsUrl);
  ws.on("open", () => console.log(`📡 已连接 oracle-scheduler: ${wsUrl}`));
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg?.data) {
        latest = msg.data as Sched;
        const dev: any = (latest as any).deviation;
        if (dev?.shotsMs && Array.isArray(dev.shotsMs)) {
          const now = Date.now();
          for (const t of dev.shotsMs as number[]) if (t > now) shotQueue.push(t);
          // dedupe & sort
          shotQueue = Array.from(new Set(shotQueue)).sort((a,b)=>a-b);
        }
      }
    } catch {}
  });
  ws.on("close", () => console.log("⚠️ scheduler WS 断开，等待重连(由系统自动)"));
  ws.on("error", () => {});
let lastRoundId: bigint | null = null;
const REQUESTED_REPAY_USDC: bigint = 50_000_000n; // 50 USDC in 6 decimals

async function getPrevOrCurrentRoundId(): Promise<bigint> {
  const round = (await readContract(publicClient as any, {
    address: MARKET.aggregator,
    abi: AGGREGATOR_V2V3_ABI,
    functionName: "latestRoundData",
  })) as [bigint, bigint, bigint, bigint, bigint];
  const current = BigInt(round[0]);
  if (lastRoundId !== null && current > lastRoundId) {
    const prev = lastRoundId;
    lastRoundId = current;
    return prev;
  }
  if (lastRoundId === null) lastRoundId = current;
  return current;
}

  async function fetchBorrowShares(user: Address): Promise<bigint> {
    const [, borrowShares] = (await readContract(publicClient as any, {
      address: MARKET.morphoAddress,
      abi: morphoBlueAbi,
      functionName: "position",
      args: [MARKET.marketId, user],
    })) as [bigint, bigint, bigint];
    return borrowShares;
  }

  async function fetchPrevRoundId(): Promise<bigint | null> {
    const round = (await readContract(publicClient as any, {
      address: FEED_PROXY,
      abi: AGGREGATOR_V2V3_ABI,
      functionName: "latestRoundData",
    })) as [bigint, bigint, bigint, bigint, bigint];
    const roundId = BigInt(round[0]);
    if (lastRoundId === null) {
      lastRoundId = roundId;
      return null;
    }
    if (roundId <= lastRoundId) {
      return null;
    }
    const prev = lastRoundId;
    lastRoundId = roundId;
    return prev;
  }

  // 主循环：窗口内每 200ms 尝试（若 scheduler 有 shots 按 shots，否则依据当前窗口时段）
  setInterval(async () => {
    const nowMs = Date.now();
    let shouldFire = false;
    if (shotQueue.length && shotQueue[0]! <= nowMs + 10) {
      shouldFire = true;
      while (shotQueue.length && shotQueue[0]! <= nowMs + 10) shotQueue.shift();
    } else if (latest) {
      const dev = (latest as any).deviation;
      const hb = (latest as any).heartbeat;
      const inDev = dev && typeof dev.start === 'number' && typeof dev.end === 'number' && Math.floor(nowMs/1000) >= dev.start && Math.floor(nowMs/1000) <= dev.end;
      const inHb = hb && typeof hb.start === 'number' && typeof hb.end === 'number' && Math.floor(nowMs/1000) >= hb.start && Math.floor(nowMs/1000) <= hb.end;
      shouldFire = Boolean(inDev || inHb);
    }
    if (!shouldFire) return;

    const prevRoundId = await getPrevOrCurrentRoundId();

    const batch = pickBatch();
    if (batch.length === 0) return;
    const targets: Address[] = [];
    for (const candidate of batch) {
      try {
        const shares = await fetchBorrowShares(candidate);
        if (shares > 0n) {
          targets.push(candidate);
        }
      } catch (err) {
        console.warn("⚠️ fetch position failed", candidate, err);
      }
      if (targets.length >= executors.length) break;
    }
    if (targets.length === 0) return;

    await Promise.all(
      targets.slice(0, executors.length).map(async (borrower, idx) => {
        const exec = executors[idx]!;
        try {
          const hash = await exec.wc.writeContract({
            address: flashLiquidator,
            abi: FLASH_LIQUIDATOR_ABI,
            functionName: "flashLiquidate",
            args: [borrower, REQUESTED_REPAY_USDC, prevRoundId, minProfitDefault],
          });
          console.log(`⚡ ${exec.label} 清算发送 ${borrower} tx=${hash}`);
          try {
            const rc = await (publicClient as any).waitForTransactionReceipt({ hash });
            if (rc?.status && String(rc.status) !== 'success') {
              // Best-effort revert reason: re-call at the same block
              let reason: string | undefined;
              try {
                const tx = await (publicClient as any).getTransaction({ hash });
                // This call is expected to revert and throw
                await (publicClient as any).call({ to: tx.to, data: tx.input, from: tx.from, value: tx.value, gas: tx.gas, blockNumber: rc.blockNumber });
              } catch (err: any) {
                const raw = (err?.data as string | undefined) || (err?.cause?.data as string | undefined) || (err?.error?.data as string | undefined);
                reason = decodeRevertString(raw) || (err?.shortMessage as string | undefined) || (err?.message as string | undefined);
              }
              const line = JSON.stringify({
                kind: 'onchainFail', chainId: MARKET.chainId, borrower,
                tx: hash, blockNumber: rc.blockNumber?.toString?.(),
                gasUsed: rc.gasUsed?.toString?.(), reason,
                ts: Date.now(),
              }) + "\n";
              try { await appendFile('out/worker-tx-failures.ndjson', line); } catch {}
              console.warn(`⛔ on-chain revert ${borrower} tx=${hash} gasUsed=${rc.gasUsed?.toString?.()}${reason ? ` reason=${reason}` : ''}`);
            }
          } catch (e) {
            // 等待回执阶段错误（如超时），仅在 VERBOSE 下提示
            if (process.env.WORKER_VERBOSE === '1') {
              console.warn(`waitForTransactionReceipt error tx=${hash}`, (e as any)?.message ?? e);
            }
          }
        } catch (error) {
          // 估算阶段失败或发送被节点拒绝（未广播），默认不刷屏，仅在 VERBOSE 下打印
          if (process.env.WORKER_VERBOSE === '1') {
            console.warn(`⚠️ simulate/send 失败 ${borrower}`, (error as Error).message ?? error);
          }
        }
      })
    );
  }, 200);

  await fetchCandidates();
  setInterval(fetchCandidates, CANDIDATE_REFRESH_MS);
  console.log("✅ 预测型策略已启动（等待 scheduler 推送窗口）");
}

main().catch((e) => { console.error(e); process.exit(1); });
