import { loadConfig } from '../config.js';
import { makeFetchWithProxy } from '../utils/proxy.js';

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
    const f = await makeFetchWithProxy();
    for (const p of cfg.pairs) {
      const norm = p.symbol;
      if (p.binance) this.poll(f, 'binance', norm, p.binance);
      if (p.okx) this.poll(f, 'okx', norm, p.okx);
      if (p.coinbase) this.poll(f, 'coinbase', norm, p.coinbase);
      if ((p as any).kraken) this.poll(f, 'kraken', norm, (p as any).kraken as string);
      if ((p as any).bitstamp) this.poll(f, 'bitstamp', norm, (p as any).bitstamp as string);
      if ((p as any).bybit) this.poll(f, 'bybit', norm, (p as any).bybit as string);
      if ((p as any).gemini) this.poll(f, 'gemini', norm, (p as any).gemini as string);
      if ((p as any).bitfinex) this.poll(f, 'bitfinex', norm, (p as any).bitfinex as string);
    }
  }

  private poll(fetchImpl: typeof fetch, exchange: string, normSymbol: string, exSymbol: string) {
    const url = this.buildUrl(exchange, exSymbol);
    if (!url) return;
    const run = async () => {
      try {
        const res = await fetchImpl(url, { headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0' } });
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
      case 'kraken':
        return `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(symbol)}`;
      case 'bitstamp':
        return `https://www.bitstamp.net/api/v2/ticker/${encodeURIComponent(symbol)}/`;
      case 'bybit':
        return `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`;
      case 'gemini':
        return `https://api.gemini.com/v1/pubticker/${encodeURIComponent(symbol)}`;
      case 'bitfinex':
        return `https://api-pub.bitfinex.com/v2/ticker/${encodeURIComponent(symbol)}`;
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
      case 'kraken':
        try {
          const res = data?.result;
          const key = res && Object.keys(res)[0];
          const t = key && res[key];
          // prefer mid of ask/bid
          const a = Number(t?.a?.[0]);
          const b = Number(t?.b?.[0]);
          if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
          const c = Number(t?.c?.[0]);
          if (Number.isFinite(c)) return c;
          return undefined;
        } catch { return undefined; }
      case 'bitstamp':
        {
          const bid = Number(data?.bid);
          const ask = Number(data?.ask);
          if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
          const last = Number(data?.last);
          if (Number.isFinite(last)) return last;
          return undefined;
        }
      case 'bybit':
        try {
          const arr = data?.result?.list;
          const d = Array.isArray(arr) && arr[0];
          const last = Number(d?.lastPrice);
          const ask = Number(d?.ask1Price);
          const bid = Number(d?.bid1Price);
          if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
          if (Number.isFinite(last)) return last;
          return undefined;
        } catch { return undefined; }
      case 'gemini':
        {
          const bid = Number(data?.bid);
          const ask = Number(data?.ask);
          if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
          const last = Number(data?.last);
          if (Number.isFinite(last)) return last;
          const price = Number(data?.price);
          if (Number.isFinite(price)) return price;
          return undefined;
        }
      case 'bitfinex':
        try {
          if (Array.isArray(data)) {
            const bid = Number(data[0]);
            const ask = Number(data[2]);
            const last = Number(data[6]);
            if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
            if (Number.isFinite(last)) return last;
            return undefined;
          }
          return undefined;
        } catch { return undefined; }
      default:
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
}
