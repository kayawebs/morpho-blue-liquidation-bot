import { pool } from './db.js';
import { loadConfig } from './config.js';
import { insertTick } from './db.js';
import { makeFetchWithProxy } from './utils/proxy.js';

async function latestTimestampSec(symbol: string): Promise<number | undefined> {
  const { rows } = await pool.query('SELECT EXTRACT(EPOCH FROM MAX(ts))::bigint AS t FROM cex_ticks WHERE symbol=$1', [symbol]);
  const t = Number(rows[0]?.t);
  return Number.isFinite(t) ? t : undefined;
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
  const nowSec = Math.floor(Date.now() / 1000);
  const staleThresholdSec = 10 * 60; // 10 minutes
  const backfillMinutes = 90; // backfill 90 minutes of 1m candles
  for (const p of cfg.pairs) {
    const norm = p.symbol;
    const latest = await latestTimestampSec(norm);
    if (latest && nowSec - latest < staleThresholdSec) {
      continue; // fresh enough
    }
    console.log(`🧩 Backfilling CEX ticks for ${norm} (~${backfillMinutes}m)…`);
    try {
      if (p.binance) {
        const candles = await fetchBinanceCandles(fetchImpl, p.binance, backfillMinutes);
        await expandAndInsert('binance', norm, candles);
        await sleep(200);
      }
      if (p.okx) {
        const candles = await fetchOkxCandles(fetchImpl, p.okx, backfillMinutes);
        await expandAndInsert('okx', norm, candles);
        await sleep(200);
      }
      if (p.coinbase) {
        const candles = await fetchCoinbaseCandles(fetchImpl, p.coinbase, backfillMinutes);
        await expandAndInsert('coinbase', norm, candles);
        await sleep(200);
      }
      console.log(`✅ Backfill complete for ${norm}`);
    } catch (e) {
      console.warn(`⚠️ Backfill failed for ${norm}: ${(e as Error).message}`);
    }
  }
}

