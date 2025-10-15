import ccxws from 'ccxws';
import { loadConfig } from '../config.js';

type Handler = (p: { ts: number; price: number; source: string; symbol: string }) => void;

export class MultiCexConnector {
  private onTick: Handler;
  private clients: any[] = [];
  private cfg = loadConfig();

  constructor(onTick: Handler) {
    this.onTick = onTick;
  }

  async start() {
    const enabled = new Set(this.cfg.exchanges.map((e) => e.toLowerCase()));
    const { BinanceClient, CoinbaseProClient } = ccxws as any;
    const OkxCtor = (ccxws as any).OkexClient ?? (ccxws as any).OkxClient; // ccxws historically exported OkexClient
    const binance = enabled.has('binance') && BinanceClient ? new BinanceClient() : undefined;
    const okx = enabled.has('okx') && OkxCtor ? new OkxCtor() : undefined;
    const coinbase = enabled.has('coinbase') && CoinbaseProClient ? new CoinbaseProClient() : undefined;
    if (binance) this.clients.push(binance);
    if (okx) this.clients.push(okx);
    if (coinbase) this.clients.push(coinbase);

    const attachLifecycle = (client: any, source: string) => {
      client.on('connected', () => console.log(`🔌 [${source}] connected`));
      client.on('reconnected', () => console.log(`🔁 [${source}] reconnected`));
      client.on('disconnected', () => console.warn(`⚠️ [${source}] disconnected`));
      client.on('error', (e: any) => console.warn(`⚠️ [${source}] error: ${e?.message ?? e}`));
    };

    const subscribe = (client: any, source: string, m: any, norm: string) => {
      const onTrade = (t: any) => {
        const price = Number(t.price);
        if (!Number.isFinite(price)) return;
        this.onTick({ ts: t.unix, price, source, symbol: norm });
      };
      client.on('trade', onTrade);
      client.subscribeTrades(m);
    };

    for (const p of this.cfg.pairs) {
      const norm = p.symbol;
      if (binance && p.binance) {
        attachLifecycle(binance, 'binance');
        subscribe(binance, 'binance', { id: p.binance, base: 'BTC', quote: 'USDC', type: 'spot' }, norm);
      }
      if (okx && p.okx) {
        attachLifecycle(okx, 'okx');
        subscribe(okx, 'okx', { id: p.okx, base: 'BTC', quote: 'USDC', type: 'spot' }, norm);
      }
      if (coinbase && p.coinbase) {
        attachLifecycle(coinbase, 'coinbase');
        subscribe(coinbase, 'coinbase', { id: p.coinbase, base: 'BTC', quote: 'USDC', type: 'spot' }, norm);
      }
    }
  }

  stop() {
    for (const c of this.clients) {
      try { c.close(); } catch {}
    }
    this.clients = [];
  }
}
