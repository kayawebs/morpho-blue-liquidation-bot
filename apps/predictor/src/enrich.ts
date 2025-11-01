import { pool } from './db.js';
import { loadConfig } from './config.js';

type Trade = { ts: number; price: number };

export async function fetchBinanceTrades(fetchImpl: typeof fetch, symbol: string, startMs: number, endMs: number): Promise<Trade[]> {
  const out: Trade[] = [];
  const step = 60_000;
  for (let t = startMs; t < endMs; t += step) {
    const s = t; const e = Math.min(endMs, t + step - 1);
    const url = `https://api.binance.com/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&startTime=${s}&endTime=${e}&limit=1000`;
    const res = await fetchImpl(url, { headers: { 'accept': 'application/json', 'user-agent': 'MBLB/1.0' } });
    if (!res.ok) continue;
    const data = await res.json();
    if (!Array.isArray(data)) continue;
    for (const tr of data) {
      const ts = Number(tr.T); const p = Number(tr.p);
      if (Number.isFinite(ts) && Number.isFinite(p)) out.push({ ts, price: p });
    }
    await new Promise(r=>setTimeout(r, 200));
  }
  return out;
}

export async function fetchOkxTrades(fetchImpl: typeof fetch, instId: string, startMs: number, endMs: number): Promise<Trade[]> {
  const out: Trade[] = [];
  let after: string | undefined = undefined;
  let guard = 0;
  while (guard++ < 50) {
    const url = new URL('https://www.okx.com/api/v5/market/trades');
    url.searchParams.set('instId', instId);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const res = await fetchImpl(url.toString(), { headers: { 'accept': 'application/json', 'user-agent': 'MBLB/1.0' } });
    if (!res.ok) break;
    const json = await res.json();
    const data: any[] = json?.data ?? [];
    if (data.length === 0) break;
    for (const d of data) {
      // OKX trade item: [instId, px, sz, side, ts]
      const ts = Number(d[4] ?? d.ts ?? d.time);
      const p = Number(d[1] ?? d.px ?? d.price);
      if (Number.isFinite(ts) && Number.isFinite(p)) {
        if (ts < startMs) return out; // reached before window
        if (ts <= endMs) out.push({ ts, price: p });
      }
    }
    const last = data[data.length - 1];
    const lastTs = Number(last?.[4] ?? last?.ts);
    after = String(lastTs);
    await new Promise(r=>setTimeout(r, 200));
  }
  return out;
}

export async function fetchCoinbaseTrades(fetchImpl: typeof fetch, productId: string, startMs: number, endMs: number): Promise<Trade[]> {
  const out: Trade[] = [];
  let before: string | undefined;
  let guard = 0;
  while (guard++ < 200) {
    const url = new URL(`https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/trades`);
    if (before) url.searchParams.set('before', before);
    const res = await fetchImpl(url.toString(), { headers: { 'accept': 'application/json', 'user-agent': 'MBLB/1.0' } });
    if (!res.ok) break;
    const data: any[] = await res.json();
    if (data.length === 0) break;
    for (const d of data) {
      const iso = d.time as string; const ts = Date.parse(iso);
      const p = Number(d.price);
      if (Number.isFinite(ts) && Number.isFinite(p)) {
        if (ts < startMs) return out;
        if (ts <= endMs) out.push({ ts, price: p });
      }
    }
    before = String(data[0]?.trade_id ?? data[0]?.sequence ?? '');
    await new Promise(r=>setTimeout(r, 150));
  }
  return out;
}

export function binTradesTo100ms(trades: Trade[], startMs: number, endMs: number): Map<number, number> {
  const map = new Map<number, number[]>();
  for (const tr of trades) {
    if (tr.ts < startMs || tr.ts > endMs) continue;
    const b = tr.ts - (tr.ts % 100);
    if (!map.has(b)) map.set(b, []);
    map.get(b)!.push(tr.price);
  }
  const out = new Map<number, number>();
  for (const [k, arr] of map) {
    arr.sort((a,b)=>a-b);
    const m = arr[Math.floor((arr.length-1)/2)];
    out.set(k, m);
  }
  return out;
}

async function upsertSrc(symbol: string, source: string, bins: Map<number, number>) {
  for (const [ts, price] of bins) {
    await pool.query(
      `INSERT INTO cex_src_100ms(symbol, source, ts_ms, price) VALUES($1,$2,$3,$4)
       ON CONFLICT (symbol, source, ts_ms) DO UPDATE SET price=EXCLUDED.price`,
      [symbol, source.toLowerCase(), Math.floor(ts), price],
    );
  }
}

async function upsertAgg(symbol: string, tsMs: number, prices: number[]) {
  if (prices.length === 0) return;
  prices.sort((a,b)=>a-b);
  const trim = Math.floor(prices.length * 0.2);
  const arr = prices.slice(trim, prices.length - (trim || 0));
  const price = arr[Math.floor((arr.length-1)/2)] ?? prices[Math.floor((prices.length-1)/2)];
  await pool.query(
    `INSERT INTO cex_agg_100ms(symbol, ts_ms, price) VALUES($1,$2,$3)
     ON CONFLICT (symbol, ts_ms) DO UPDATE SET price=EXCLUDED.price`,
    [symbol, Math.floor(tsMs), price],
  );
}

export async function enrichEvents(chainId: number, oracle: string, limit = 100, windowSec = 120, aheadSec = 10, fetchImpl?: typeof fetch) {
  const cfg = loadConfig();
  const pair = (cfg.pairs ?? [])[0];
  const symbol = String(pair?.symbol || 'BTCUSDC');
  const binanceSym = pair?.binance;
  const okxInst = pair?.okx;
  const coinbaseProd = pair?.coinbase;
  const f = fetchImpl ?? (globalThis.fetch.bind(globalThis));
  const { rows } = await pool.query(
    `SELECT extract(epoch from event_ts)::bigint AS ts
     FROM oracle_pred_samples WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)
     AND event_ts IS NOT NULL ORDER BY event_ts DESC LIMIT $3`,
    [chainId, oracle, limit],
  );
  const events = rows.map((r:any)=>Number(r.ts)).filter((x)=>Number.isFinite(x)).sort((a,b)=>a-b);
  console.log(`enrich ${events.length} events for ${symbol}`);
  for (const tsSec of events) {
    const startMs = (tsSec - windowSec) * 1000;
    const endMs = (tsSec + aheadSec) * 1000;
    const per: Record<string, Map<number, number>> = {};
    try {
      if (binanceSym) per['binance'] = binTradesTo100ms(await fetchBinanceTrades(f, binanceSym, startMs, endMs), startMs, endMs);
    } catch (e) { console.warn('binance enrich failed:', (e as any)?.message ?? e); }
    try {
      if (okxInst) per['okx'] = binTradesTo100ms(await fetchOkxTrades(f, okxInst, startMs, endMs), startMs, endMs);
    } catch (e) { console.warn('okx enrich failed:', (e as any)?.message ?? e); }
    try {
      if (coinbaseProd) per['coinbase'] = binTradesTo100ms(await fetchCoinbaseTrades(f, coinbaseProd, startMs, endMs), startMs, endMs);
    } catch (e) { console.warn('coinbase enrich failed:', (e as any)?.message ?? e); }
    // upsert per-source first
    for (const [src, bins] of Object.entries(per)) await upsertSrc(symbol, src, bins);
    // merge per ts
    const tsSet = new Set<number>();
    for (const bins of Object.values(per)) for (const t of bins.keys()) tsSet.add(t);
    const times = Array.from(tsSet.values()).sort((a,b)=>a-b);
    for (const t of times) {
      const prices: number[] = [];
      for (const bins of Object.values(per)) { const v = bins.get(t); if (typeof v === 'number') prices.push(v); }
      await upsertAgg(symbol, t, prices);
    }
    await new Promise(r=>setTimeout(r, 200));
  }
}

