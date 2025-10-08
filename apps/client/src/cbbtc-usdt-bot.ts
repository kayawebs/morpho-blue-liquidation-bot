import { chainConfig } from "@morpho-blue-liquidation-bot/config";
import { base } from "viem/chains";
import { createPublicClient, createWalletClient, http, type Hash, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AlchemyMempoolMonitor } from "./mempool/AlchemyMempoolMonitor.js";
import { PositionStateCache } from "./mempool/PositionStateCache.js";
import { BackrunStrategy } from "./mempool/BackrunStrategy.js";
import { LiquidationBot } from "./bot.js";
import { BaseChainlinkPricer } from "./pricers/baseChainlink/index.js";
import { fetchLiquidatablePositions } from "./utils/fetchers.js";
import { UniswapV3Venue } from "./liquidityVenues/uniswapV3/index.js";

// cbBTC/USDC Market Configuration for Base (corrected from USDT to USDC)
const CBBTC_USDC_CONFIG = {
  // Market ID from Morpho UI
  marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
  
  // 预言机地址
  oracles: {
    cbBtcUsdc: "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9", // cbBTC/USDC composite oracle (主要监控)
    btcUsd: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F", // BTC/USD
    usdcUsd: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", // USDC/USD  
    ethUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // ETH/USD (for gas pricing)
  },
  
  // cbBTC/USDC市场相关代币
  tokens: {
    cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC on Base
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  },
  
  // 监控配置
  monitoring: {
    pollingInterval: 100, // 100ms 极低延迟
    profitThreshold: 10, // $10 最小利润
    maxGasPrice: 50n * 10n**9n, // 50 gwei
  }
};

class CBBTCUSDCLiquidationBot {
  private config: any;
  private publicClient: any;
  private walletClient: any;
  private mempoolMonitor?: AlchemyMempoolMonitor;
  private positionCache?: PositionStateCache;
  private backrunStrategy?: BackrunStrategy;
  private basePricer: BaseChainlinkPricer;
  private liquidationBot?: LiquidationBot;
  
  constructor() {
    this.config = chainConfig(base.id);
    
    // 创建clients
    this.publicClient = createPublicClient({
      chain: base,
      transport: http(this.config.rpcUrl),
    });
    
    this.walletClient = createWalletClient({
      chain: base,
      transport: http(this.config.rpcUrl),
      account: privateKeyToAccount(this.config.liquidationPrivateKey),
    });
    
    // 初始化Base Chainlink价格处理器
    this.basePricer = new BaseChainlinkPricer();
    
    // 初始化UniswapV3流动性场所
    const uniswapV3Venue = new UniswapV3Venue();
    
    // 初始化清算机器人
    this.liquidationBot = new LiquidationBot({
      logTag: "🔥 cbBTC/USDC ",
      chainId: base.id,
      client: this.walletClient,
      morphoAddress: this.config.morpho.address,
      wNative: this.config.wNative,
      vaultWhitelist: [], // 直接监控特定市场
      additionalMarketsWhitelist: [CBBTC_USDC_CONFIG.marketId],
      executorAddress: this.config.executorAddress,
      liquidityVenues: [uniswapV3Venue], // 添加UniswapV3用于cbBTC→USDC转换
      pricers: [this.basePricer],
    });
  }
  
  async start() {
    console.log("🚀 Starting cbBTC/USDC Liquidation Bot");
    console.log("📍 Network: Base");
    console.log("💰 Target Market: cbBTC/USDC");
    console.log(`🏦 Executor: ${this.config.executorAddress}`);
    console.log(`👤 Wallet: ${this.walletClient.account.address}`);
    
    // 检查资金状态
    await this.checkFunding();
    
    // 初始化组件
    await this.initializeComponents();
    
    // 启动监控
    await this.startMonitoring();
    
    console.log("✅ cbBTC/USDC Liquidation Bot is running!");
    console.log("🎯 Monitoring for liquidation opportunities...");
  }
  
  private async checkFunding() {
    const walletBalance = await this.publicClient.getBalance({ 
      address: this.walletClient.account.address 
    });
    
    const executorBalance = await this.publicClient.getBalance({ 
      address: this.config.executorAddress 
    });
    
    console.log(`💳 Wallet: ${(Number(walletBalance) / 1e18).toFixed(6)} ETH`);
    console.log(`🏦 Executor: ${(Number(executorBalance) / 1e18).toFixed(6)} ETH`);
    
    if (executorBalance < 1000000000000000n) { // < 0.001 ETH
      console.warn("⚠️  Low executor balance! Consider funding more ETH");
    }
  }
  
  private async initializeComponents() {
    console.log("🔧 Initializing components...");
    
    // 1. Position Cache
    this.positionCache = new PositionStateCache(
      this.publicClient,
      this.config.morpho.address
    );
    
    // 2. Backrun Strategy
    this.backrunStrategy = new BackrunStrategy({
      client: this.walletClient,
      executorAddress: this.config.executorAddress,
      morphoAddress: this.config.morpho.address,
      maxGasPrice: CBBTC_USDC_CONFIG.monitoring.maxGasPrice,
      profitThresholdUsd: CBBTC_USDC_CONFIG.monitoring.profitThreshold,
    });
    
    // 3. Mempool Monitor
    const oracleAddresses = new Set([
      CBBTC_USDC_CONFIG.oracles.cbBtcUsdc.toLowerCase(), // 主要监控composite oracle
      CBBTC_USDC_CONFIG.oracles.btcUsd.toLowerCase(),
      CBBTC_USDC_CONFIG.oracles.usdcUsd.toLowerCase(),
      CBBTC_USDC_CONFIG.oracles.ethUsd.toLowerCase(),
    ]);
    
    this.mempoolMonitor = new AlchemyMempoolMonitor({
      client: this.publicClient,
      morphoAddress: this.config.morpho.address,
      oracleAddresses,
      pollingInterval: CBBTC_USDC_CONFIG.monitoring.pollingInterval,
      onPendingTransaction: this.handlePendingTransaction.bind(this),
    });
    
    console.log("✅ Components initialized");
  }
  
  private async startMonitoring() {
    console.log(`🔍 Starting mempool monitoring (${CBBTC_USDC_CONFIG.monitoring.pollingInterval}ms interval)...`);
    
    // 初始化position cache for cbBTC/USDC市场
    await this.positionCache!.initialize([CBBTC_USDC_CONFIG.marketId as any]);
    
    // 启动mempool监控
    await this.mempoolMonitor!.start();
    
    // 定期显示统计
    setInterval(async () => {
      if (this.mempoolMonitor) {
        const stats = await this.mempoolMonitor.getPendingStats();
        console.log(`📊 Mempool: ${stats.totalPendingTxs} total, ${stats.seenTxs} monitored`);
      }
    }, 30000); // 每30秒
  }
  
  private async handlePendingTransaction(txHash: Hash, tx: any) {
    console.log(`\n🎯 RELEVANT PENDING TRANSACTION DETECTED:`);
    console.log(`   Hash: ${txHash}`);
    console.log(`   To: ${tx.to}`);
    console.log(`   Gas: ${tx.gasPrice} wei (${(Number(tx.gasPrice) / 1e9).toFixed(2)} gwei)`);
    
    // 检查交易类型
    if (this.isOracleUpdate(tx)) {
      console.log(`📊 Oracle price update detected!`);
      await this.handleOracleUpdate(tx);
    } else if (this.isMorphoTransaction(tx)) {
      console.log(`🏦 Morpho transaction detected!`);
      await this.handleMorphoTransaction(tx);
    } else {
      console.log(`💰 Large transaction detected!`);
    }
  }
  
  private isOracleUpdate(tx: any): boolean {
    const oracles = Object.values(CBBTC_USDC_CONFIG.oracles);
    return oracles.some(oracle => 
      tx.to && tx.to.toLowerCase() === oracle.toLowerCase()
    );
  }
  
  private isMorphoTransaction(tx: any): boolean {
    return tx.to && tx.to.toLowerCase() === this.config.morpho.address.toLowerCase();
  }
  
  private async handleOracleUpdate(tx: any) {
    console.log(`📈 Processing oracle price update...`);
    
    try {
      // 1. 获取新的cbBTC/USDC价格
      const newPrice = await this.basePricer.getCbBtcUsdcPrice(this.publicClient);
      if (!newPrice) {
        console.warn(`⚠️ Failed to get new cbBTC/USDC price after oracle update`);
        return;
      }
      
      console.log(`💰 New cbBTC/USDC price: ${newPrice.toFixed(6)}`);
      
      // 2. 检测价格变化幅度
      const cbBtcAddress = CBBTC_USDC_CONFIG.tokens.cbBTC as any;
      const priceChange = await this.basePricer.detectPriceChange(
        this.publicClient, 
        cbBtcAddress,
        0.5 // 0.5% threshold for triggering liquidation checks
      );
      
      if (priceChange) {
        console.log(`🚨 Significant price change detected!`);
        console.log(`   Old price: $${priceChange.oldPrice?.toFixed(6)}`);
        console.log(`   New price: $${priceChange.newPrice?.toFixed(6)}`);
        console.log(`   Change: ${priceChange.changePercent?.toFixed(2)}%`);
        
        // 3. 检查缓存的仓位是否需要清算
        await this.checkPositionsForLiquidation(newPrice);
      } else {
        console.log(`📊 Price change within normal range`);
      }
    } catch (error) {
      console.error(`❌ Error processing oracle update:`, error);
    }
  }
  
  private async handleMorphoTransaction(tx: any) {
    console.log(`🔄 Processing Morpho transaction...`);
    
    // 这里会实现：
    // 1. 解析Morpho操作
    // 2. 检查是否影响监控的市场
    // 3. 更新position cache
    
    console.log(`⏳ Morpho transaction processing (implementation needed)`);
  }
  
  // 检查仓位是否需要清算（连接到现有的清算逻辑）
  private async checkPositionsForLiquidation(newPrice: number) {
    console.log(`🔍 Checking positions for liquidation at price $${newPrice.toFixed(6)}...`);
    
    try {
      // 使用现有的liquidationBot来获取清算数据
      const liquidationData = await fetchLiquidatablePositions(
        base.id, 
        [CBBTC_USDC_CONFIG.marketId]
      );
      
      if (liquidationData.length === 0) {
        console.log(`📊 No liquidatable positions found`);
        return;
      }
      
      console.log(`🎯 Found ${liquidationData.length} market(s) with potential liquidations`);
      
      // 使用现有的LiquidationBot处理清算
      for (const marketData of liquidationData) {
        const { market, positionsLiq, positionsPreLiq } = marketData;
        
        if (positionsLiq.length > 0) {
          console.log(`💥 Found ${positionsLiq.length} liquidatable position(s)!`);
          
          // 使用现有的liquidationBot执行清算
          for (const position of positionsLiq) {
            console.log(`⚡ Attempting liquidation of ${position.user}`);
            console.log(`   Seizable collateral: ${(Number(position.seizableCollateral) / 1e8).toFixed(8)} cbBTC`);
            
            try {
              // 直接调用liquidationBot的私有方法逻辑
              await this.executeLiquidation(market, position);
            } catch (error) {
              console.error(`❌ Liquidation failed for ${position.user}:`, error);
            }
          }
        }
        
        if (positionsPreLiq.length > 0) {
          console.log(`⚠️ Found ${positionsPreLiq.length} pre-liquidatable position(s)`);
        }
      }
    } catch (error) {
      console.error(`❌ Error checking positions for liquidation:`, error);
    }
  }
  
  // 简化的清算执行方法（基于现有的LiquidationBot逻辑）
  private async executeLiquidation(market: any, position: any) {
    if (!this.liquidationBot) {
      console.error(`❌ LiquidationBot not initialized`);
      return;
    }
    
    console.log(`🔥 Executing liquidation via LiquidationBot...`);
    
    // 创建临时的市场数据来触发现有的清算逻辑
    const marketData = {
      market,
      positionsLiq: [position],
      positionsPreLiq: []
    };
    
    // 直接调用现有liquidationBot的run方法来处理这个特定市场
    return Promise.all([marketData].map((data) => 
      // 模拟LiquidationBot.handleMarket的行为
      this.liquidationBot!.run()
    ));
  }
  
  async stop() {
    console.log("🛑 Stopping cbBTC/USDC Liquidation Bot");
    
    if (this.mempoolMonitor) {
      this.mempoolMonitor.stop();
    }
    
    if (this.positionCache) {
      this.positionCache.stop();
    }
    
    console.log("👋 Bot stopped gracefully");
  }
}

// 启动函数
async function startCBBTCUSDCBot() {
  const bot = new CBBTCUSDCLiquidationBot();
  
  // 优雅关闭处理
  process.on("SIGINT", async () => {
    console.log("\n🛡️  Received shutdown signal...");
    await bot.stop();
    process.exit(0);
  });
  
  process.on("SIGTERM", async () => {
    console.log("\n🛡️  Received termination signal...");
    await bot.stop();
    process.exit(0);
  });
  
  // 启动bot
  try {
    await bot.start();
  } catch (error) {
    console.error("❌ Failed to start bot:", error);
    process.exit(1);
  }
}

// 检查是否直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  startCBBTCUSDCBot().catch(console.error);
}

export { CBBTCUSDCLiquidationBot, startCBBTCUSDCBot };