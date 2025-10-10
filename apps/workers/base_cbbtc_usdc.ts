import { chainConfig } from "../config/dist/index.js";
import { base } from "viem/chains";
import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { AlchemyMempoolMonitor } from "../client/src/mempool/AlchemyMempoolMonitor.js";
import { analyzeMorphoPendingTx } from "../client/src/fastpath/index.js";
import { tryDecodeOcr2AnswerFromInput } from "../client/src/oracle-ocr/decoder.js";
import { LiquidationBot } from "../client/src/bot.js";
import { UniswapV3Venue } from "../client/src/liquidityVenues/uniswapV3/index.js";
import { BaseChainlinkPricer } from "../client/src/pricers/baseChainlink/index.js";

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

          // TODO: With predictedPrice, recompute target market candidate positions and liquidate if profitable.
          // For now, rely on Morpho fast-path (borrow/withdraw) while OCR execution path is being finalized.
        }
      } catch (err) {
        console.error("❌ Worker error handling pending tx:", err);
      }
    },
  });

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
