import { chainConfig } from "@morpho-blue-liquidation-bot/config";
import { base } from "viem/chains";

async function testMempoolSupport() {
  // 测试Alchemy是否支持mempool监控
  const config = chainConfig(base.id);
  
  console.log("🧪 Testing mempool support with your current RPC...");
  console.log(`RPC: ${config.rpcUrl}`);
  
  try {
    const { createPublicClient, http } = await import("viem");
    
    const client = createPublicClient({
      chain: base,
      transport: http(config.rpcUrl),
    });
    
    console.log("📡 Testing pending transaction monitoring...");
    
    let txCount = 0;
    const startTime = Date.now();
    let testTimeout: NodeJS.Timeout;
    
    const unwatch = client.watchPendingTransactions({
      onTransactions: (hashes) => {
        txCount += hashes.length;
        const elapsed = Date.now() - startTime;
        console.log(`✅ Detected ${hashes.length} pending txs (total: ${txCount}, elapsed: ${elapsed}ms)`);
        
        // 检测到交易就认为成功
        if (txCount > 0) {
          clearTimeout(testTimeout);
          unwatch();
          console.log(`\n🎉 Mempool monitoring works! Detected ${txCount} transactions`);
          console.log("✅ Your Alchemy RPC supports mempool monitoring");
          console.log("🚀 You can proceed with mempool-based liquidation bot");
          process.exit(0);
        }
      },
      onError: (error) => {
        console.error("❌ Mempool monitoring error:", error);
        clearTimeout(testTimeout);
        unwatch();
        process.exit(1);
      },
    });
    
    console.log("⏳ Monitoring for 5 seconds...");
    
    // 5秒后超时
    testTimeout = setTimeout(() => {
      unwatch();
      if (txCount === 0) {
        console.log("\n⚠️  No pending transactions detected in 5 seconds");
        console.log("This could mean:");
        console.log("1. ✅ RPC supports mempool but Base chain is quiet right now");
        console.log("2. ❌ RPC doesn't support mempool monitoring");
        console.log("3. 🔒 Mempool access requires premium subscription");
        console.log("\n💡 Try again during busier periods or check Alchemy settings");
      }
      process.exit(0);
    }, 5000);
    
  } catch (error) {
    console.error("❌ Mempool monitoring test failed:", error);
    console.log("\n💡 Your RPC might not support mempool monitoring.");
    console.log("Consider upgrading to:");
    console.log("- QuickNode: https://www.quicknode.com/");
    console.log("- Alchemy Pro: https://www.alchemy.com/");
  }
}

async function startMempoolBot() {
  console.log("❌ Full mempool bot not ready yet!");
  console.log("The liquidity venues and pricers need to be implemented first.");
  console.log("For now, you can only test mempool support with 'pnpm mempool:test'");
}

// 根据参数决定运行测试还是启动bot
const command = process.argv[2];

if (command === "test") {
  testMempoolSupport();
} else if (command === "start") {
  startMempoolBot();
} else {
  console.log("Usage:");
  console.log("  pnpm mempool:test  - Test if your RPC supports mempool monitoring");
  console.log("  pnpm mempool:start - Start the mempool liquidation bot");
}