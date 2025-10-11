import WebSocket from 'ws';
import { initSchema, insertTick } from '../db.js';

// Minimal Binance spot trades stream for BTCUSDC
const WS_URL = 'wss://stream.binance.com:9443/ws/btcusdc@trade';

async function main() {
  await initSchema();
  console.log('📡 Binance connector starting (BTCUSDC)');
  const ws = new WebSocket(WS_URL);
  ws.on('open', () => console.log('🔌 Binance WS connected'));
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // trade payload: { e: 'trade', E: event time, p: price }
      const ts = Number(msg.E ?? Date.now());
      const price = Number(msg.p);
      if (!Number.isFinite(price)) return;
      await insertTick('binance', 'BTCUSDC', ts, price);
    } catch {}
  });
  ws.on('error', (err) => console.error('❌ Binance WS error:', err));
  ws.on('close', () => console.warn('⚠️ Binance WS closed'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

