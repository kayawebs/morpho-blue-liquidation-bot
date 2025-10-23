import { chainConfig, chainConfigs } from "../config/dist/index.js";
import { base } from "viem/chains";
import { createPublicClient, createWalletClient, http, webSocket, type Address, maxUint256, encodeFunctionData } from "viem";
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
import { LiquidationEncoder } from "../client/src/utils/LiquidationEncoder.js";
import { WAD, wMulDown } from "../client/src/utils/maths.js";

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
  // 预测型改用 GuardedLiquidator 合约执行（不使用旧 executor）
  function parseList(key: string): string[] | undefined {
    const v = process.env[key];
    if (!v) return undefined;
    const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  const multiGuardAddrs = parseList(`GUARD_ADDRESSES_${MARKET.chainId}`) ?? parseList(`EXECUTOR_ADDRESSES_${MARKET.chainId}`);
  const multiPrivKeys = parseList(`LIQUIDATION_PRIVATE_KEYS_${MARKET.chainId}`);
  const guardPairs: { addr: Address; wc: any }[] = [];
  if (multiGuardAddrs && multiPrivKeys && multiGuardAddrs.length === multiPrivKeys.length) {
    for (let i = 0; i < multiGuardAddrs.length; i++) {
      const wc = createWalletClient({ chain: base, transport: http(cfg.rpcUrl), account: privateKeyToAccount(multiPrivKeys[i]! as any) });
      guardPairs.push({ addr: multiGuardAddrs[i]! as Address, wc });
    }
    console.log(`🔱 多Guard执行器配置: ${guardPairs.length} 个`);
  } else {
    console.warn("⚠️ 未配置 GUARD_ADDRESSES/LIQUIDATION_PRIVATE_KEYS，预测型将使用单一执行私钥但无法发送（建议配置）");
    guardPairs.push({ addr: cfg.executorAddress as Address, wc: walletClient as any });
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
    // 预筛选候选并按可清算规模降序，最多 guardPairs.length 个并行
    const viable: { user: Address; seizable: bigint; p: any }[] = [];
    for (const user of batch) {
      try {
        const p = await readContract(publicClient as any, { address: MARKET.morphoAddress, abi: morphoBlueAbi, functionName: "position", args: [MARKET.marketId, user] });
        if ((p as any).borrowShares === 0n) continue;
        const iposition = { chainId: MARKET.chainId, marketId: MARKET.marketId as any, user, supplyShares: (p as any).supplyShares, borrowShares: (p as any).borrowShares, collateral: (p as any).collateral } as any;
        const { AccrualPosition } = await import("@morpho-org/blue-sdk");
        const seizable = new AccrualPosition(iposition, marketObj).seizableCollateral ?? 0n;
        if (seizable > 0n) viable.push({ user, seizable, p });
      } catch {}
      if (viable.length >= guardPairs.length) break;
    }
    viable.sort((a, b) => (a.seizable === b.seizable ? 0 : a.seizable > b.seizable ? -1 : 1));
    const selected = viable.slice(0, guardPairs.length);

    // 每个 Guard 合约派发一个目标
    const results = await Promise.all(selected.map(async (v, idx) => {
      try {
        // 构建 calls（以 Guard 地址作为 encoder.address）
        const guard = guardPairs[idx]!;
        const encoder = new LiquidationEncoder(guard.addr, guard.wc);
        // seizable 缓冲
        const bufBps = chainConfigs[MARKET.chainId]?.options.liquidationBufferBps ?? 10;
        const decr = (s: bigint, col: bigint) => s === col ? s : wMulDown(s, WAD - BigInt(bufBps) * (WAD / 10_000n));
        const seizableAdj = decr(v.seizable, (v.p as any).collateral ?? 0n);
        // 转换 + 清算
        let toConvert = { src: (params as any).collateralToken as Address, dst: (params as any).loanToken as Address, srcAmount: seizableAdj };
        if (await uniswapV3Venue.supportsRoute(encoder as any, toConvert.src, toConvert.dst)) {
          toConvert = await uniswapV3Venue.convert(encoder as any, toConvert);
        }
        encoder.erc20Approve((params as any).loanToken, MARKET.morphoAddress, maxUint256);
        encoder.morphoBlueLiquidate(
          MARKET.morphoAddress,
          { ...params, lltv: BigInt((params as any).lltv) },
          v.user,
          seizableAdj,
          0n,
          encoder.flush(),
        );
        const calls = encoder.flush();

        // 构造门控参数（prevRoundId, priceHint 等）
        const round: any = await (publicClient as any).readContract({ address: MARKET.aggregator, abi: AGGREGATOR_V2V3_ABI, functionName: 'latestRoundData' });
        const prevRoundId = Number(round[0]);
        const { decimals } = getAdapter(MARKET.chainId, MARKET.aggregator);
        const priceHint = BigInt(Math.round(Number(pred.answer ?? 0) * 10 ** decimals));
        const maxDevBps = offsetBps;
        const maxAgeSec = 120; // 可调：也可从 env 读取
        const profitToken = (params as any).loanToken as Address; // USDC
        const minProfit = 100_000n; // 0.1 USDC（6 decimals）
        const deadline = BigInt(now + 60);

        // simulate + 发送
        const { simulateCalls, writeContract, getGasPrice } = await import("viem/actions");
        const [{ results }, gasPrice] = await Promise.all([
          simulateCalls(guard.wc, {
            account: guard.wc.account.address,
            calls: [
              { to: profitToken, abi: (await import('viem')).erc20Abi, functionName: 'balanceOf', args: [guard.addr] },
              { to: guard.addr, data: encodeFunctionData({ abi: [
                { inputs: [ { type: 'bytes[]', name: 'data' }, { type: 'uint256', name: 'priceHint' }, { type: 'uint16', name: 'maxDevBps' }, { type: 'uint32', name: 'maxAgeSec' }, { type: 'uint80', name: 'prevRoundId' }, { type: 'address', name: 'profitToken' }, { type: 'uint256', name: 'minProfit' }, { type: 'uint256', name: 'deadline' } ], name: 'execEncoded', outputs: [], stateMutability: 'payable', type: 'function' }
              ], functionName: 'execEncoded', args: [calls, priceHint, maxDevBps, maxAgeSec, BigInt(prevRoundId), profitToken, minProfit, deadline] }) },
              { to: profitToken, abi: (await import('viem')).erc20Abi, functionName: 'balanceOf', args: [guard.addr] },
            ],
          }),
          getGasPrice(guard.wc),
        ]);
        if (results[1].status !== 'success') return false;
        // 发送 tx
        await writeContract(guard.wc, { address: guard.addr, abi: [
          { inputs: [ { type: 'bytes[]', name: 'data' }, { type: 'uint256', name: 'priceHint' }, { type: 'uint16', name: 'maxDevBps' }, { type: 'uint32', name: 'maxAgeSec' }, { type: 'uint80', name: 'prevRoundId' }, { type: 'address', name: 'profitToken' }, { type: 'uint256', name: 'minProfit' }, { type: 'uint256', name: 'deadline' } ], name: 'execEncoded', outputs: [], stateMutability: 'payable', type: 'function' }
        ] as any, functionName: 'execEncoded', args: [calls, priceHint, maxDevBps, maxAgeSec, BigInt(prevRoundId), profitToken, minProfit, deadline] });
        return true;
      } catch (e) {
        console.warn('guard attempt error', e);
        return false;
      }
    }));
    const attempts = selected.length;
    const successes = results.filter(Boolean).length;
    if (attempts > 0) console.log(`⚡ [Predictive] window触发(${win.state ?? 'n/a'}): attempts=${attempts}, successes=${successes}`);
  }, 1000);

  await fetchCandidates();
  setInterval(fetchCandidates, CANDIDATE_REFRESH_MS);
  console.log("✅ 预测型策略已启动（等待 scheduler 推送窗口）");
}

main().catch((e) => { console.error(e); process.exit(1); });
