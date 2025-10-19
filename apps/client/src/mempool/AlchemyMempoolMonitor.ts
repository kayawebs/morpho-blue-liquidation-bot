import type { Client, Transport, Chain, Account, Hash, Address, Hex } from "viem";
import { watchPendingTransactions, getTransaction } from "viem/actions";
import WebSocket from "ws";

export interface AlchemyMempoolConfig {
  client: Client<Transport, Chain, Account>;
  morphoAddress: Address;
  oracleAddresses: Set<Address>;
  onPendingTransaction: (txHash: Hash, tx: any) => Promise<void>;
  pollingInterval: number; // milliseconds
  wsUrl?: string; // optional WS URL for advanced subscriptions
  useAlchemyFilter?: boolean; // prefer alchemy_pendingTransactions if true
}

export class AlchemyMempoolMonitor {
  private config: AlchemyMempoolConfig;
  private isRunning = false;
  private lastSeenTxs = new Set<Hash>();
  private unwatch?: () => void;
  private usingWs = false;
  private alchemyWs?: WebSocket;
  private alchemySubId?: string;
  private oracleAddrsLc: Set<string>;
  
  constructor(config: AlchemyMempoolConfig) {
    this.config = config;
    // Normalize oracle addresses to lowercase for consistent matching
    this.oracleAddrsLc = new Set<string>([...config.oracleAddresses].map((a) => a.toLowerCase()));
  }
  
  async start() {
    console.log("🚀 Starting Alchemy mempool monitoring via pending block...");
    this.isRunning = true;
    
    // Prefer Alchemy filtered pending if available (greatly reduces traffic)
    const wantAlchemy =
      !!this.config.wsUrl && (this.config.useAlchemyFilter ?? /alchemy\.com/.test(this.config.wsUrl));
    if (wantAlchemy) {
      try {
        await this.startAlchemyPendingFilter();
        return;
      } catch (err) {
        console.warn("⚠️ alchemy_pendingTransactions failed, falling back to standard WS/polling");
      }
    }

    // 如果是 WS transport，优先使用 watchPendingTransactions
    try {
      // @ts-expect-error - narrow transport type at runtime
      if (this.config.client.transport?.type === "webSocket") {
        console.log("🔌 Using WebSocket watchPendingTransactions for mempool");
        this.usingWs = true;
        this.unwatch = watchPendingTransactions(this.config.client as any, {
          onTransactions: async (hashes: Hash[]) => {
            for (const hash of hashes) {
              if (this.lastSeenTxs.has(hash)) continue;
              this.lastSeenTxs.add(hash);
              try {
                const tx: any = await getTransaction(this.config.client as any, { hash });
                if (await this.isRelevantTransaction(tx)) {
                  console.log(`🎯 Relevant pending tx: ${hash}`);
                  await this.config.onPendingTransaction(hash, tx);
                }
              } catch {
                // swallow
              }
            }
          },
          onError: (err: unknown) => {
            console.error("❌ watchPendingTransactions error:", err);
          },
        });
        // If no events after 20s, fallback to HTTP polling
        setTimeout(() => {
          if (!this.isRunning) return;
          if (this.usingWs && this.lastSeenTxs.size === 0) {
            console.warn("⚠️  No WS pending events after 20s, falling back to HTTP polling");
            try {
              if (this.unwatch) this.unwatch();
            } catch {}
            this.usingWs = false;
            this.pollPendingBlock();
          }
        }, 20_000);
        return;
      }
    } catch {}

    // 回退到HTTP轮询pending块
    this.pollPendingBlock();
  }
  
  stop() {
    console.log("🛑 Stopping Alchemy mempool monitoring");
    this.isRunning = false;
    if (this.unwatch) {
      try {
        this.unwatch();
      } catch {}
      this.unwatch = undefined;
    }
    this.usingWs = false;
    if (this.alchemyWs) {
      try {
        this.alchemyWs.close();
      } catch {}
      this.alchemyWs = undefined;
      this.alchemySubId = undefined;
    }
  }

  private async startAlchemyPendingFilter() {
    const wsUrl = this.config.wsUrl!;
    console.log("🔌 Using Alchemy filtered pending subscription");
    const ws = new WebSocket(wsUrl);
    this.alchemyWs = ws;

    const toAddress = [this.config.morphoAddress.toLowerCase(), ...this.oracleAddrsLc];
    const subReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_pendingTransactions",
      params: [
        {
          toAddress,
          hashesOnly: false,
        },
      ],
    };

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify(subReq));
      });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1 && msg.result && typeof msg.result === "string") {
            this.alchemySubId = msg.result as string;
            resolve();
            return;
          }
          if (msg.method === "eth_subscription" && msg.params?.subscription === this.alchemySubId) {
            const tx = msg.params?.result;
            const hash = tx?.hash as Hash | undefined;
            if (!hash) return;
            if (this.lastSeenTxs.has(hash)) return;
            this.lastSeenTxs.add(hash);
            const to = (tx.to ?? "").toLowerCase();
            if (!toAddress.includes(to)) return;
            void this.config.onPendingTransaction(hash, tx);
          }
        } catch {}
      });
      ws.on("error", (err) => {
        reject(err as Error);
      });
      ws.on("close", () => {
        if (this.isRunning) {
          console.warn("⚠️ Alchemy WS closed, falling back to standard WS/polling");
          void this.start();
        }
      });
    });
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
    if (tx.to && this.oracleAddrsLc.has(tx.to.toLowerCase())) {
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
