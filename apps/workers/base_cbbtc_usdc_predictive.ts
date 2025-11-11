import { chainConfig } from "../config/dist/index.js";
import { base } from "viem/chains";
import { createPublicClient, createWalletClient, http, webSocket, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";
import { readContract } from "viem/actions";

import { morphoBlueAbi } from "../ponder/abis/MorphoBlue.js";
import { AGGREGATOR_V2V3_ABI } from "./utils/chainlinkAbi.js";

// 预测型策略：由 oracle-scheduler 的 WS 推送驱动，
// 在偏差/心跳窗口内用预测价快速评估清算并发起交易（适合大额）。

const MARKET = {
  chainId: base.id,
  marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" as const,
  morphoAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address,
  aggregator: "0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8" as Address,
};

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
  const publicClient = createPublicClient({ chain: base, transport: cfg.wsRpcUrl ? webSocket(cfg.wsRpcUrl) : http(cfg.rpcUrl) });
  const walletClient = createWalletClient({ chain: base, transport: http(cfg.rpcUrl), account: privateKeyToAccount(cfg.liquidationPrivateKey) });
  const flashLiquidator =
    (process.env[`FLASH_LIQUIDATOR_ADDRESS_${MARKET.chainId}`] as Address | undefined) ??
    (process.env.FLASH_LIQUIDATOR_ADDRESS as Address | undefined);
  if (!flashLiquidator) {
    throw new Error("FLASH_LIQUIDATOR_ADDRESS_<chainId> or FLASH_LIQUIDATOR_ADDRESS missing in .env");
  }
  const minProfitDefault =
    BigInt(process.env.FLASH_LIQUIDATOR_MIN_PROFIT ?? "100000"); // 0.1 USDC

  console.log("🚀 启动预测型 Worker: Base cbBTC/USDC (WS 驱动)");

  function parseList(key: string): string[] | undefined {
    const v = process.env[key];
    if (!v) return undefined;
    const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  const multiGuardAddrs = parseList(`FLASH_EXECUTOR_ADDRESSES_${MARKET.chainId}`) ?? parseList(`GUARD_ADDRESSES_${MARKET.chainId}`);
  const multiPrivKeys = parseList(`LIQUIDATION_PRIVATE_KEYS_${MARKET.chainId}`);
  const executors: { wc: ReturnType<typeof createWalletClient>; label: string }[] = [];
  if (multiGuardAddrs && multiPrivKeys && multiGuardAddrs.length === multiPrivKeys.length) {
    for (let i = 0; i < multiGuardAddrs.length; i++) {
      const wc = createWalletClient({ chain: base, transport: http(cfg.rpcUrl), account: privateKeyToAccount(multiPrivKeys[i]! as any) });
      executors.push({ wc, label: `exec#${i}` });
    }
    console.log(`🔱 多执行器私钥配置: ${executors.length} 个`);
  } else {
    console.warn("⚠️ 未配置 FLASH_EXECUTOR_ADDRESSES_*/LIQUIDATION_PRIVATE_KEYS_*, 默认使用单一执行私钥");
    executors.push({ wc: walletClient as any, label: "default" });
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
      address: MARKET.aggregator,
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

  // 主循环：按照 scheduler shots 触发（200ms 精度）
  setInterval(async () => {
    const nowMs = Date.now();
    if (shotQueue.length === 0) return;
    if (shotQueue[0]! > nowMs) return;
    const due: number[] = [];
    while (shotQueue.length && shotQueue[0]! <= nowMs + 10) due.push(shotQueue.shift()!);
    if (due.length === 0) return;

    const prevRoundId = await fetchPrevRoundId();
    if (prevRoundId === null) {
      return;
    }

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
            args: [borrower, 0n, prevRoundId, minProfitDefault],
          });
          console.log(`⚡ ${exec.label} 清算 ${borrower} tx=${hash}`);
        } catch (error) {
          console.warn(`⚠️ flashLiquidate 失败 ${borrower}`, (error as Error).message ?? error);
        }
      })
    );
  }, 200);

  await fetchCandidates();
  setInterval(fetchCandidates, CANDIDATE_REFRESH_MS);
  console.log("✅ 预测型策略已启动（等待 scheduler 推送窗口）");
}

main().catch((e) => { console.error(e); process.exit(1); });
