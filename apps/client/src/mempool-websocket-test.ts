import { chainConfig } from "@morpho-blue-liquidation-bot/config";
import { base } from "viem/chains";

async function testWebSocketMempool() {
  const config = chainConfig(base.id);
  
  // 优先使用配置的 WS 地址，否则从 HTTP 推断
  const wsUrl = config.wsRpcUrl ?? config.rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  
  console.log("🧪 Testing WebSocket mempool support...");
  console.log(`WebSocket URL: ${wsUrl}`);
  
  try {
    const { createPublicClient, webSocket } = await import("viem");
    
    const client = createPublicClient({
      chain: base,
      transport: webSocket(wsUrl),
    });
    
    console.log("📡 Testing WebSocket pending transaction monitoring...");
    
    let txCount = 0;
    const startTime = Date.now();
    let testTimeout: NodeJS.Timeout;
    
    const unwatch = client.watchPendingTransactions({
      onTransactions: (hashes) => {
        txCount += hashes.length;
        const elapsed = Date.now() - startTime;
        console.log(`✅ Detected ${hashes.length} pending txs (total: ${txCount}, elapsed: ${elapsed}ms)`);
        
        if (txCount >= 5) { // 检测到5个交易就认为成功
          clearTimeout(testTimeout);
          unwatch();
          console.log(`\n🎉 WebSocket mempool monitoring works! Detected ${txCount} transactions`);
          console.log("✅ Your Alchemy RPC supports WebSocket mempool monitoring");
          console.log("🚀 Ready for high-performance mempool bot!");
          process.exit(0);
        }
      },
      onError: (error) => {
        console.error("❌ WebSocket mempool error:", error);
        clearTimeout(testTimeout);
        unwatch();
        console.log("\n💡 WebSocket mempool not supported. Try HTTP polling mode.");
        process.exit(1);
      },
    });
    
    console.log("⏳ Monitoring WebSocket for 10 seconds...");
    
    testTimeout = setTimeout(() => {
      unwatch();
      console.log(`\n📊 WebSocket test results: ${txCount} transactions in 10 seconds`);
      
      if (txCount > 0) {
        console.log("✅ WebSocket mempool monitoring works (low activity period)");
        console.log("🚀 You can proceed with mempool bot");
      } else {
        console.log("⚠️  No transactions detected via WebSocket either");
        console.log("This suggests:");
        console.log("1. 🔒 Alchemy requires premium for mempool access");
        console.log("2. 📊 Base chain is unusually quiet");
        console.log("3. 🛡️  Mempool filtering by Alchemy");
      }
      process.exit(0);
    }, 10000);
    
  } catch (error) {
    console.error("❌ WebSocket test failed:", error);
    console.log("\n💡 WebSocket not supported. Consider upgrading RPC provider.");
    console.log("Recommended for mempool monitoring:");
    console.log("- QuickNode: Full mempool access");
    console.log("- Alchemy Pro: WebSocket support");
    console.log("- Self-hosted node: Complete control");
  }
}

testWebSocketMempool();
