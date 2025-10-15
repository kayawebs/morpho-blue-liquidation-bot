import { loadConfig } from '../config.js';

type Handler = (p: { ts: number; price: number; source: string; symbol: string }) => void;

export class HttpPollConnector {
  private onTick: Handler;
  private intervalMs: number;

  constructor(onTick: Handler, intervalMs = 1000) {
    this.onTick = onTick;
    this.intervalMs = intervalMs;
  }

  async start() {
    const cfg = loadConfig();
    for (const p of cfg.pairs) {
      const norm = p.symbol;
      if (p.binance) this.poll('binance', norm, p.binance);
      if (p.okx) this.poll('okx', norm, p.okx);
      if (p.coinbase) this.poll('coinbase', norm, p.coinbase);
    }
  }

  private poll(exchange: string, normSymbol: string, exSymbol: string) {
    const url = this.buildUrl(exchange, exSymbol);
    if (!url) return;
    const run = async () => {
      try {
        const res = await fetch(url, { headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0' } });
        if (!res.ok) return;
        const data = await res.json();
        const price = this.parsePrice(exchange, data);
        if (price && isFinite(price)) {
          this.onTick({ ts: Date.now(), price, source: exchange, symbol: normSymbol });
        }
      } catch {}
    };
    // initial and interval
    void run();
    setInterval(run, this.intervalMs);
  }

  private buildUrl(exchange: string, symbol: string): string | undefined {
    switch (exchange) {
      case 'binance':
        return `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
      case 'okx':
        return `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`;
      case 'coinbase':
        return `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/ticker`;
      default:
        return undefined;
    }
  }

  private parsePrice(exchange: string, data: any): number | undefined {
    try {
      switch (exchange) {
        case 'binance':
          return Number(data?.price);
        case 'okx':
          return Number(data?.data?.[0]?.last);
        case 'coinbase':
          {
            const p1 = Number(data?.price);
            if (Number.isFinite(p1)) return p1;
            const p2 = Number(data?.last);
            if (Number.isFinite(p2)) return p2;
            return undefined;
          }
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }
}
