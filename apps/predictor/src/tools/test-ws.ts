import "../env.js";
import WebSocket from 'ws';
import { buildWsProxyAgent, describeSelectedProxy } from '../utils/proxy.js';

const WS_URL = 'wss://stream.binance.com:9443/ws/btcusdc@trade';

async function main() {
  console.log(`🔍 Testing WS connectivity to ${WS_URL}`);
  const agent = buildWsProxyAgent(WS_URL);
  if (agent) {
    console.log(`🌐 Using proxy for WS: ${describeSelectedProxy(WS_URL)}`);
  } else {
    console.log('🌐 No proxy configured for WS');
  }
  const ws = new WebSocket(WS_URL, { agent: agent as any });

  const timer = setTimeout(() => {
    console.error('⏰ Timeout waiting for WS open');
    ws.close();
    process.exit(1);
  }, 10000);

  ws.on('open', () => {
    clearTimeout(timer);
    console.log('✅ WS connected successfully');
    ws.close();
  });
  ws.on('error', (err) => {
    clearTimeout(timer);
    console.error('❌ WS error:', err?.message ?? err);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
