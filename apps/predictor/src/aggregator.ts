import { loadConfig } from './config.js';

type Tick = { ts: number; price: number; source: string };

export class PriceAggregator {
  private windowMs: number;
  private trimRatio: number;
  private minExchanges: number;
  private weights: Record<string, number>;
  private book: Map<string, Tick[]> = new Map();

  constructor(windowMs = 3000, trimRatio = 0.2, minExchanges = 2, weights: Record<string, number> = {}) {
    this.windowMs = windowMs;
    this.trimRatio = trimRatio;
    this.minExchanges = minExchanges;
    this.weights = weights;
  }

  push(symbol: string, t: Tick) {
    const arr = this.book.get(symbol) ?? [];
    arr.push(t);
    const cutoff = Date.now() - this.windowMs;
    // prune
    while (arr.length && arr[0]!.ts < cutoff) arr.shift();
    this.book.set(symbol, arr);
  }

  private median(values: number[]): number | undefined {
    if (values.length === 0) return undefined;
    const arr = [...values].sort((a, b) => a - b);
    const n = arr.length;
    const idx = n % 2 === 1 ? (n >> 1) : ((n >> 1) - 1);
    return arr[idx];
  }

  // Robust aggregated price: per-exchange median -> merge by trimmed mean / weighted median
  aggregated(symbol: string): { price?: number; count: number; sources: Record<string, number> } {
    const now = Date.now();
    const ticks = (this.book.get(symbol) ?? []).filter((t) => t.ts >= now - this.windowMs);
    const bySource = new Map<string, number[]>();
    for (const t of ticks) {
      const key = t.source.toLowerCase();
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key)!.push(t.price);
    }
    const sourcePrice: Record<string, number> = {};
    for (const [src, arr] of bySource) {
      const m = this.median(arr);
      if (m !== undefined) sourcePrice[src] = m;
    }
    const entries = Object.entries(sourcePrice);
    if (entries.length < this.minExchanges) return { price: undefined, count: entries.length, sources: sourcePrice };
    // Trim extremes
    const vals = entries.map(([s, p]) => p).sort((a, b) => a - b);
    const trimN = Math.floor(vals.length * this.trimRatio);
    const trimmed = vals.slice(trimN, vals.length - trimN || undefined);
    // Weighted median or simple median after trim
    // Simplify: median of trimmed
    const price = this.median(trimmed);
    return { price, count: entries.length, sources: sourcePrice };
  }

  // Return current per-source medians within the window (no trimming/merge)
  perSourceMedians(symbol: string): Record<string, number> {
    const now = Date.now();
    const ticks = (this.book.get(symbol) ?? []).filter((t) => t.ts >= now - this.windowMs);
    const bySource = new Map<string, number[]>();
    for (const t of ticks) {
      const key = t.source.toLowerCase();
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key)!.push(t.price);
    }
    const out: Record<string, number> = {};
    for (const [src, arr] of bySource) {
      const m = this.median(arr);
      if (m !== undefined) out[src] = m;
    }
    return out;
  }

  stats(symbol: string) {
    const arr = this.book.get(symbol) ?? [];
    const ag = this.aggregated(symbol);
    return { count: arr.length, sources: ag.sources, windowMs: this.windowMs, aggregatedPrice: ag.price };
  }
}
