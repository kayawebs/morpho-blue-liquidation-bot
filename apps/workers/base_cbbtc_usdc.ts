import { chainConfig } from "../config/dist/index.js";
import { base } from "viem/chains";
import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  type Hash,
  type Address,
  getAbiItem,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { AlchemyMempoolMonitor } from "../client/src/mempool/AlchemyMempoolMonitor.js";
import { analyzeMorphoPendingTx } from "../client/src/fastpath/index.js";
import { tryDecodeOcr2AnswerFromInput } from "../client/src/oracle-ocr/decoder.js";
import { LiquidationBot } from "../client/src/bot.js";
import { UniswapV3Venue } from "../client/src/liquidityVenues/uniswapV3/index.js";
import { BaseChainlinkPricer } from "../client/src/pricers/baseChainlink/index.js";
import { AccrualPosition, Market, MarketParams, type IAccrualPosition } from "@morpho-org/blue-sdk";
import { readContract } from "viem/actions";
import { morphoBlueAbi } from "../ponder/abis/MorphoBlue.js";

// Hard-coded market configuration for Base cbBTC/USDC
// Fill the FILL_ME_* fields for full OCR fast-path support.
const MARKET = {
  chainId: base.id,
  marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" as const,
  morphoAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address,
  // Composite oracle (read-only), listed for reference
  compositeOracle: "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9" as Address,
  // Underlying Chainlink aggregator feeds used to derive the composite price
  feeds: {
    BASE_FEED_1: {
      address: "0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8" as Address,
      variant: "ocr2" as const, // transmit(bytes,bytes32[],bytes32[],bytes32)
      decimals: 8, // If needed; SCALE_FACTOR already compensates in composite oracle
    },
    BASE_FEED_2: {
      address: "0x0000000000000000000000000000000000000000" as Address,
      variant: "v2v3" as const,
      decimals: 0,
    },
    QUOTE_FEED_1: {
      address: "0x0000000000000000000000000000000000000000" as Address,
      variant: "v2v3" as const,
      decimals: 0,
    },
    QUOTE_FEED_2: {
      address: "0x0000000000000000000000000000000000000000" as Address,
      variant: "v2v3" as const,
      decimals: 0,
    },
  },
  // SCALE_FACTOR as defined by MorphoChainlinkOracleV2 constructor comment
  // SCALE_FACTOR = 10^(36 + dQ1 + fpQ1 + fpQ2 - dB1 - fpB1 - fpB2) * QUOTE_VAULT_CONVERSION_SAMPLE / BASE_VAULT_CONVERSION_SAMPLE
  scaleFactor: 100000000000000000000000000n, // from composite oracle SCALE_FACTOR()
  // Tokens (for info/logging only)
  tokens: {
    cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address,
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  },
};

async function main() {
  const cfg = chainConfig(MARKET.chainId);

  // Prefer WS for mempool, HTTP for writes
  const publicClient = createPublicClient({
    chain: base,
    transport: cfg.wsRpcUrl ? webSocket(cfg.wsRpcUrl) : http(cfg.rpcUrl),
  });
  const walletClient = createWalletClient({
    chain: base,
    transport: http(cfg.rpcUrl),
    account: privateKeyToAccount(cfg.liquidationPrivateKey),
  });

  console.log("🚀 Starting worker: Base cbBTC/USDC");
  console.log(`📍 Network: Base (${MARKET.chainId})`);
  console.log(`🏦 Morpho: ${MARKET.morphoAddress}`);
  console.log(`🧮 MarketId: ${MARKET.marketId}`);

  // Liquidation bot (reuses existing execution flow)
  const basePricer = new BaseChainlinkPricer();
  const uniswapV3Venue = new UniswapV3Venue();
  const liquidator = new LiquidationBot({
    logTag: "🔥 base_cbbtc_usdc ",
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

  // Ponder candidates wiring
  const PONDER_API_URL = process.env.PONDER_SERVICE_URL ?? "http://localhost:42069";
  const CANDIDATE_REFRESH_MS = Number(process.env.CANDIDATE_REFRESH_MS ?? 60_000);
  const CANDIDATE_BATCH = Number(process.env.CANDIDATE_BATCH ?? 50);
  const CANDIDATE_SOURCE = (process.env.CANDIDATE_SOURCE ?? "ponder").toLowerCase();
  const CANDIDATE_LOGS_LOOKBACK = BigInt(process.env.CANDIDATE_LOGS_LOOKBACK_BLOCKS ?? "10000");
  const CANDIDATE_LOGS_CHUNK = BigInt(process.env.CANDIDATE_LOGS_CHUNK ?? "2000");
  let candidates: Address[] = [];
  const candidateSet = new Set<string>();
  let marketParamsCache: any | undefined;
  let nextIdx = 0;

  async function fetchCandidates(): Promise<void> {
    try {
      if (CANDIDATE_SOURCE === "ponder") {
        const res = await fetch(new URL(`/chain/${MARKET.chainId}/candidates`, PONDER_API_URL), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ marketIds: [MARKET.marketId] }),
        });
        if (!res.ok) {
          console.warn(`⚠️ candidates fetch failed: ${res.status} ${res.statusText}`);
        } else {
          const data = (await res.json()) as Record<string, Address[]>;
          const list = data[MARKET.marketId] ?? [];
          for (const u of list) candidateSet.add(u.toLowerCase());
        }
      } else {
        await hydrateCandidatesFromLogs();
      }
      candidates = [...candidateSet] as Address[];
      console.log(`👥 Candidates loaded: ${candidates.length} (source=${CANDIDATE_SOURCE})`);
    } catch (e) {
      console.warn("⚠️ candidates fetch error:", e);
    }
  }

  async function hydrateCandidatesFromLogs() {
    const head = await publicClient.getBlockNumber();
    const fromBlock = head > CANDIDATE_LOGS_LOOKBACK ? head - CANDIDATE_LOGS_LOOKBACK : 0n;
    const borrowEvent = getAbiItem({ abi: morphoBlueAbi, name: "Borrow" }) as any;
    const supplyColEvent = getAbiItem({ abi: morphoBlueAbi, name: "SupplyCollateral" }) as any;
    const step = CANDIDATE_LOGS_CHUNK;
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
    // Live updates: confirmed logs watcher to grow set incrementally
    try {
      publicClient.watchEvent({
        address: MARKET.morphoAddress,
        event: borrowEvent,
        args: { id: MARKET.marketId as any },
        onLogs: (logs: any[]) => {
          for (const l of logs) candidateSet.add((l.args.onBehalf as string).toLowerCase());
        },
      } as any);
      publicClient.watchEvent({
        address: MARKET.morphoAddress,
        event: supplyColEvent,
        args: { id: MARKET.marketId as any },
        onLogs: (logs: any[]) => {
          for (const l of logs) candidateSet.add((l.args.onBehalf as string).toLowerCase());
        },
      } as any);
    } catch {}
  }

  async function getMarketParams() {
    if (marketParamsCache) return marketParamsCache;
    marketParamsCache = await readContract(publicClient as any, {
      address: MARKET.morphoAddress,
      abi: morphoBlueAbi,
      functionName: "idToMarketParams",
      args: [MARKET.marketId],
    });
    return marketParamsCache;
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

  async function getUserPosition(user: Address) {
    return (await readContract(publicClient as any, {
      address: MARKET.morphoAddress,
      abi: morphoBlueAbi,
      functionName: "position",
      args: [MARKET.marketId, user],
    })) as { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
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

  // Build watchlist: only Morpho + underlying feeds
  const watchAddresses = new Set<Address>([
    MARKET.morphoAddress,
    MARKET.feeds.BASE_FEED_1.address, // only real writer
  ]);

  const monitor = new AlchemyMempoolMonitor({
    client: publicClient as any,
    morphoAddress: MARKET.morphoAddress,
    oracleAddresses: watchAddresses,
    pollingInterval: 200,
    onPendingTransaction: async (txHash: Hash, tx: { to?: Address; input?: `0x${string}` }) => {
      if (!tx.to) return;
      try {
        if (tx.to.toLowerCase() === MARKET.morphoAddress.toLowerCase()) {
          // Morpho fast-path: predict borrower risk increase
          const analysis = await analyzeMorphoPendingTx(
            publicClient as any,
            MARKET.morphoAddress,
            { to: tx.to, input: tx.input },
          );
          if (analysis?.market && analysis.position && analysis.position.seizableCollateral > 0n) {
            console.log(
              `🚨 Fast-path (Morpho) candidate ${analysis.position.user} seizable=${analysis.position.seizableCollateral.toString()}`,
            );
            await liquidator.liquidateSingle(analysis.market, analysis.position as any);
          }
          return;
        }

        // Oracle fast-path: detect OCR transmit on underlying feeds and derive composite price
        if (watchAddresses.has(tx.to)) {
          const label = Object.entries(MARKET.feeds).find(([, f]) =>
            f.address.toLowerCase() === tx.to!.toLowerCase(),
          )?.[0];
          console.log(`📡 OCR transmit detected on ${label ?? "feed"}: ${txHash}`);

          // Only BASE_FEED_1 is active; others are zero address.
          const decoded = tryDecodeOcr2AnswerFromInput(tx.input as any);
          if (!decoded?.answer) return;
          const answer = decoded.answer; // int192 scaled by aggregator decimals (8)
          const predictedPrice = MARKET.scaleFactor * answer; // 1e36-scaled as per oracle contract
          console.log(`💡 Predicted cbBTC/USDC price (1e36): ${predictedPrice.toString()}`);

          // With predictedPrice, recompute target market candidate positions and liquidate if profitable.
          const [params, view] = await Promise.all([getMarketParams(), getMarketView()]);
          const marketObj = new Market({
            chainId: MARKET.chainId,
            id: MARKET.marketId as any,
            params: new MarketParams(params),
            price: predictedPrice,
            totalSupplyAssets: view.totalSupplyAssets,
            totalSupplyShares: view.totalSupplyShares,
            totalBorrowAssets: view.totalBorrowAssets,
            totalBorrowShares: view.totalBorrowShares,
            lastUpdate: view.lastUpdate,
            fee: view.fee,
          }).accrueInterest(Math.floor(Date.now() / 1000).toString());

          const batch = pickBatch();
          for (const user of batch) {
            try {
              const p = await getUserPosition(user);
              if (p.borrowShares === 0n) continue;
              const iposition: IAccrualPosition = {
                chainId: MARKET.chainId,
                marketId: MARKET.marketId as any,
                user,
                supplyShares: p.supplyShares,
                borrowShares: p.borrowShares,
                collateral: p.collateral,
              };
              const seizable = new AccrualPosition(iposition, marketObj).seizableCollateral ?? 0n;
              if (seizable > 0n) {
                console.log(`🎯 Candidate liquidatable: ${user} seizable=${seizable.toString()}`);
                await liquidator.liquidateSingle(marketObj, { ...iposition, seizableCollateral: seizable } as any);
              }
            } catch {}
          }
        }
      } catch (err) {
        console.error("❌ Worker error handling pending tx:", err);
      }
    },
  });

  // Initial candidates fetch + schedule refresh
  await fetchCandidates();
  setInterval(fetchCandidates, CANDIDATE_REFRESH_MS);

  await monitor.start();
  console.log("✅ Worker running. Listening for Morpho & Oracle pending tx...");

  // Graceful shutdown
  process.on("SIGINT", () => {
    monitor.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    monitor.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("❌ Worker failed to start:", e);
  process.exit(1);
});
