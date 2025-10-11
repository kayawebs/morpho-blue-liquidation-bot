import { BinanceClient, OkxClient, CoinbaseProClient, Trade, Market } from 'ccxws';
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
    const binance = enabled.has('binance') ? new BinanceClient() : undefined;
    const okx = enabled.has('okx') ? new OkxClient() : undefined;
    const coinbase = enabled.has('coinbase') ? new CoinbaseProClient() : undefined;
    if (binance) this.clients.push(binance);
    if (okx) this.clients.push(okx);
    if (coinbase) this.clients.push(coinbase);

    const subscribe = (client: any, source: string, m: Market, norm: string) => {
      const onTrade = (t: Trade) => {
        const price = Number(t.price);
        if (!Number.isFinite(price)) return;
        this.onTick({ ts: t.unix, price, source, symbol: norm });
      };
      client.on('trade', onTrade);
      client.subscribeTrades(m);
    };

    for (const p of this.cfg.pairs) {
      const norm = p.symbol;
      if (binance && p.binance) subscribe(binance, 'binance', { id: p.binance, base: 'BTC', quote: 'USDC', type: 'spot' } as any, norm);
      if (okx && p.okx) subscribe(okx, 'okx', { id: p.okx, base: 'BTC', quote: 'USDC', type: 'spot' } as any, norm);
      if (coinbase && p.coinbase) subscribe(coinbase, 'coinbase', { id: p.coinbase, base: 'BTC', quote: 'USDC', type: 'spot' } as any, norm);
    }
  }

  stop() {
    for (const c of this.clients) {
      try { c.close(); } catch {}
    }
    this.clients = [];
  }
}
