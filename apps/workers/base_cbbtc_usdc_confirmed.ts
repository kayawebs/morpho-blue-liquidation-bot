import { chainConfig } from "../config/dist/index.js";
import { base } from "viem/chains";
import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  type Address,
  getAbiItem,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readContract } from "viem/actions";

import { LiquidationBot } from "../client/src/bot.js";
import type { IndexerAPIResponse, PreLiquidatablePosition } from "../client/src/utils/types.js";
import { UniswapV3Venue } from "../client/src/liquidityVenues/uniswapV3/index.js";
import { BaseChainlinkPricer } from "../client/src/pricers/baseChainlink/index.js";
import { morphoBlueAbi } from "../ponder/abis/MorphoBlue.js";
import { AGGREGATOR_V2V3_ABI } from "./utils/chainlinkAbi.js";
import { getAdapter } from "./oracleAdapters/registry.js";

// 确认型策略：仅在链上预言机发生已确认的 NewTransmission 事件后，
// 读取最新价格并精准评估清算，牺牲实时性，适合吃小额单。

const MARKET = {
  chainId: base.id,
  marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" as const,
  morphoAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address,
  // Default aggregator address; can be overridden by env AGGREGATOR_ADDRESS_<chainId>
  aggregator: (process.env[`AGGREGATOR_ADDRESS_${base.id}`] as Address) ?? ("0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8" as Address),
};

// OCR2 NewTransmission 事件（最小 ABI）
const OCR2_NEW_TRANSMISSION = [
  {
    type: "event",
    name: "NewTransmission",
    inputs: [
      { indexed: true, name: "aggregatorRoundId", type: "uint32" },
      { indexed: false, name: "answer", type: "int192" },
      { indexed: false, name: "transmitter", type: "address" },
      { indexed: false, name: "observations", type: "int192[]" },
      { indexed: false, name: "observers", type: "bytes" },
      { indexed: false, name: "rawReportContext", type: "bytes32" },
    ],
  },
 ] as const;

async function main() {
  const cfg = chainConfig(MARKET.chainId);

  const publicClient = createPublicClient({
    chain: base,
    transport: cfg.wsRpcUrl ? webSocket(cfg.wsRpcUrl) : http(cfg.rpcUrl),
  });
  // 读取多执行器配置（逗号分隔），否则回退为单执行器
  function parseList(key: string): string[] | undefined {
    const v = process.env[key];
    if (!v) return undefined;
    const arr = v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return arr.length > 0 ? arr : undefined;
  }
  const multiExecAddrs = parseList(`EXECUTOR_ADDRESSES_${MARKET.chainId}`);
  const multiExecPKs = parseList(`LIQUIDATION_PRIVATE_KEYS_${MARKET.chainId}`);
  const execPairs: { executor: Address; pk: `0x${string}` }[] = [];
  if (multiExecAddrs && multiExecPKs && multiExecAddrs.length === multiExecPKs.length) {
    for (let i = 0; i < multiExecAddrs.length; i++) {
      execPairs.push({ executor: multiExecAddrs[i] as Address, pk: multiExecPKs[i] as `0x${string}` });
    }
    console.log(`🔱 多执行器配置已加载: ${execPairs.length} 个`);
  } else {
    execPairs.push({ executor: cfg.executorAddress, pk: cfg.liquidationPrivateKey as any });
    if (multiExecAddrs || multiExecPKs) {
      console.warn("⚠️ 多执行器配置不完整或长度不匹配，已回退为单执行器");
    }
  }
  const walletClients = execPairs.map((p) =>
    createWalletClient({ chain: base, transport: http(cfg.rpcUrl), account: privateKeyToAccount(p.pk) }),
  );

  console.log("🚀 启动确认型 Worker: Base cbBTC/USDC");
  console.log(`🔗 Aggregator: ${MARKET.aggregator}`);

  // 执行器与定价/流动性组件（沿用现有实现）
  const basePricer = new BaseChainlinkPricer();
  const uniswapV3Venue = new UniswapV3Venue();
  const liquidators = walletClients.map((wc, idx) =>
    new LiquidationBot({
      logTag: `✅ confirmed#${idx} `,
      chainId: MARKET.chainId,
      client: wc as any,
      morphoAddress: MARKET.morphoAddress,
      wNative: cfg.wNative,
      vaultWhitelist: [],
      additionalMarketsWhitelist: [MARKET.marketId],
      executorAddress: execPairs[idx]!.executor,
      liquidityVenues: [uniswapV3Venue],
      pricers: [basePricer],
    }),
  );

  // 账户候选集（默认从 Ponder API 获取；若不可用则回退为链上日志）
  const PONDER_API_URL = "http://localhost:42069";
  const CANDIDATE_REFRESH_MS = 60_000;
  const CANDIDATE_BATCH = 50;
  const CANDIDATE_SOURCE = "ponder";
  const candidateSet = new Set<string>();
  let candidates: Address[] = [];
  let nextIdx = 0;

  function nowIso() {
    return new Date().toISOString();
  }

  async function fetchCandidates(): Promise<void> {
    try {
      if (CANDIDATE_SOURCE === "ponder") {
        const res = await fetch(new URL(`/chain/${MARKET.chainId}/candidates`, PONDER_API_URL), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ marketIds: [MARKET.marketId] }),
        });
        if (res.ok) {
          const data = (await res.json()) as Record<string, Address[]>;
          for (const a of data[MARKET.marketId] ?? []) candidateSet.add(a.toLowerCase());
        } else {
          await hydrateCandidatesFromLogs();
        }
      } else {
        await hydrateCandidatesFromLogs();
      }
      candidates = [...candidateSet] as Address[];
      console.log(`👥 Candidates loaded: ${candidates.length} @ ${nowIso()}`);
    } catch (e) {
      console.warn("⚠️ candidates fetch error:", e);
    }
  }

  async function hydrateCandidatesFromLogs() {
    const head = await publicClient.getBlockNumber();
    const fromBlock = head > 10_000n ? head - 10_000n : 0n;
    const borrowEvent = getAbiItem({ abi: morphoBlueAbi, name: "Borrow" }) as any;
    const supplyColEvent = getAbiItem({ abi: morphoBlueAbi, name: "SupplyCollateral" }) as any;
    const step = 2_000n;
    for (let start = fromBlock; start <= head; start += step) {
      const end = start + step - 1n > head ? head : start + step - 1n;
      try {
        const [borrows, supplies] = await Promise.all([
          publicClient.getLogs({
            address: MARKET.morphoAddress,
            event: borrowEvent,
            args: { id: MARKET.marketId as any },
            fromBlock: start,
            toBlock: end,
          } as any),
          publicClient.getLogs({
            address: MARKET.morphoAddress,
            event: supplyColEvent,
            args: { id: MARKET.marketId as any },
            fromBlock: start,
            toBlock: end,
          } as any),
        ]);
        for (const log of borrows as any[]) candidateSet.add((log.args.onBehalf as string).toLowerCase());
        for (const log of supplies as any[]) candidateSet.add((log.args.onBehalf as string).toLowerCase());
      } catch {}
    }
  }

  function pickBatch(): Address[] {
    if (candidates.length === 0) return [];
    const out: Address[] = [];
    for (let i = 0; i < CANDIDATE_BATCH && i < candidates.length; i++) {
      out.push(candidates[(nextIdx + i) % candidates.length]!);
    }
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
    const res: any = await readContract(publicClient as any, {
      address: MARKET.morphoAddress,
      abi: morphoBlueAbi,
      functionName: "market",
      args: [MARKET.marketId],
    });
    if (Array.isArray(res)) {
      return {
        totalSupplyAssets: res[0] as bigint,
        totalSupplyShares: res[1] as bigint,
        totalBorrowAssets: res[2] as bigint,
        totalBorrowShares: res[3] as bigint,
        lastUpdate: res[4] as bigint,
        fee: res[5] as bigint,
      } as {
        totalSupplyAssets: bigint;
        totalSupplyShares: bigint;
        totalBorrowAssets: bigint;
        totalBorrowShares: bigint;
        lastUpdate: bigint;
        fee: bigint;
      };
    }
    return res as {
      totalSupplyAssets: bigint;
      totalSupplyShares: bigint;
      totalBorrowAssets: bigint;
      totalBorrowShares: bigint;
      lastUpdate: bigint;
      fee: bigint;
    };
  }

  async function getUserPosition(user: Address) {
    return (await readContract(publicClient as any, {
      address: MARKET.morphoAddress,
      abi: morphoBlueAbi,
      functionName: "position",
      args: [MARKET.marketId, user],
    })) as { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
  }

  // 事件确认与处理队列
  type QItem = { blockNumber: bigint; txIndex: number; logIndex: number; txHash?: string; blockHash?: string };
  const queue: QItem[] = [];
  const seen = new Set<string>();
  const CONFIRMATIONS = 1; // 固定为1，不提供配置
  let head: bigint = 0n;
  let eventsReceived = 0;
  let eventsProcessed = 0;
  let attemptsTotal = 0;
  let successesTotal = 0;
  type AuditEvent = {
    ts: string;
    status: 'queued' | 'processed' | 'error';
    block?: string;
    tx?: string;
    roundId?: string;
    answerRaw?: string;
    attempts?: number;
    successes?: number;
    phase?: string;
    error?: string;
  };
  const audits: AuditEvent[] = [];
  const auditIdxByTx = new Map<string, number>();
  function pushAudit(a: AuditEvent) {
    if (a.tx) {
      const idx = auditIdxByTx.get(a.tx);
      if (idx !== undefined) {
        audits[idx] = { ...audits[idx]!, ...a };
        return;
      }
    }
    if (audits.length >= 20) audits.shift();
    audits.push(a);
    if (a.tx) auditIdxByTx.set(a.tx, audits.length - 1);
  }

  const VERBOSE = process.env.WORKER_VERBOSE === '1';

  // 订阅 OCR2 NewTransmission（确认后处理）
  const evt = getAbiItem({ abi: OCR2_NEW_TRANSMISSION as any, name: "NewTransmission" }) as any;
  publicClient.watchEvent({
    address: MARKET.aggregator,
    event: evt,
    onLogs: (logs: any[]) => {
      for (const l of logs) {
        const key = `${l.blockNumber}:${l.transactionIndex}:${l.logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({
          blockNumber: l.blockNumber as bigint,
          txIndex: Number(l.transactionIndex ?? 0),
          logIndex: Number(l.logIndex ?? 0),
          txHash: l.transactionHash as string | undefined,
          blockHash: l.blockHash as string | undefined,
        });
        eventsReceived++;
        if (VERBOSE) console.log(`🛰 onLogs queued key=${key} queue=${queue.length}`);
        // 记录审计：尽量带上 roundId/answer（从解码参数，若可用）
        try {
          const args: any = (l as any).args ?? {};
          pushAudit({
            ts: nowIso(),
            status: 'queued',
            block: (l.blockNumber as bigint)?.toString?.(),
            tx: l.transactionHash as string | undefined,
            roundId: (args?.aggregatorRoundId as any)?.toString?.() ?? String(args?.aggregatorRoundId ?? ''),
            answerRaw: (args?.answer as any)?.toString?.(),
          });
        } catch {}
      }
      // 稳定排序：按区块/交易/日志索引
      queue.sort((a, b) =>
        a.blockNumber === b.blockNumber
          ? a.txIndex === b.txIndex
            ? a.logIndex - b.logIndex
            : a.txIndex - b.txIndex
          : Number(a.blockNumber - b.blockNumber),
      );
    },
  } as any);

  // 使用 watchBlocks 在新区块到来时立即推进确认并处理队列（比轮询更快）
  async function processMatured() {
    const matured: QItem[] = [];
    while (queue.length > 0) {
      const it = queue[0]!;
      if (head === 0n || head - it.blockNumber < BigInt(CONFIRMATIONS)) break;
      matured.push(it); queue.shift();
    }
    if (VERBOSE && matured.length > 0) console.log(`🧮 matured=${matured.length} head=${head.toString()}`);
    // 同区块内按 txIndex/logIndex 顺序处理
    matured.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.txIndex === b.txIndex
          ? a.logIndex - b.logIndex
          : a.txIndex - b.txIndex
        : Number(a.blockNumber - b.blockNumber),
    );
    for (const it of matured) {
      await handleConfirmedTransmission(it);
      eventsProcessed++;
    }
  }
  publicClient.watchBlocks({
    emitMissed: true,
    includeTransactions: false,
    onBlock: async (blk: any) => {
      try {
        if (!blk || typeof blk.number === 'undefined') {
          const n = await publicClient.getBlockNumber();
          head = n;
        } else {
          head = blk.number as bigint;
        }
        await processMatured();
      } catch {}
    },
    onError: () => {},
  });

  // 兜底回扫机制已移除：仅依赖 WS 订阅与 head 推进处理

  async function handleConfirmedTransmission(item?: QItem) {
    let phase = 'init';
    let paramsDump: any = undefined;
    try {
      // 打印本次 transmit 的基本上下文（区块/交易/时间）
      if (item?.txHash) {
        try {
          const receipt = await (publicClient as any).getTransactionReceipt({ hash: item.txHash as `0x${string}` });
          const log = receipt?.logs?.find((l: any) => String(l.address).toLowerCase() === String(MARKET.aggregator).toLowerCase());
          let roundIdStr: string | undefined;
          let answerStr: string | undefined;
          if (log) {
            const OCR2_EVENT = getAbiItem({
              abi: [{ type: 'event', name: 'NewTransmission', inputs: [
                { indexed: true, name: 'aggregatorRoundId', type: 'uint32' },
                { indexed: false, name: 'answer', type: 'int192' },
                { indexed: false, name: 'transmitter', type: 'address' },
                { indexed: false, name: 'observations', type: 'int192[]' },
                { indexed: false, name: 'observers', type: 'bytes' },
                { indexed: false, name: 'rawReportContext', type: 'bytes32' },
              ]}], name: 'NewTransmission',
            }) as any;
            const dec = decodeEventLog({ abi: [OCR2_EVENT], data: log.data, topics: log.topics as any });
            const args: any = dec?.args ?? {};
            roundIdStr = (args?.aggregatorRoundId as any)?.toString?.() ?? String(args?.aggregatorRoundId);
            answerStr = (args?.answer as any)?.toString?.();
          }
          console.log(`🔔 [Confirmed] transmit detected @ ${nowIso()} block=${receipt?.blockNumber?.toString?.()} tx=${item.txHash} round=${roundIdStr ?? '-'} answerRaw=${answerStr ?? '-'}`);
          pushAudit({ ts: nowIso(), status: 'queued', block: receipt?.blockNumber?.toString?.(), tx: item.txHash, roundId: roundIdStr, answerRaw: answerStr });
        } catch {}
      }
      // 读取最新 on-chain 答案
      phase = 'readLatestRoundData';
      const round: any = await (publicClient as any).readContract({
        address: MARKET.aggregator,
        abi: AGGREGATOR_V2V3_ABI,
        functionName: 'latestRoundData',
      });
      const { decimals, scaleFactor } = getAdapter(MARKET.chainId, MARKET.aggregator);
      // 兼容 viem 返回形态：数组索引 & 具名返回值
      let answerRaw: bigint | undefined;
      if (round && typeof round === 'object') {
        if (typeof (round as any).answer === 'bigint') answerRaw = (round as any).answer as bigint;
        else if (Array.isArray(round) && typeof (round as any)[1] === 'bigint') answerRaw = (round as any)[1] as bigint;
      }
      if (typeof answerRaw !== 'bigint') {
        console.warn('⚠️ latestRoundData returned invalid answer', {
          aggregator: MARKET.aggregator,
          roundRaw: Array.isArray(round)
            ? (round as any[]).map((x: any) => (typeof x === 'bigint' ? x.toString() : x))
            : round,
        });
        return;
      }
      phase = 'computePrice';
      const price1e36 = scaleFactor * answerRaw;

      // 构造市场视图进行精确清算评估
      phase = 'fetchMarketState';
      const [params, view] = await Promise.all([getMarketParams(), getMarketView()]);
      if (!params || !view) {
        throw new Error('market state not available');
      }
      phase = 'buildMarketObj';
      // 兼容 viem 返回的 tuple 结果，显式映射到具名字段，并确保 lltv 为 bigint
      const mp = Array.isArray(params)
        ? {
            loanToken: (params as any)[0],
            collateralToken: (params as any)[1],
            oracle: (params as any)[2],
            irm: (params as any)[3],
            lltv: (params as any)[4],
          }
        : (params as any);
      const mp2 = {
        ...mp,
        lltv: typeof (mp as any).lltv === 'bigint' ? (mp as any).lltv : BigInt((mp as any).lltv),
      } as any;
      paramsDump = {
        loanToken: (mp2 as any)?.loanToken,
        collateralToken: (mp2 as any)?.collateralToken,
        oracle: (mp2 as any)?.oracle,
        irm: (mp2 as any)?.irm,
        lltv: (mp2 as any)?.lltv?.toString?.() ?? String((mp2 as any)?.lltv),
      };
      phase = 'newMarketParams';
      const MarketNS = await import("@morpho-org/blue-sdk");
      const marketParamsObj = new (MarketNS as any).MarketParams(mp2);
      phase = 'newMarket';
      const asBn = (v: any): bigint => {
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number') return BigInt(Math.trunc(v));
        if (typeof v === 'string') return BigInt(v);
        throw new Error('bad bigint input');
      };
      const priceBn = asBn(price1e36);
      const viewNorm = {
        totalSupplyAssets: asBn(view.totalSupplyAssets),
        totalSupplyShares: asBn(view.totalSupplyShares),
        totalBorrowAssets: asBn(view.totalBorrowAssets),
        totalBorrowShares: asBn(view.totalBorrowShares),
        lastUpdate: asBn(view.lastUpdate),
        fee: asBn(view.fee),
      };
      const marketObj = new (MarketNS as any).Market({
        chainId: MARKET.chainId,
        id: MARKET.marketId as any,
        params: marketParamsObj,
        price: priceBn,
        totalSupplyAssets: viewNorm.totalSupplyAssets,
        totalSupplyShares: viewNorm.totalSupplyShares,
        totalBorrowAssets: viewNorm.totalBorrowAssets,
        totalBorrowShares: viewNorm.totalBorrowShares,
        lastUpdate: viewNorm.lastUpdate,
        fee: viewNorm.fee,
      }).accrueInterest(Math.floor(Date.now() / 1000).toString());

      phase = 'pickBatch';
      const batch = pickBatch();
      // 预筛选出可清算仓位（并按可扣押资产从大到小排序），上限=执行器数量
      const viable: { user: Address; iposition: any; seizable: bigint }[] = [];
      phase = 'scanCandidates';
      for (const user of batch) {
        try {
          const p = await getUserPosition(user);
          if (p.borrowShares === 0n) continue;
          const iposition = {
            chainId: MARKET.chainId,
            marketId: MARKET.marketId as any,
            user,
            supplyShares: p.supplyShares,
            borrowShares: p.borrowShares,
            collateral: p.collateral,
          } as any;
          const { AccrualPosition } = await import("@morpho-org/blue-sdk");
          const seizable = new AccrualPosition(iposition, marketObj).seizableCollateral ?? 0n;
          if (seizable > 0n) viable.push({ user, iposition, seizable });
        } catch {}
        if (viable.length >= liquidators.length) break;
      }
      viable.sort((a, b) => (a.seizable === b.seizable ? 0 : a.seizable > b.seizable ? -1 : 1));
      const selected = viable.slice(0, liquidators.length);
      // 预清算机会：从 Ponder API 获取（如可用），以减轻本地重计算负担
      let preLiqSelected: PreLiquidatablePosition[] = [];
      try {
        const res = await fetch(new URL(`/chain/${MARKET.chainId}/liquidatable-positions`, PONDER_API_URL), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ marketIds: [MARKET.marketId] }),
        });
        if (res.ok) {
          const data = (await res.json()) as { warnings: string[]; results: IndexerAPIResponse[] };
          const entry = data.results?.find((r) => (r.market.id as any) === MARKET.marketId);
          if (entry && Array.isArray(entry.positionsPreLiq)) {
            // 选择前 N 个预清算（不与正常清算重复用户）
            const taken = new Set(selected.map((x) => x.iposition.user.toLowerCase()));
            const sorted = [...entry.positionsPreLiq].sort((a, b) => (a.seizableCollateral === b.seizableCollateral ? 0 : a.seizableCollateral > b.seizableCollateral ? -1 : 1));
            for (const p of sorted) {
              if (preLiqSelected.length >= liquidators.length) break;
              if (taken.has(p.user.toLowerCase())) continue;
              preLiqSelected.push(p);
            }
          }
        }
      } catch {}
      phase = 'executeLiquidations';
      // 先尝试预清算（若存在），然后再尝试常规清算
      const preLiqResults = await Promise.all(
        preLiqSelected.map((p, i) => liquidators[i]!.preLiquidateSingle(marketObj, p)),
      );
      const results = await Promise.all(
        selected.map((v, i) =>
          liquidators[i]!.liquidateSingle(
            marketObj,
            { ...v.iposition, seizableCollateral: v.seizable } as any,
          ),
        ),
      );
      const attempts = selected.length + preLiqSelected.length;
      const successes = results.filter(Boolean).length + preLiqResults.filter(Boolean).length;
      console.log(`🧾 [Confirmed] handled transmit @ ${nowIso()} attempts=${attempts} (preLiq=${preLiqSelected.length}, liq=${selected.length}), successes=${successes}, candidates=${candidates.length}`);
      pushAudit({ ts: nowIso(), status: 'processed', tx: item?.txHash, block: item?.blockNumber?.toString?.(), attempts, successes });
      if (attempts === 0) {
        console.log(`[diag] no viable positions: scanned=${batch.length} viable=0`);
      }
      attemptsTotal += attempts;
      successesTotal += successes;
    } catch (e) {
      const errMsg = (e as any)?.message ?? String(e);
      const errStack = (e as any)?.stack;
      const context: Record<string, any> = {
        aggregator: MARKET.aggregator,
        head: head?.toString?.(),
        item: item ? { blockNumber: item.blockNumber?.toString?.(), txIndex: item.txIndex, logIndex: item.logIndex, txHash: item.txHash } : undefined,
        phase,
        params: paramsDump,
      };
      // 深度解析该 tx 的事件，帮助定位解码/精度问题
      try {
        if (item?.txHash) {
          const receipt = await (publicClient as any).getTransactionReceipt({ hash: item.txHash as `0x${string}` });
          const log = receipt?.logs?.find((l: any) => String(l.address).toLowerCase() === String(MARKET.aggregator).toLowerCase());
          if (log) {
            const OCR2_EVENT = getAbiItem({
              abi: [{ type: 'event', name: 'NewTransmission', inputs: [
                { indexed: true, name: 'aggregatorRoundId', type: 'uint32' },
                { indexed: false, name: 'answer', type: 'int192' },
                { indexed: false, name: 'transmitter', type: 'address' },
                { indexed: false, name: 'observations', type: 'int192[]' },
                { indexed: false, name: 'observers', type: 'bytes' },
                { indexed: false, name: 'rawReportContext', type: 'bytes32' },
              ]}], name: 'NewTransmission',
            }) as any;
            const dec = decodeEventLog({ abi: [OCR2_EVENT], data: log.data, topics: log.topics as any });
            const args: any = dec?.args ?? {};
            context.decoded = {
              aggregatorRoundId: (args?.aggregatorRoundId as any)?.toString?.() ?? String(args?.aggregatorRoundId),
              answerRaw: (args?.answer as any)?.toString?.(),
              transmitter: args?.transmitter,
            };
          }
        }
      } catch {}
      console.warn("⚠️ handleConfirmedTransmission error:", errMsg, context);
      if (item?.txHash) pushAudit({ ts: nowIso(), status: 'error', tx: item.txHash, block: item.blockNumber?.toString?.(), phase, error: errMsg });
      if (errStack) console.warn("stack=\n" + errStack);
    }
  }

  await fetchCandidates();
  setInterval(fetchCandidates, CANDIDATE_REFRESH_MS);
  console.log("✅ 确认型策略已启动（等待 transmit 事件确认）");

  // Lightweight metrics endpoint for observability
  try {
    const { createServer } = await import('http');
    const startedAt = Date.now();
    const server = createServer((_req, res) => {
      if (_req.url === '/metrics') {
        const body = JSON.stringify({
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          aggregator: MARKET.aggregator,
          events: { received: eventsReceived, processed: eventsProcessed, queued: queue.length },
          head: head?.toString(),
          candidates: candidates.length,
          executors: liquidators.length,
          liquidations: { attemptsTotal, successesTotal },
          lastEvents: audits.slice(-10),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(48101, () => console.log('📊 Confirmed worker metrics on :48101/metrics'));
  } catch {}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
