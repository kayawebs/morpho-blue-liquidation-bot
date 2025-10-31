import { pool } from './db.js';
import { loadConfig } from './config.js';
import { insertTick } from './db.js';
import { makeFetchWithProxy } from './utils/proxy.js';

async function hasExistingData(symbol: string): Promise<boolean> {
  const { rows: r1 } = await pool.query('SELECT 1 FROM cex_agg_100ms WHERE symbol=$1 LIMIT 1', [symbol]);
  if (r1.length > 0) return true;
  const { rows: r2 } = await pool.query('SELECT 1 FROM cex_ticks WHERE symbol=$1 LIMIT 1', [symbol]);
  return r2.length > 0;
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

type Candle = { startSec: number; close: number };

async function fetchBinanceCandles(fetchImpl: typeof fetch, symbol: string, minutes: number): Promise<Candle[]> {
  const limit = Math.min(1200, Math.max(1, minutes));
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=${limit}`;
  const res = await fetchImpl(url, { headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  const out: Candle[] = [];
  for (const k of data) {
    const openTimeMs = Number(k?.[0]);
    const close = Number(k?.[4]);
    if (!Number.isFinite(openTimeMs) || !Number.isFinite(close)) continue;
    out.push({ startSec: Math.floor(openTimeMs / 1000), close });
  }
  return out;
}

async function fetchOkxCandles(fetchImpl: typeof fetch, instId: string, minutes: number): Promise<Candle[]> {
  const limit = Math.min(300, Math.max(1, minutes));
  const url = `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=1m&limit=${limit}`;
  const res = await fetchImpl(url, { headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) return [];
  const json = await res.json();
  const data = json?.data;
  if (!Array.isArray(data)) return [];
  const out: Candle[] = [];
  for (const k of data) {
    // OKX returns [ts, o, h, l, c, ...], ts in ms
    const tsMs = Number(k?.[0]);
    const close = Number(k?.[4]);
    if (!Number.isFinite(tsMs) || !Number.isFinite(close)) continue;
    out.push({ startSec: Math.floor(tsMs / 1000), close });
  }
  // OKX returns newest first, normalize ascending by time
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

async function fetchCoinbaseCandles(fetchImpl: typeof fetch, productId: string, minutes: number): Promise<Candle[]> {
  const limit = Math.min(300, Math.max(1, minutes));
  const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/candles?granularity=60&limit=${limit}`;
  const res = await fetchImpl(url, { headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  const out: Candle[] = [];
  for (const k of data) {
    // Coinbase returns [ time, low, high, open, close, volume ]
    const t = Number(k?.[0]);
    const close = Number(k?.[4]);
    if (!Number.isFinite(t) || !Number.isFinite(close)) continue;
    out.push({ startSec: t, close });
  }
  // Coinbase returns newest first
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

async function expandAndInsert(source: string, normSymbol: string, candles: Candle[]) {
  for (const c of candles) {
    const base = c.startSec;
    const p = c.close;
    // expand each minute candle into 60 per-second ticks to satisfy ±2s windows
    for (let s = 0; s < 60; s++) {
      const ts = (base + s) * 1000;
      await insertTick(source, normSymbol, ts, p);
    }
  }
}

export async function runBackfillIfNeeded() {
  const cfg = loadConfig();
  const fetchImpl = await makeFetchWithProxy();
  if (process.env.PREDICTOR_DISABLE_BACKFILL === '1') {
    console.log('⏭️  Backfill disabled via PREDICTOR_DISABLE_BACKFILL=1');
    return;
  }
  const backfillMinutes = Number(process.env.PREDICTOR_BACKFILL_MINUTES ?? 90); // backfill N minutes of 1m candles

  async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: any;
    const delays = [500, 1200, 2500];
    for (let i = 0; i < delays.length; i++) {
      try { return await fn(); } catch (e) { lastErr = e; await sleep(delays[i]!); }
    }
    throw Object.assign(new Error(`${label} failed: ${(lastErr as any)?.message ?? lastErr}`), { cause: lastErr });
  }
  for (const p of cfg.pairs) {
    const norm = p.symbol;
    // New policy: only backfill if there is NO existing data for this symbol in DB
    if (await hasExistingData(norm)) {
      console.log(`↩️  Skip backfill for ${norm}: existing DB rows found`);
      continue;
    }
    console.log(`🧩 Backfilling CEX ticks for ${norm} (~${backfillMinutes}m)…`);
    try {
      if (p.binance) {
        const candles = await withRetry(`binance klines ${p.binance}`, () => fetchBinanceCandles(fetchImpl, p.binance, backfillMinutes));
        await expandAndInsert('binance', norm, candles);
        await sleep(200);
      }
      if (p.okx) {
        const candles = await withRetry(`okx candles ${p.okx}`, () => fetchOkxCandles(fetchImpl, p.okx, backfillMinutes));
        await expandAndInsert('okx', norm, candles);
        await sleep(200);
      }
      if (p.coinbase) {
        const candles = await withRetry(`coinbase candles ${p.coinbase}`, () => fetchCoinbaseCandles(fetchImpl, p.coinbase, backfillMinutes));
        await expandAndInsert('coinbase', norm, candles);
        await sleep(200);
      }
      console.log(`✅ Backfill complete for ${norm}`);
    } catch (e) {
      const err: any = e;
      console.warn(`⚠️ Backfill failed for ${norm}: ${err?.message ?? err}`);
      if (err?.cause) console.warn(`   cause: ${err.cause?.message ?? String(err.cause)}`);
    }
  }
}
