import { createWalletClient, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainConfig } from "@morpho-blue-liquidation-bot/config";
import { MempoolMonitor, type LiquidationOpportunity } from "./MempoolMonitor";
import { PositionStateCache } from "./PositionStateCache";
import { BackrunStrategy, type BackrunTarget } from "./BackrunStrategy";
import type { LiquidityVenue } from "../liquidityVenues/liquidityVenue";
import type { Pricer } from "../pricers/pricer";

export interface MempoolBotConfig extends ChainConfig {
  oracleAddresses: Address[]; // List of oracle addresses to monitor
  knownBorrowers?: Address[]; // Optional: specific borrowers to track
  maxGasPrice: bigint; // Maximum gas price willing to pay
  profitThresholdUsd: number; // Minimum profit threshold
}

export class MempoolBot {
  private config: MempoolBotConfig;
  private client: any;
  private mempoolMonitor: MempoolMonitor;
  private positionCache: PositionStateCache;
  private backrunStrategy: BackrunStrategy;
  private liquidityVenues: LiquidityVenue[];
  private pricers: Pricer[];
  
  constructor(
    config: MempoolBotConfig,
    liquidityVenues: LiquidityVenue[],
    pricers: Pricer[]
  ) {
    this.config = config;
    this.liquidityVenues = liquidityVenues;
    this.pricers = pricers;
    
    // Initialize client
    this.client = createWalletClient({
      chain: config.chain as Chain,
      transport: http(config.rpcUrl),
      account: privateKeyToAccount(config.liquidationPrivateKey),
    });
    
    // Initialize components
    this.positionCache = new PositionStateCache(
      this.client,
      config.morpho.address
    );
    
    this.backrunStrategy = new BackrunStrategy({
      client: this.client,
      executorAddress: config.executorAddress,
      morphoAddress: config.morpho.address,
      maxGasPrice: config.maxGasPrice,
      profitThresholdUsd: config.profitThresholdUsd,
    });
    
    this.mempoolMonitor = new MempoolMonitor({
      client: this.client,
      morphoAddress: config.morpho.address,
      oracleAddresses: new Set(config.oracleAddresses),
      onLiquidationOpportunity: this.handleLiquidationOpportunity.bind(this),
    });
  }
  
  async start() {
    console.log("🚀 Starting Mempool Bot");
    console.log(`📍 Chain: ${this.config.chain.name}`);
    console.log(`🎯 Monitoring ${this.config.oracleAddresses.length} oracles`);
    console.log(`⛽ Max gas: ${this.config.maxGasPrice / 10n**9n} gwei`);
    console.log(`💰 Min profit: $${this.config.profitThresholdUsd}`);
    
    // Initialize position cache with known markets
    const marketIds = await this.fetchWhitelistedMarkets();
    await this.positionCache.initialize(marketIds);
    
    // Start mempool monitoring
    await this.mempoolMonitor.start();
    
    console.log("✅ Mempool bot is running");
  }
  
  async stop() {
    console.log("🛑 Stopping Mempool Bot");
    this.mempoolMonitor.stop();
    this.positionCache.stop();
  }
  
  private async handleLiquidationOpportunity(opportunity: LiquidationOpportunity) {
    console.log(`\n💡 Liquidation opportunity detected!`);
    console.log(`   Market: ${opportunity.marketId}`);
    console.log(`   Borrower: ${opportunity.borrower}`);
    console.log(`   Trigger: ${opportunity.triggerTxHash}`);
    console.log(`   Type: ${opportunity.type}`);
    
    // Get full position details
    const position = await this.positionCache.getPosition(
      opportunity.marketId,
      opportunity.borrower
    );
    
    if (!position) {
      console.log("❌ Could not fetch position details");
      return;
    }
    
    // Estimate profit
    const estimatedProfit = await this.estimateProfit(
      position,
      opportunity.estimatedSeizableCollateral
    );
    
    if (estimatedProfit < this.config.profitThresholdUsd) {
      console.log(`❌ Not profitable: $${estimatedProfit}`);
      return;
    }
    
    // Prepare backrun
    const target: BackrunTarget = {
      triggerTxHash: opportunity.triggerTxHash,
      triggerGasPrice: opportunity.triggerGasPrice,
      marketParams: position.marketParams,
      borrower: opportunity.borrower,
      seizableCollateral: opportunity.estimatedSeizableCollateral,
      repaidShares: 0n, // Calculate based on position
      estimatedProfitUsd: estimatedProfit,
    };
    
    // Execute backrun
    const txHash = await this.backrunStrategy.executeBackrun(target);
    
    if (txHash) {
      // Monitor success
      await this.backrunStrategy.monitorBackrunSuccess(txHash);
    }
  }
  
  private async fetchWhitelistedMarkets(): Promise<Hex[]> {
    // Fetch whitelisted markets from vaults or config
    // This is simplified - real implementation would query vaults
    
    if (this.config.options.additionalMarketsWhitelist) {
      return this.config.options.additionalMarketsWhitelist as Hex[];
    }
    
    return [];
  }
  
  private async estimateProfit(
    position: any,
    seizableCollateral: bigint
  ): Promise<number> {
    // Estimate profit from liquidation
    // This would use pricers and consider swap costs
    
    // Simplified calculation
    const collateralValueUsd = 1000; // Would use actual pricer
    const debtValueUsd = 900; // Would calculate from position
    const swapCosts = 10; // Slippage and fees
    
    return collateralValueUsd - debtValueUsd - swapCosts;
  }
}

// Usage example
export async function launchMempoolBot(config: MempoolBotConfig) {
  // Import your liquidity venues and pricers
  const liquidityVenues: LiquidityVenue[] = [];
  const pricers: Pricer[] = [];
  
  const bot = new MempoolBot(config, liquidityVenues, pricers);
  
  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n👋 Shutting down gracefully...");
    await bot.stop();
    process.exit(0);
  });
  
  // Start the bot
  await bot.start();
}