import type { Client, Transport, Chain, Account, Hash, Address, Hex } from "viem";

export interface AlchemyMempoolConfig {
  client: Client<Transport, Chain, Account>;
  morphoAddress: Address;
  oracleAddresses: Set<Address>;
  onPendingTransaction: (txHash: Hash, tx: any) => Promise<void>;
  pollingInterval: number; // milliseconds
}

export class AlchemyMempoolMonitor {
  private config: AlchemyMempoolConfig;
  private isRunning = false;
  private lastSeenTxs = new Set<Hash>();
  
  constructor(config: AlchemyMempoolConfig) {
    this.config = config;
  }
  
  async start() {
    console.log("🚀 Starting Alchemy mempool monitoring via pending block...");
    this.isRunning = true;
    
    // 开始轮询pending块
    this.pollPendingBlock();
  }
  
  stop() {
    console.log("🛑 Stopping Alchemy mempool monitoring");
    this.isRunning = false;
  }
  
  private async pollPendingBlock() {
    if (!this.isRunning) return;
    
    try {
      // 获取pending块
      const pendingBlock = await this.config.client.request({
        method: "eth_getBlockByNumber",
        params: ["pending", true], // true = 包含完整交易详情
      }) as any;
      
      if (pendingBlock && pendingBlock.transactions) {
        const newTxs = pendingBlock.transactions.filter((tx: any) => 
          !this.lastSeenTxs.has(tx.hash)
        );
        
        if (newTxs.length > 0) {
          console.log(`📦 Found ${newTxs.length} new pending transactions`);
          
          // 处理新交易
          for (const tx of newTxs) {
            this.lastSeenTxs.add(tx.hash);
            
            // 检查是否与我们的监控目标相关
            if (await this.isRelevantTransaction(tx)) {
              console.log(`🎯 Relevant pending tx: ${tx.hash}`);
              await this.config.onPendingTransaction(tx.hash, tx);
            }
          }
          
          // 清理旧的已见交易（避免内存泄漏）
          if (this.lastSeenTxs.size > 1000) {
            const txArray = Array.from(this.lastSeenTxs);
            this.lastSeenTxs = new Set(txArray.slice(-500)); // 保留最近500个
          }
        }
      }
      
    } catch (error) {
      console.error("❌ Error polling pending block:", error);
    }
    
    // 继续轮询
    setTimeout(() => this.pollPendingBlock(), this.config.pollingInterval);
  }
  
  private async isRelevantTransaction(tx: any): Promise<boolean> {
    // 检查是否是我们关心的交易
    
    // 1. 检查是否是预言机价格更新
    if (tx.to && this.config.oracleAddresses.has(tx.to.toLowerCase())) {
      console.log(`📊 Oracle price update detected: ${tx.to}`);
      return true;
    }
    
    // 2. 检查是否是Morpho交易
    if (tx.to && tx.to.toLowerCase() === this.config.morphoAddress.toLowerCase()) {
      // 解析函数选择器
      const functionSelector = tx.input?.slice(0, 10);
      const relevantFunctions = [
        "0x5c19a95c", // borrow
        "0xb6b55f25", // withdraw  
        "0x69328dec", // withdrawCollateral
        "0xf5298aca", // repay
        "0x6a627842", // supply
        "0x47e7ef24", // supplyCollateral
        "0x94a93ac0", // liquidate
      ];
      
      if (functionSelector && relevantFunctions.includes(functionSelector)) {
        console.log(`🏦 Morpho transaction detected: ${functionSelector}`);
        return true;
      }
    }
    
    // 3. 检查是否是大额交易（可能影响价格）
    if (tx.value && BigInt(tx.value) > 10n * 10n**18n) { // >10 ETH
      console.log(`💰 Large transaction detected: ${tx.value} wei`);
      return true;
    }
    
    return false;
  }
  
  // 获取当前pending交易统计
  async getPendingStats() {
    try {
      const pendingBlock = await this.config.client.request({
        method: "eth_getBlockByNumber", 
        params: ["pending", false],
      }) as any;
      
      return {
        totalPendingTxs: pendingBlock?.transactions?.length || 0,
        seenTxs: this.lastSeenTxs.size,
      };
    } catch (error) {
      return { totalPendingTxs: 0, seenTxs: 0 };
    }
  }
}