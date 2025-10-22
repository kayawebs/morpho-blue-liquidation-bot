import { chainConfig } from "../config/dist/index.js";
import { base } from "viem/chains";
import { createPublicClient, createWalletClient, http, webSocket, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";
import { readContract } from "viem/actions";

import { LiquidationBot } from "../client/src/bot.js";
import { UniswapV3Venue } from "../client/src/liquidityVenues/uniswapV3/index.js";
import { BaseChainlinkPricer } from "../client/src/pricers/baseChainlink/index.js";
import { morphoBlueAbi } from "../ponder/abis/MorphoBlue.js";
import { getAdapter } from "./oracleAdapters/registry.js";
import { fetchPredictedAt } from "./utils/predictorClient.js";
import { fetchOracleConfig } from "./utils/predictorConfigClient.js";
import { AGGREGATOR_V2V3_ABI } from "./utils/chainlinkAbi.js";

// 预测型策略：由 oracle-scheduler 的 WS 推送驱动，
// 在偏差/心跳窗口内用预测价快速评估清算并发起交易（适合大额）。

const MARKET = {
  chainId: base.id,
  marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" as const,
  morphoAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address,
  aggregator: "0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8" as Address,
};

type Win = { start: number; end: number; state?: string; deltaBps?: number };
type Sched = { heartbeat?: Win; deviation?: Win };

async function main() {
  const cfg = chainConfig(MARKET.chainId);
  const publicClient = createPublicClient({ chain: base, transport: cfg.wsRpcUrl ? webSocket(cfg.wsRpcUrl) : http(cfg.rpcUrl) });
  const walletClient = createWalletClient({ chain: base, transport: http(cfg.rpcUrl), account: privateKeyToAccount(cfg.liquidationPrivateKey) });

  console.log("🚀 启动预测型 Worker: Base cbBTC/USDC (WS 驱动)");

  const basePricer = new BaseChainlinkPricer();
  const uniswapV3Venue = new UniswapV3Venue();
  const liquidator = new LiquidationBot({
    logTag: "⚡ predictive ",
    chainId: MARKET.chainId,
    client: walletClient as any,
    morphoAddress: MARKET.morphoAddress,
    wNative: cfg.wNative,
    vaultWhitelist: [],
    additionalMarketsWhitelist: [MARKET.marketId],
    executorAddress: cfg.executorAddress,
    liquidityVenues: [uniswapV3Venue],
    pricers: [basePricer],
  });

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

  async function getMarketParams() {
    return readContract(publicClient as any, {
      address: MARKET.morphoAddress,
      abi: morphoBlueAbi,
      functionName: "idToMarketParams",
      args: [MARKET.marketId],
    });
  }

  async function getMarketView() {
    return (await readContract(publicClient as any, {
      address: MARKET.morphoAddress,
      abi: morphoBlueAbi,
      functionName: "market",
      args: [MARKET.marketId],
    })) as {
      totalSupplyAssets: bigint;
      totalSupplyShares: bigint;
      totalBorrowAssets: bigint;
      totalBorrowShares: bigint;
      lastUpdate: bigint;
      fee: bigint;
    };
  }

  // 与 predictor 同步阈值/lag
  const { feedAddr } = getAdapter(MARKET.chainId, MARKET.aggregator);
  let offsetBps = 10; // fallback
  let heartbeatSeconds = 1200; // fallback
  let lagSeconds = 3; // fallback
  async function refreshThresholds() {
    const th = await fetchOracleConfig("http://localhost:48080", MARKET.chainId, feedAddr);
    if (th) { offsetBps = th.offsetBps; heartbeatSeconds = th.heartbeatSeconds; if (typeof th.lagSeconds === 'number') lagSeconds = th.lagSeconds; }
  }
  await refreshThresholds();
  setInterval(refreshThresholds, 60_000);

  // 接收 scheduler 推送
  const wsUrl = `ws://localhost:48201/ws/schedule?chainId=${MARKET.chainId}&oracle=${MARKET.aggregator}`;
  let latest: Sched | undefined;
  const ws = new WebSocket(wsUrl);
  ws.on("open", () => console.log(`📡 已连接 oracle-scheduler: ${wsUrl}`));
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg?.data) latest = msg.data as Sched;
    } catch {}
  });
  ws.on("close", () => console.log("⚠️ scheduler WS 断开，等待重连(由系统自动)"));
  ws.on("error", () => {});

  // 主循环：在窗口内用预测价进行评估与清算
  setInterval(async () => {
    if (!latest) return;
    const now = Math.floor(Date.now() / 1000);
    const win = latest.deviation ?? latest.heartbeat;
    if (!win) return;
    // 提前量：在 prewarm 阶段也尝试（适度保守，避免 spam）
    const active = now >= (win.start ?? 0) - 1 && now <= (win.end ?? 0);
    if (!active) return;

    // 获取预测价（以 updatedAt-lag 对齐）；若无 updatedAt 则用当前时间
    let updatedAt = now;
    try {
      const round: any = await (publicClient as any).readContract({ address: MARKET.aggregator, abi: [{...AGGREGATOR_V2V3_ABI[0]} as any], functionName: 'latestRoundData' });
      updatedAt = Number(round[3]) || now;
    } catch {}
    const pred = await fetchPredictedAt("http://localhost:48080", MARKET.chainId, feedAddr, updatedAt, lagSeconds);
    if (!pred?.price1e36) return;

    const [params, view] = await Promise.all([getMarketParams(), getMarketView()]);
    const marketObj = new (await import("@morpho-org/blue-sdk")).Market({
      chainId: MARKET.chainId,
      id: MARKET.marketId as any,
      params: new (await import("@morpho-org/blue-sdk")).MarketParams(params as any),
      price: pred.price1e36 as any,
      totalSupplyAssets: view.totalSupplyAssets,
      totalSupplyShares: view.totalSupplyShares,
      totalBorrowAssets: view.totalBorrowAssets,
      totalBorrowShares: view.totalBorrowShares,
      lastUpdate: view.lastUpdate,
      fee: view.fee,
    }).accrueInterest(String(now));

    const batch = pickBatch();
    let attempts = 0; let successes = 0;
    for (const user of batch) {
      try {
        const p = await readContract(publicClient as any, { address: MARKET.morphoAddress, abi: morphoBlueAbi, functionName: "position", args: [MARKET.marketId, user] });
        if ((p as any).borrowShares === 0n) continue;
        const iposition = { chainId: MARKET.chainId, marketId: MARKET.marketId as any, user, supplyShares: (p as any).supplyShares, borrowShares: (p as any).borrowShares, collateral: (p as any).collateral } as any;
        const { AccrualPosition } = await import("@morpho-org/blue-sdk");
        const seizable = new AccrualPosition(iposition, marketObj).seizableCollateral ?? 0n;
        if (seizable > 0n) {
          attempts++;
          const ok = await liquidator.liquidateSingle(marketObj, { ...iposition, seizableCollateral: seizable } as any);
          if (ok) successes++;
        }
      } catch {}
    }
    if (attempts > 0) {
      console.log(`⚡ [Predictive] window触发(${win.state ?? 'n/a'}): attempts=${attempts}, successes=${successes}`);
    }
  }, 1000);

  await fetchCandidates();
  setInterval(fetchCandidates, CANDIDATE_REFRESH_MS);
  console.log("✅ 预测型策略已启动（等待 scheduler 推送窗口）");
}

main().catch((e) => { console.error(e); process.exit(1); });
