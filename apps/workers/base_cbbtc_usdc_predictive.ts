import { chainConfig } from "../config/dist/index.js";
import { base } from "viem/chains";
import { createPublicClient, createWalletClient, http, webSocket, type Address, encodeFunctionData, parseGwei } from "viem";
import { decodeErrorResult, decodeEventLog } from "viem";
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
  {
    inputs: [],
    name: "lastRoundIdStored",
    outputs: [{ internalType: "uint80", name: "", type: "uint80" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Liquidator events (for spray control)
const LIQ_EVENTS_ABI = [
  { type: 'event', name: 'OracleAdvanced', inputs: [ { type: 'uint80', name: 'prev', indexed: false }, { type: 'uint80', name: 'curr', indexed: false } ] },
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

  // Try to decode custom errors first (Liquidator), then fall back to Error(string)
  const LIQ_ERRORS_ABI = [
    { type: 'error', name: 'NotAuthorized', inputs: [] },
    { type: 'error', name: 'RoundNotAdvanced', inputs: [ { type: 'uint80', name: 'prev' }, { type: 'uint80', name: 'curr' } ] },
    { type: 'error', name: 'PositionHealthy', inputs: [] },
    { type: 'error', name: 'MinProfitNotMet', inputs: [] },
  ] as const;

  function decodeErrorData(data?: string): { kind: 'custom'|'string'|'unknown'; message?: string; selector?: string } {
    if (!data || typeof data !== 'string' || !data.startsWith('0x')) return { kind: 'unknown' };
    const selector = data.slice(0, 10);
    try {
      const dec = decodeErrorResult({ abi: LIQ_ERRORS_ABI as any, data: data as `0x${string}` });
      const name = (dec as any)?.errorName as string | undefined;
      if (name) return { kind: 'custom', message: name, selector };
    } catch {}
    const s = decodeRevertString(data);
    if (s) return { kind: 'string', message: s, selector };
    return { kind: 'unknown', selector };
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
  console.log(`🔱 执行器数量: ${executors.length}`);

  // 候选账户（与确认型相同）
  const PONDER_API_URL = "http://localhost:42069";
  const PREDICTOR_URL = process.env.PREDICTOR_URL ?? "http://localhost:48080";
  const CANDIDATE_REFRESH_MS = 30_000; // 更频繁地刷新候选
  const CANDIDATE_BATCH = 200; // 一次扫描更多候选以更快命中有债地址
  const RISK_REFRESH_MS = 3_000; // Top-N 风险榜刷新频率
  // Top-N：默认 5，可用 WORKER_TOP_N 覆盖（用于评估挑选最佳目标）
  const RISK_TOP_N = Math.max(1, Number(process.env.WORKER_TOP_N ?? '5'));
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

  // Fit summary（误差分布）缓存，降低请求频率
  let fitSummaryCache: { ts: number; p90AbsBps: number; biasBps: number } | null = null;
  async function fetchFitSummary(): Promise<{ p90AbsBps: number; biasBps: number } | undefined> {
    try {
      const now = Date.now();
      if (fitSummaryCache && now - fitSummaryCache.ts < 60_000) return { p90AbsBps: fitSummaryCache.p90AbsBps, biasBps: fitSummaryCache.biasBps };
      const url = new URL(`/oracles/${MARKET.chainId}/${MARKET.aggregator}/fitSummary`, PREDICTOR_URL);
      url.searchParams.set('limit', '120');
      const res = await fetch(url);
      if (!res.ok) return undefined;
      const data = await res.json();
      const out = { p90AbsBps: Number(data?.p90AbsBps ?? 10), biasBps: Number(data?.biasMedianBps ?? 0) };
      fitSummaryCache = { ts: now, ...out } as any;
      return out;
    } catch { return undefined; }
  }

  // 评估单个 borrower 的风险与（保守）利润，返回评分
  async function assessCandidate(user: Address, opts: { loanDec: number; collDec: number; aggDec: number; lltv: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint }): Promise<{ score: number; ok: boolean }> {
    try {
      const price = await fetchPredictedNow();
      if (!price || !(price > 0)) return { score: -1, ok: false };
      const fit = await fetchFitSummary();
      const errBps = Math.max(5, Number(fit?.p90AbsBps ?? 10));
      const biasBps = Number(fit?.biasBps ?? 0);
      const loanScale = pow10(opts.loanDec); const collScale = pow10(opts.collDec); const priceScale = pow10(opts.aggDec);
      const priceScaled = BigInt(Math.round(price * Math.pow(10, opts.aggDec)));

      // 读取 position
      const [, bSharesRaw, collateralRaw] = (await readContract(publicClient as any, { address: MARKET.morphoAddress, abi: morphoBlueAbi, functionName: 'position', args: [MARKET.marketId, user] })) as [bigint, bigint, bigint];
      if (bSharesRaw <= 0n) return { score: -1, ok: false };

      const borrowAssets = (bSharesRaw * opts.totalBorrowAssets) / opts.totalBorrowShares; // in loan units
      // 保守风控：按不利方向缩小抵押估值（price*(1 - errBps/1e4) - bias）
      const adjBps = Math.max(0, 10_000 - errBps - Math.abs(biasBps));
      const priceAdj = (priceScaled * BigInt(adjBps)) / 10_000n;
      const collValueLoan = (collateralRaw * priceAdj * loanScale) / (collScale * priceScale);
      if (collValueLoan === 0n) return { score: -1, ok: false };
      const maxBorrow = (collValueLoan * opts.lltv) / BigInt(1e18);
      // 风险评分：越大越危险
      const num = Number(borrowAssets > maxBorrow ? (borrowAssets - maxBorrow) : 0n);
      const den = Number(borrowAssets === 0n ? 1n : borrowAssets);
      const score = den > 0 ? num / den : 0;
      // 假设有风险就 ok（测试阶段接受失败）
      return { score, ok: score > 0 };
    } catch { return { score: -1, ok: false }; }
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
  let sessionRound: bigint | null = null; // roundId at session start; stop only when strictly greater
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
    nonceErrors: 0,
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
          // Capture current round at session start for robust stop condition
          try {
            const rd = (await readContract(publicClient as any, { address: FEED_PROXY, abi: AGGREGATOR_V2V3_ABI, functionName: 'latestRoundData' })) as [bigint, bigint, bigint, bigint, bigint];
            sessionRound = BigInt(rd[0]);
          } catch { sessionRound = null; }
          // 立即尝试一次，避免短会话在下一拍前结束
          try { await doSprayTick(); } catch {}
          // 再补一拍，提升命中率
          setTimeout(() => { if (sprayActive) { doSprayTick().catch(() => {}); } }, Math.max(50, Math.floor(WORKER_SPRAY_CADENCE_MS / 3)));
        } else if (msg.action === 'stop') {
          const endedBy = msg.reason;
          const roundId = msg.roundId;
          const ts = msg.ts;
          if (sprayActive) {
            const durMs = sprayStartedAt ? Date.now() - sprayStartedAt : undefined;
            const line = JSON.stringify({ kind: 'spraySession', reason: sprayReason, startedAt: sprayStartedAt, endedAt: Date.now(), endedBy, roundId, transmitTs: ts, durationMs: durMs }) + "\n";
            try { await appendFile('out/worker-sessions.ndjson', line); } catch {}
          }
          sprayActive = false; sprayReason = undefined; sprayStartedAt = undefined; sessionRound = null;
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
  let pendingAdvanceRound: bigint | null = null;
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
    const prio = parseGwei(String(prioGwei));
    // cap maxFee to base * 2 + prio (simple cushion)
    const maxFee = base > 0n ? base * 2n + prio : prio * 2n;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio };
  }

  // 喷射频率：默认 200ms，可用 WORKER_SPRAY_CADENCE_MS 覆盖
  const WORKER_SPRAY_CADENCE_MS = Math.max(50, Number(process.env.WORKER_SPRAY_CADENCE_MS ?? '200'));
  const forceBypass = true;
  console.log(`⚙️ 配置 simulate=${doSimulate} rawSend=always cadenceMs=${WORKER_SPRAY_CADENCE_MS}`);

  // 每个执行器维护一个简单的互斥 + 本地 nextNonce，避免并发/竞态使用相同 nonce
  const execState: Map<string, { inFlight: boolean; nextNonce?: bigint }> = new Map();
  for (const ex of executors) execState.set(ex.label, { inFlight: false });
  // 启动时预取 pending nonce
  try {
    await Promise.all(executors.map(async (ex) => {
      try {
        const from = ex.wc.account!.address as Address;
        const n = await (publicClient as any).getTransactionCount({ address: from, blockTag: 'pending' });
        const st = execState.get(ex.label)!; st.nextNonce = BigInt(n);
        if (process.env.WORKER_VERBOSE === '1') console.log(`🔢 init nonce ${ex.label} pending=${String(n)}`);
      } catch {}
    }));
  } catch {}

  async function sendWithNonce(exec: { wc: ReturnType<typeof createWalletClient>; label: string }, to: Address, data: `0x${string}`, gas: bigint, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
    const st = execState.get(exec.label)!;
    if (st.inFlight) {
      if (process.env.WORKER_VERBOSE === '1') console.log(`⏸️ skip send (inFlight) ${exec.label}`);
      return null;
    }
    st.inFlight = true;
    try {
      sim.rawAttempts++;
      const from = exec.wc.account!.address as Address;
      // 采用本地 nextNonce，缺失时同步 pending
      let nonce = execState.get(exec.label)!.nextNonce;
      if (nonce === undefined) {
        const n = await (publicClient as any).getTransactionCount({ address: from, blockTag: 'pending' });
        nonce = BigInt(n);
      }
      try {
        const txHash = await exec.wc.sendTransaction({ to, data, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, nonce });
        // 成功后自增本地 nextNonce
        execState.get(exec.label)!.nextNonce = (nonce as bigint) + 1n;
        return txHash;
      } catch (err: any) {
        const msg = (err?.shortMessage ?? err?.message ?? '').toString().toLowerCase();
        if (msg.includes('nonce') && (msg.includes('low') || msg.includes('too low') || msg.includes('high'))) {
          // 重新同步 pending nonce 后重试一次
          sim.nonceErrors++;
          const freshN = await (publicClient as any).getTransactionCount({ address: from, blockTag: 'pending' });
          const fresh = BigInt(freshN);
          execState.get(exec.label)!.nextNonce = fresh;
          try {
            const txHash = await exec.wc.sendTransaction({ to, data, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, nonce: fresh });
            execState.get(exec.label)!.nextNonce = fresh + 1n;
            return txHash;
          } catch (e) {
            throw e;
          }
        }
        throw err;
      }
    } finally {
      st.inFlight = false;
    }
  }
  let tickInFlight = false;
  async function doSprayTick() {
    if (!sprayActive) return;
    if (tickInFlight) return; // avoid overlapping ticks
    tickInFlight = true;

    const prevRoundId = await getPrevOrCurrentRoundId();
    // Preflight: read current aggregator round & last stored to avoid duplicate bursts.
    try {
      const [curr, stored] = await Promise.all([
        (async () => {
          const rd = (await readContract(publicClient as any, { address: FEED_PROXY, abi: AGGREGATOR_V2V3_ABI, functionName: 'latestRoundData' })) as [bigint, bigint, bigint, bigint, bigint];
          return BigInt(rd[0]);
        })(),
        (async () => {
          const v = (await readContract(publicClient as any, { address: flashLiquidator, abi: FLASH_LIQUIDATOR_ABI as any, functionName: 'lastRoundIdStored' })) as bigint;
          return BigInt(v);
        })(),
      ]);
      // Do not stop spray based on preflight; only throttle duplicates within the same round.
      // If we already sent for this curr round, do not spam more until storage catches up
      if (pendingAdvanceRound !== null && pendingAdvanceRound === curr) {
        // schedule a quick recheck and return
        setTimeout(() => { if (sprayActive) doSprayTick().catch(() => {}); }, Math.max(50, Math.floor(WORKER_SPRAY_CADENCE_MS / 2)));
        tickInFlight = false; return;
      }
    } catch {}

    const batch = pickBatch();
    if (batch.length === 0) return;
    // 评估 Top-N，选择评分最高的 up to executors 个
    const candScores: { user: Address; score: number }[] = [];
    for (const u of batch) {
      const r = await assessCandidate(u, { loanDec: diag.loanDec, collDec: diag.collDec, aggDec: diag.aggDec, lltv: BigInt(diag.lltv), totalBorrowAssets: BigInt(diag.totalBorrowAssets), totalBorrowShares: BigInt(diag.totalBorrowShares) });
      candScores.push({ user: u, score: r.score });
    }
    candScores.sort((a, b) => (b.score > a.score ? 1 : b.score < a.score ? -1 : 0));
    const bestScore = candScores.length ? candScores[0]!.score : -1;
    const chosen: Address[] = candScores.slice(0, Math.min(executors.length, candScores.length)).map(x => x.user);
    const targets: Address[] = [];
    for (const u of chosen) {
      try {
        const shares = await fetchBorrowShares(u);
        if (process.env.WORKER_SKIP_SHARES_FILTER === '1' || shares > 0n) targets.push(u);
      } catch {}
      if (targets.length >= executors.length) break;
    }
    if (targets.length === 0) {
      if (process.env.WORKER_VERBOSE === '1') console.log('ℹ️ 本次无可尝试目标（TopN/借款份额过滤后为空）');
      // still allow dynamic cadence scheduling to re-check quickly if risk is very high
      scheduleDynamicTick(bestScore);
      tickInFlight = false;
      return;
    }

    await Promise.all(
      targets.slice(0, executors.length).map(async (borrower, idx) => {
        const exec = executors[idx]!;
        try {
          // 始终直发（不模拟）
          let hash: `0x${string}`;
          const data = encodeFunctionData({
            abi: FLASH_LIQUIDATOR_ABI,
            functionName: 'flashLiquidate',
            // prevRoundId 设为 0，完全依赖合约内 lastRoundIdStored 门控
            args: [borrower, REQUESTED_REPAY_USDC, 0n, minProfitDefault],
          });
          const gasLimit = BigInt(process.env.WORKER_GAS_LIMIT ?? "900000");
          const fees = await currentFees(sprayStartedAt);
          sim.bypassSent++;
          try {
            const out = await sendWithNonce(exec, flashLiquidator, data as any, gasLimit, fees);
            if (!out) return;
            hash = out as `0x${string}`;
            // Mark that we have fired for the current round; prevents duplicate bursts until storage updates
            try {
              const rd = (await readContract(publicClient as any, { address: FEED_PROXY, abi: AGGREGATOR_V2V3_ABI, functionName: 'latestRoundData' })) as [bigint, bigint, bigint, bigint, bigint];
              pendingAdvanceRound = BigInt(rd[0]);
            } catch {}
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
            // If our tx observed OracleAdvanced, end spray immediately (we won the gate)
            try {
              if (rc && Array.isArray(rc.logs)) {
                for (const lg of rc.logs as any[]) {
                  try {
                    const ev = decodeEventLog({ abi: LIQ_EVENTS_ABI as any, data: lg.data as `0x${string}`, topics: lg.topics as any });
                    if ((ev as any)?.eventName === 'OracleAdvanced') {
                      const curr = BigInt((ev as any)?.args?.curr ?? 0n);
                      // Only stop when we observed a newer round than session start
                      if (sessionRound !== null && curr > sessionRound) {
                        if (sprayActive) {
                          sprayActive = false; sprayReason = undefined; sprayStartedAt = undefined; sessionRound = null;
                          console.log(`🛑 退出喷射模式 reason=oracle-advanced tx=${hash} curr=${curr}`);
                        }
                      }
                      break;
                    }
                  } catch {}
                }
              }
            } catch {}
            if (rc?.status && String(rc.status) !== 'success') {
              // Best-effort revert reason: re-call at the same block
              let reason: string | undefined;
              let sel: string | undefined;
              try {
                const tx = await (publicClient as any).getTransaction({ hash });
                // This call is expected to revert and throw
                await (publicClient as any).call({ to: tx.to, data: tx.input, from: tx.from, value: tx.value, gas: tx.gas, blockNumber: rc.blockNumber });
              } catch (err: any) {
                const raw = (err?.data as string | undefined) || (err?.cause?.data as string | undefined) || (err?.error?.data as string | undefined);
                const dec = decodeErrorData(raw);
                reason = dec.message || (err?.shortMessage as string | undefined) || (err?.message as string | undefined);
                sel = dec.selector;
              }
              const line = JSON.stringify({
                kind: 'onchainFail', chainId: MARKET.chainId, borrower,
                tx: hash, blockNumber: rc.blockNumber?.toString?.(),
                gasUsed: rc.gasUsed?.toString?.(), reason, selector: sel,
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
    // schedule an extra quick tick if risk is high
    scheduleDynamicTick(bestScore);
    tickInFlight = false;
  }

  // 定时喷射（仅在喷射期 active 时发送）
  setInterval(() => { if (sprayActive) doSprayTick().catch(() => {}); }, WORKER_SPRAY_CADENCE_MS);

  // 动态喷射频率：根据最佳风险分数在当前会话内附加更快的 tick
  const SPRAY_FAST_MS = Math.max(30, Number(process.env.WORKER_SPRAY_FAST_MS ?? '150'));
  const SPRAY_SUPER_MS = Math.max(20, Number(process.env.WORKER_SPRAY_SUPER_MS ?? '75'));
  const THR_FAST = Math.max(0, Math.min(1, Number(process.env.WORKER_SPRAY_THR_FAST ?? '0.20')));
  const THR_SUPER = Math.max(0, Math.min(1, Number(process.env.WORKER_SPRAY_THR_SUPER ?? '0.50')));
  let lastDynamicAt = 0;
  let lastBestScore = -1;
  let dynamicTicks = 0;
  function scheduleDynamicTick(bestScore: number) {
    if (!sprayActive) return;
    lastBestScore = bestScore;
    const now = Date.now();
    // Small guard to avoid too dense scheduling
    const minGap = Math.min(SPRAY_FAST_MS, SPRAY_SUPER_MS) / 2;
    if (now - lastDynamicAt < minGap) return;
    let delay = 0;
    if (bestScore >= THR_SUPER) delay = SPRAY_SUPER_MS;
    else if (bestScore >= THR_FAST) delay = SPRAY_FAST_MS;
    else return;
    lastDynamicAt = now;
    dynamicTicks++;
    setTimeout(() => { if (sprayActive) doSprayTick().catch(() => {}); }, delay);
  }

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
            nonceErrors: sim.nonceErrors,
            sent: sim.bypassSent,
            cadenceMs: WORKER_SPRAY_CADENCE_MS,
            dynamic: {
              fastMs: SPRAY_FAST_MS,
              superMs: SPRAY_SUPER_MS,
              thrFast: THR_FAST,
              thrSuper: THR_SUPER,
              lastBestScore,
              dynamicTicks,
            },
            // optional: lastTargets can be undefined if not computed in this scope
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
