import { chainConfig } from "../config/dist/index.js";
import { base } from "viem/chains";
import { createPublicClient, createWalletClient, http, webSocket, type Address, encodeFunctionData, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";
import { createServer } from "http";
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

const ERC20_DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
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
  console.log("📡  触发来源：由 scheduler 的喷射(spray)会话控制，窗口暂不参与。");

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
  const PREDICTOR_URL = process.env.PREDICTOR_URL ?? "http://localhost:48080";
  const CANDIDATE_REFRESH_MS = 30_000; // 更频繁地刷新候选
  const CANDIDATE_BATCH = 200; // 一次扫描更多候选以更快命中有债地址
  const RISK_REFRESH_MS = 3_000; // Top-N 风险榜刷新频率
  // Top-N：默认为 1，可用 WORKER_TOP_N 覆盖
  const RISK_TOP_N = Math.max(1, Number(process.env.WORKER_TOP_N ?? '1'));
  const candidateSet = new Set<string>();
  let candidates: Address[] = [];
  let nextIdx = 0;
  let topRiskBorrowers: Address[] = [];
  let lastRiskSnapshot: { user: Address; riskE18: bigint }[] = [];
  const diag = {
    lastError: '' as string | undefined,
    lastAt: 0,
    positions: 0,
    priceOk: false,
    loanDec: -1,
    collDec: -1,
    aggDec: -1,
    loanToken: '' as string | undefined,
    collateralToken: '' as string | undefined,
    oracleFromParams: '' as string | undefined,
    totalBorrowAssets: '0',
    totalBorrowShares: '0',
    lltv: '0',
    topRiskCount: 0,
  };

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
    if (topRiskBorrowers.length > 0) {
      return topRiskBorrowers.slice(0, Math.min(RISK_TOP_N, topRiskBorrowers.length));
    }
    if (candidates.length === 0) return [];
    const out: Address[] = [];
    for (let i = 0; i < CANDIDATE_BATCH && i < candidates.length; i++) out.push(candidates[(nextIdx + i) % candidates.length]!);
    nextIdx = (nextIdx + CANDIDATE_BATCH) % Math.max(1, candidates.length);
    return out;
  }

  function toBigIntOr(v: any, d: bigint = 0n): bigint {
    try {
      if (typeof v === 'string') {
        // Handle strings like "123" or "123n" (from Ponder replaceBigInts)
        const s = v.endsWith('n') ? v.slice(0, -1) : v;
        return BigInt(s);
      }
      if (typeof v === 'bigint') return v;
      if (typeof v === 'number') return BigInt(Math.trunc(v));
    } catch {}
    return d;
  }

  function pow10(n: number): bigint { return 10n ** BigInt(n); }

  // 通过 Ponder API 获取市场视图/参数，避免直接链上读取带来的分歧
  async function getMarketViewFromPonder(): Promise<{
    loanToken: Address;
    collateralToken: Address;
    lltv: bigint;
    totalBorrowAssets: bigint;
    totalBorrowShares: bigint;
    loanDec: number;
    collDec: number;
  } | null> {
    try {
      const res = await fetch(new URL(`/chain/${MARKET.chainId}/marketView`, PONDER_API_URL), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ marketId: MARKET.marketId }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      return {
        loanToken: j.loanToken as Address,
        collateralToken: j.collateralToken as Address,
        lltv: toBigIntOr(j.lltv, 0n),
        totalBorrowAssets: toBigIntOr(j.totalBorrowAssets, 0n),
        totalBorrowShares: toBigIntOr(j.totalBorrowShares, 0n),
        loanDec: Number(j.loanDec ?? 18),
        collDec: Number(j.collDec ?? 18),
      };
    } catch { return null; }
  }

  async function getMarketParams() {
    return readContract(publicClient as any, {
      address: MARKET.morphoAddress,
      abi: morphoBlueAbi,
      functionName: "idToMarketParams",
      args: [MARKET.marketId],
    });
  }

  async function getMarketView() {
    return readContract(publicClient as any, {
      address: MARKET.morphoAddress,
      abi: morphoBlueAbi,
      functionName: "market",
      args: [MARKET.marketId],
    });
  }

  async function getTokenDecimals(addr: Address): Promise<number> {
    try {
      const dec = (await readContract(publicClient as any, { address: addr, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' })) as number;
      return Number(dec);
    } catch { return 18; }
  }

  async function fetchPredictedNow(): Promise<number | undefined> {
    try {
      const url = new URL(`/oracles/${MARKET.chainId}/${MARKET.aggregator}/predictionAt`, PREDICTOR_URL);
      url.searchParams.set('ts', String(Math.floor(Date.now() / 1000)));
      const res = await fetch(url);
      if (res.ok) {
        const j = await res.json();
        const v = (j?.answer ?? j?.predicted ?? j?.price) as number | string | undefined;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') return Number(v);
      }
    } catch {}
    return undefined;
  }

  async function refreshTopRisk(): Promise<void> {
    try {
      const mv = await getMarketViewFromPonder();
      if (!mv) { topRiskBorrowers = []; diag.topRiskCount = 0; diag.positions = 0; diag.priceOk = false; diag.lastError = 'marketView api error'; diag.lastAt = Date.now(); return; }
      const { lltv, loanToken: loanTokenAddr, collateralToken: collateralTokenAddr, loanDec, collDec, totalBorrowAssets, totalBorrowShares } = mv;
      diag.loanDec = loanDec; diag.collDec = collDec; diag.lltv = lltv.toString();
      diag.totalBorrowAssets = totalBorrowAssets.toString();
      diag.totalBorrowShares = totalBorrowShares.toString();
      diag.loanToken = loanTokenAddr;
      diag.collateralToken = collateralTokenAddr;
      // oracleFromParams 暂不从 Ponder 读取
      if (totalBorrowShares === 0n) { topRiskBorrowers = []; diag.topRiskCount = 0; diag.positions = 0; diag.priceOk = false; return; }

      // Fetch all positions for this market
      const res = await fetch(new URL(`/chain/${MARKET.chainId}/positions`, PONDER_API_URL), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ marketIds: [MARKET.marketId], onlyPreLiq: false, includeContracts: false })
      });
      if (!res.ok) return;
      const data = await res.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      const entry = results.find((r: any) => (r?.marketId as string)?.toLowerCase?.() === MARKET.marketId.toLowerCase());
      const list = Array.isArray(entry?.positions) ? entry.positions as any[] : [];
      diag.positions = list.length;
      if (!Array.isArray(list) || list.length === 0) { topRiskBorrowers = []; diag.topRiskCount = 0; return; }

      const price = await fetchPredictedNow();
      diag.priceOk = !!(price && price > 0);
      if (!price || !(price > 0)) { topRiskBorrowers = []; diag.topRiskCount = 0; return; }
      // Aggregator decimals assumed 8 by default, attempt to read from feed if needed
      let aggDecimals = 8;
      try {
        const d = (await readContract(publicClient as any, { address: MARKET.aggregator, abi: AGGREGATOR_V2V3_ABI, functionName: 'decimals' })) as number;
        aggDecimals = Number(d);
      } catch {}
      diag.aggDec = aggDecimals;

      const loanScale = pow10(loanDec);
      const collScale = pow10(collDec);
      const priceScale = pow10(aggDecimals);
      const priceScaled = BigInt(Math.round(price * Math.pow(10, aggDecimals)));

      const items: { user: Address; riskE18: bigint }[] = [];
      for (const p of list) {
        const user = p.user as Address;
        const bShares = toBigIntOr(p.borrowShares, 0n);
        if (bShares <= 0n) continue;
        const collateral = toBigIntOr(p.collateral, 0n);
        // borrowAssets in loan token units
        const borrowAssets = (bShares * totalBorrowAssets) / totalBorrowShares;
        // collateral value in loan units: collateral * priceScaled * 10^loanDec / (10^collDec * 10^aggDec)
        const collValueLoan = (collateral * priceScaled * loanScale) / (collScale * priceScale);
        if (collValueLoan === 0n) continue;
        const maxBorrow = (collValueLoan * lltv) / BigInt(1e18);
        if (maxBorrow === 0n) continue;
        const riskE18 = (borrowAssets * BigInt(1e18)) / maxBorrow;
        items.push({ user, riskE18 });
      }
      items.sort((a, b) => (b.riskE18 > a.riskE18 ? 1 : b.riskE18 < a.riskE18 ? -1 : 0));
      topRiskBorrowers = items.slice(0, RISK_TOP_N).map((x) => x.user);
      lastRiskSnapshot = items.slice(0, 50);
      diag.topRiskCount = topRiskBorrowers.length;
      diag.lastError = undefined; diag.lastAt = Date.now();
      if (process.env.WORKER_VERBOSE === '1') {
        console.log(`⚖️ Top risk borrowers updated (N=${topRiskBorrowers.length})`);
      }
    } catch (e) {
      diag.lastError = (e as any)?.message ?? String(e);
      diag.lastAt = Date.now();
      topRiskBorrowers = [];
      diag.topRiskCount = 0;
      if (process.env.WORKER_VERBOSE === '1') console.warn('refreshTopRisk error', diag.lastError);
    }
  }

  // 接收 scheduler 推送（spray 会话）
  const wsUrl = `ws://localhost:48201/ws/schedule?chainId=${MARKET.chainId}&oracle=${MARKET.aggregator}`;
  let latest: Sched | undefined;
  let sprayActive = false;
  let sprayReason: string | undefined;
  let sprayStartedAt: number | undefined;
  const metrics = { sessions: 0, attempts: 0, onchainFail: 0, success: 0 };
  // 模拟统计与耗时埋点（按需开启：WORKER_SIMULATE=1）
  const doSimulate = process.env.WORKER_SIMULATE === '1';
  const bypassPct = Math.max(0, Math.min(1, Number(process.env.WORKER_BYPASS_SIM_PCT ?? '0')));
  const sim = {
    count: 0, // legacy (unused now)
    blocked: 0, // legacy (unused now)
    bypassSent: 0,
    rawAttempts: 0,
    rawErrors: 0,
    durations: [] as number[], // 仅保留最近 500 次
    push(ms: number) {
      this.durations.push(ms);
      if (this.durations.length > 500) this.durations.shift();
    },
    p(q: number) {
      if (this.durations.length === 0) return 0;
      const arr = [...this.durations].sort((a, b) => a - b);
      const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(q * (arr.length - 1))));
      return arr[idx] ?? 0;
    },
    avg() {
      if (this.durations.length === 0) return 0;
      return this.durations.reduce((a, b) => a + b, 0) / this.durations.length;
    },
  };
  const ws = new WebSocket(wsUrl);
  ws.on("open", () => console.log(`📡 已连接 oracle-scheduler: ${wsUrl}`));
  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg?.type === 'spray') {
        if (msg.action === 'start') {
          sprayActive = true;
          sprayReason = msg.reason;
          sprayStartedAt = Number(msg.startedAt ?? Date.now());
          metrics.sessions++;
          console.log(`🚨 进入喷射模式 reason=${sprayReason} cadence=${msg.cadenceMs ?? 200}ms`);
        } else if (msg.action === 'stop') {
          const endedBy = msg.reason;
          const roundId = msg.roundId;
          const ts = msg.ts;
          if (sprayActive) {
            const durMs = sprayStartedAt ? Date.now() - sprayStartedAt : undefined;
            const line = JSON.stringify({ kind: 'spraySession', reason: sprayReason, startedAt: sprayStartedAt, endedAt: Date.now(), endedBy, roundId, transmitTs: ts, durationMs: durMs }) + "\n";
            try { await appendFile('out/worker-sessions.ndjson', line); } catch {}
          }
          sprayActive = false; sprayReason = undefined; sprayStartedAt = undefined;
          console.log(`🛑 退出喷射模式 reason=${endedBy ?? 'unknown'}`);
        }
      } else if (msg?.data) {
        // 兼容旧窗口消息（不使用）
        latest = msg.data as Sched;
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

  // 主循环：喷射模式下每 150ms 尝试（更激进）
  // Cache baseFee for a short window to avoid per-tick RPC load
  let lastFeeAt = 0; let lastBaseFee: bigint | null = null;
  async function currentFees(sessionStartMs?: number) {
    const now = Date.now();
    if (!lastBaseFee || now - lastFeeAt > 1000) {
      try {
        const blk = await (publicClient as any).getBlock();
        lastBaseFee = blk?.baseFeePerGas ?? null;
        lastFeeAt = now;
      } catch {}
    }
    const base = lastBaseFee ?? 0n;
    const minPrioGwei = Number(process.env.WORKER_MIN_PRIORITY_GWEI ?? '1.0');
    const stepGwei = Number(process.env.WORKER_PRIORITY_STEP_GWEI ?? '0.25');
    const maxPrioGwei = Number(process.env.WORKER_MAX_PRIORITY_GWEI ?? '5.0');
    const stepSec = Number(process.env.WORKER_FEE_STEP_SEC ?? '2');
    const elapsed = sessionStartMs ? Math.max(0, Math.floor((now - sessionStartMs) / 1000)) : 0;
    const steps = Math.floor(elapsed / Math.max(1, stepSec));
    const prioGwei = Math.min(maxPrioGwei, minPrioGwei + steps * stepGwei);
    const prio = parseGwei(`${prioGwei} gwei`);
    // cap maxFee to base * 2 + prio (simple cushion)
    const maxFee = base > 0n ? base * 2n + prio : prio * 2n;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio };
  }

  // 喷射频率：默认 200ms，可用 WORKER_SPRAY_CADENCE_MS 覆盖
  const WORKER_SPRAY_CADENCE_MS = Math.max(50, Number(process.env.WORKER_SPRAY_CADENCE_MS ?? '200'));
  const forceBypass = true;
  console.log(`⚙️ 配置 simulate=${doSimulate} rawSend=always cadenceMs=${WORKER_SPRAY_CADENCE_MS}`);
  setInterval(async () => {
    if (!sprayActive) return;

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
          // 始终直发（不模拟）
          let hash: `0x${string}`;
          const data = encodeFunctionData({
            abi: FLASH_LIQUIDATOR_ABI,
            functionName: 'flashLiquidate',
            args: [borrower, REQUESTED_REPAY_USDC, prevRoundId, minProfitDefault],
          });
          const gasLimit = BigInt(process.env.WORKER_GAS_LIMIT ?? "900000");
          const fees = await currentFees(sprayStartedAt);
          sim.bypassSent++; sim.rawAttempts++;
          try {
            hash = await exec.wc.sendTransaction({ to: flashLiquidator, data, gas: gasLimit, ...fees });
          } catch (err) {
            // 原始发送被节点拒绝
            sim.rawErrors++;
            if (process.env.WORKER_VERBOSE === '1') {
              console.warn(`⚠️ raw send 失败 ${borrower}`, (err as any)?.shortMessage ?? (err as any)?.message ?? err);
            }
            return;
          }
          console.log(`⚡ ${exec.label} 清算发送 ${borrower} tx=${hash}`);
          metrics.attempts++;
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
              metrics.onchainFail++;
              console.warn(`⛔ on-chain revert ${borrower} tx=${hash} gasUsed=${rc.gasUsed?.toString?.()}${reason ? ` reason=${reason}` : ''}`);
            } else {
              // Success path
              const sline = JSON.stringify({
                kind: 'onchainSuccess', chainId: MARKET.chainId, borrower,
                tx: hash, blockNumber: rc.blockNumber?.toString?.(),
                gasUsed: rc.gasUsed?.toString?.(),
                ts: Date.now(),
              }) + "\n";
              try { await appendFile('out/worker-tx-success.ndjson', sline); } catch {}
              metrics.success++;
              console.log(`✅ on-chain success ${borrower} tx=${hash} gasUsed=${rc.gasUsed?.toString?.()}`);
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
  }, WORKER_SPRAY_CADENCE_MS);

  // 非阻塞加载候选，避免 Ponder API 慢/挂导致后续排序不执行
  fetchCandidates().catch(() => {});
  setInterval(() => { fetchCandidates().catch(() => {}); }, CANDIDATE_REFRESH_MS);
  // 风险 Top-N 定时刷新
  await refreshTopRisk();
  setInterval(refreshTopRisk, RISK_REFRESH_MS);
  // Metrics endpoint
  try {
    const srv = createServer((_req, res) => {
      if (_req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          sessions: metrics.sessions,
          attempts: metrics.attempts,
          onchainFail: metrics.onchainFail,
          success: metrics.success,
          params: {
            requestedRepay: REQUESTED_REPAY_USDC.toString(),
            minProfit: minProfitDefault.toString(),
            marketId: MARKET.marketId,
            aggregator: MARKET.aggregator,
            cadenceMs: WORKER_SPRAY_CADENCE_MS,
          },
          raw: {
            attempts: sim.rawAttempts,
            errors: sim.rawErrors,
            sent: sim.bypassSent,
            cadenceMs: WORKER_SPRAY_CADENCE_MS,
          },
          topRisk: lastRiskSnapshot.slice(0, RISK_TOP_N).map((x) => ({ user: x.user, riskBps: Number((x.riskE18 * 10000n) / 1000000000000000000n) })),
          diag,
        }));
        return;
      }
      if (_req.url?.startsWith('/top-risk')) {
        const body = lastRiskSnapshot.map((x) => ({ user: x.user, riskE18: x.riskE18.toString() }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ list: body, topN: RISK_TOP_N }));
        return;
      }
      res.statusCode = 404; res.end('not found');
    });
    const desired = Number(process.env.WORKER_METRICS_PORT ?? 48102);
    if (desired <= 0) {
      console.warn('ℹ️ metrics server disabled by WORKER_METRICS_PORT');
    } else {
      const maxTries = 10;
      const tryListen = (p: number, remain: number) => {
        const onError = (err: any) => {
          if (err?.code === 'EADDRINUSE' && remain > 0) {
            const next = p + 1;
            console.warn(`⚠️ metrics port :${p} in use, trying :${next}`);
            // cleanup and retry on next tick
            try { srv.removeListener('error', onError); srv.close(); } catch {}
            setTimeout(() => tryListen(next, remain - 1), 0);
          } else {
            console.warn(`⚠️ metrics server disabled (${err?.message ?? err})`);
            try { srv.removeListener('error', onError); } catch {}
          }
        };
        // Attach error handler before listen to catch synchronous errors
        srv.once('error', onError);
        try {
          srv.listen(p, () => {
            try { srv.removeListener('error', onError); } catch {}
            console.log(`📊 Predictive worker metrics on :${p}/metrics`);
          });
        } catch (e: any) {
          onError(e);
        }
      };
      tryListen(desired, maxTries);
    }
  } catch {}
  console.log("✅ 预测型策略已启动（等待 scheduler 推送窗口）");
}

main().catch((e) => { console.error(e); process.exit(1); });
