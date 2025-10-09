import { chainConfig } from "@morpho-blue-liquidation-bot/config";
import { base } from "viem/chains";

async function testRawMempoolAccess() {
  const config = chainConfig(base.id);
  
  console.log("🔬 Testing raw mempool access methods...");
  console.log(`RPC: ${config.rpcUrl}`);
  
  // 方法1: 直接使用fetch测试eth_newPendingTransactionFilter
  console.log("\n📡 Method 1: Testing eth_newPendingTransactionFilter...");
  try {
    const response1 = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_newPendingTransactionFilter',
        params: [],
        id: 1
      })
    });
    
    const result1 = await response1.json();
    console.log("✅ eth_newPendingTransactionFilter response:", result1);
    
    if (result1.result) {
      const filterId = result1.result;
      console.log(`🎯 Filter created: ${filterId}`);
      
      // 等待一下，然后获取pending交易
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const response2 = await fetch(config.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getFilterChanges',
          params: [filterId],
          id: 2
        })
      });
      
      const result2 = await response2.json();
      console.log("📦 Pending transactions:", result2);
      
      if (result2.result && result2.result.length > 0) {
        console.log(`🎉 Success! Found ${result2.result.length} pending transactions`);
        console.log("✅ Your Alchemy supports mempool via eth_newPendingTransactionFilter");
      } else {
        console.log("⚠️  No pending transactions returned (might be timing)");
      }
    }
  } catch (error) {
    console.error("❌ Method 1 failed:", error);
  }
  
  // 方法2: 测试eth_getBlockByNumber with pending
  console.log("\n📡 Method 2: Testing eth_getBlockByNumber('pending')...");
  try {
    const response = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getBlockByNumber',
        params: ['pending', false],
        id: 3
      })
    });
    
    const result = await response.json();
    
    if (result.result && result.result.transactions) {
      console.log(`✅ Pending block has ${result.result.transactions.length} transactions`);
      if (result.result.transactions.length > 0) {
        console.log("🎉 Your Alchemy supports pending block access!");
        console.log("Sample pending tx:", result.result.transactions[0]);
      }
    } else {
      console.log("❌ No pending block data returned");
    }
  } catch (error) {
    console.error("❌ Method 2 failed:", error);
  }
  
  // 方法3: 尝试WebSocket订阅
  console.log("\n📡 Method 3: Testing WebSocket subscription...");
  try {
    const wsUrl = config.rpcUrl.replace('https://', 'wss://');
    console.log(`Connecting to: ${wsUrl}`);
    
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(wsUrl);
    
    let messageCount = 0;
    
    ws.on('open', () => {
      console.log("🔗 WebSocket connected");
      
      // 订阅pending transactions
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_subscribe',
        params: ['newPendingTransactions'],
        id: 1
      }));
      
      console.log("📨 Subscription request sent, waiting for responses...");
      
      // 10秒后关闭
      setTimeout(() => {
        ws.close();
        console.log(`\n📊 WebSocket test complete: received ${messageCount} messages`);
        if (messageCount > 1) {
          console.log("🎉 WebSocket mempool subscription works!");
        }
      }, 10000);
    });
    
    ws.on('message', (data) => {
      messageCount++;
      const message = JSON.parse(data.toString());
      
      if (messageCount === 1) {
        console.log("📨 Subscription response:", message);
      } else if (message.method === 'eth_subscription') {
        console.log(`📦 Pending TX: ${message.params.result}`);
      }
      
      if (messageCount > 5) {
        ws.close();
        console.log("\n🎉 WebSocket mempool is working! (stopped after 5 messages)");
      }
    });
    
    ws.on('error', (error) => {
      console.error("❌ WebSocket error:", error);
    });
    
  } catch (error) {
    console.error("❌ Method 3 failed:", error);
  }
}

testRawMempoolAccess();