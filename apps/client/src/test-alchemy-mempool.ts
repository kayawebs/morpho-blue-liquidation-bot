import { chainConfig } from "@morpho-blue-liquidation-bot/config";
import { base } from "viem/chains";
import { createPublicClient, http } from "viem";
import { AlchemyMempoolMonitor } from "./mempool/AlchemyMempoolMonitor.js";

async function testAlchemyMempool() {
  const config = chainConfig(base.id);
  
  console.log("🧪 Testing Alchemy mempool via pending block method...");
  
  const client = createPublicClient({
    chain: base,
    transport: http(config.rpcUrl),
  });
  
  // Base预言机地址
  const oracleAddresses = new Set([
    "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70".toLowerCase(), // ETH/USD
    // 可以添加更多预言机地址
  ]);
  
  const monitor = new AlchemyMempoolMonitor({
    client: client as any,
    morphoAddress: config.morpho.address,
    oracleAddresses,
    pollingInterval: 200, // 200ms轮询
    onPendingTransaction: async (txHash, tx) => {
      console.log(`\n🎯 RELEVANT PENDING TX DETECTED:`);
      console.log(`   Hash: ${txHash}`);
      console.log(`   To: ${tx.to}`);
      console.log(`   Value: ${tx.value} wei`);
      console.log(`   Gas: ${tx.gas}`);
      console.log(`   GasPrice: ${tx.gasPrice} wei`);
      
      if (tx.input && tx.input.length > 10) {
        console.log(`   Function: ${tx.input.slice(0, 10)}`);
      }
    },
  });
  
  // 显示初始状态
  const initialStats = await monitor.getPendingStats();
  console.log(`📊 Initial pending pool: ${initialStats.totalPendingTxs} transactions`);
  
  // 启动监控
  await monitor.start();
  
  // 定期显示统计
  const statsInterval = setInterval(async () => {
    const stats = await monitor.getPendingStats();
    console.log(`📊 Pool stats: ${stats.totalPendingTxs} total, ${stats.seenTxs} seen`);
  }, 5000);
  
  // 运行30秒后停止
  setTimeout(() => {
    monitor.stop();
    clearInterval(statsInterval);
    console.log("\n✅ Alchemy mempool test completed!");
    console.log("🎉 If you saw relevant transactions, mempool monitoring is working!");
    process.exit(0);
  }, 30000);
  
  console.log("⏳ Monitoring for 30 seconds...");
  console.log("💡 Look for oracle price updates, Morpho transactions, or large transfers");
}

testAlchemyMempool().catch(console.error);