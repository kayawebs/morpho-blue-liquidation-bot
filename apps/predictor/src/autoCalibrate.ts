import { pool } from './db.js';
import { loadConfig } from './config.js';
import { enrichEventsAt } from './enrich.js';
import { makeFetchWithProxy } from './utils/proxy.js';

function median(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  const arr = [...nums].sort((a, b) => a - b);
  const n = arr.length;
  const idx = n % 2 === 1 ? (n >> 1) : ((n >> 1) - 1);
  return arr[idx];
}
function percentile(nums: number[], p: number): number | undefined {
  if (nums.length === 0) return undefined;
  const arr = [...nums].sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * p)));
  return arr[idx];
}

async function fetchEvents(chainId: number, oracle: string, limit = 1000): Promise<{ ts: number; onchain: number }[]> {
  const { rows } = await pool.query(
    `SELECT extract(epoch from event_ts)::bigint AS ts, answer::float AS onchain
     FROM oracle_pred_samples WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)
     AND event_ts IS NOT NULL ORDER BY event_ts DESC LIMIT $3`,
    [chainId, oracle, limit],
  );
  return rows
    .map((r) => ({ ts: Number(r.ts), onchain: Number(r.onchain) }))
    .filter((x) => Number.isFinite(x.ts) && Number.isFinite(x.onchain) && x.onchain > 0);
}

async function fetchMedianAt(symbol: string, tsSec: number, source?: string): Promise<number | undefined> {
  const q = source
    ? `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::float AS p FROM cex_ticks WHERE symbol=$1 AND source=$2 AND ts BETWEEN to_timestamp($3-2) AND to_timestamp($3+2)`
    : `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::float AS p FROM cex_ticks WHERE symbol=$1 AND ts BETWEEN to_timestamp($2-2) AND to_timestamp($2+2)`;
  const params = source ? [symbol, source, tsSec] : [symbol, tsSec];
  const { rows } = await pool.query(q, params as any);
  const p = Number(rows[0]?.p);
  return Number.isFinite(p) ? p : undefined;
}

function combos<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  const n = arr.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const c: T[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) c.push(arr[i]!);
    out.push(c);
  }
  return out;
}

function weightGrids(keys: string[], step = 0.2): Record<string, number>[] {
  if (keys.length === 1) return [{ [keys[0]!]: 1 } as any];
  const out: Record<string, number>[] = [];
  const recurse = (i: number, remain: number, cur: number[]) => {
    if (i === keys.length - 1) {
      out.push(Object.fromEntries(keys.map((k, idx) => [k, idx === keys.length - 1 ? remain : cur[idx]!])));
      return;
    }
    for (let w = 0; w <= remain; w = +(w + step).toFixed(10)) {
      cur[i] = w;
      recurse(i + 1, +(remain - w).toFixed(10), cur);
    }
  };
  recurse(0, 1, Array(keys.length).fill(0));
  return out.filter((w) => Object.values(w).some((x) => x > 0));
}

function normalizeWeights(w: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [k, v] of Object.entries(w)) { const vv = Number(v); if (Number.isFinite(vv) && vv > 0) { out[k] = vv; sum += vv; } }
  if (sum <= 0) return out;
  for (const k of Object.keys(out)) out[k] = out[k]! / sum;
  return out;
}

async function fetchPrevConfig(chainId: number, addr: string): Promise<{ lag: number; lagMs: number; offset: number; hb: number; bias: number } | undefined> {
  const { rows } = await pool.query(
    `SELECT heartbeat_seconds, offset_bps, lag_seconds, lag_ms, COALESCE(bias_bps,0) AS bias_bps
     FROM oracle_pred_config WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)`,
    [chainId, addr],
  );
  if (rows.length === 0) return undefined;
  return { hb: Number(rows[0].heartbeat_seconds), offset: Number(rows[0].offset_bps), lag: Number(rows[0].lag_seconds), lagMs: Number(rows[0].lag_ms ?? 0), bias: Number(rows[0].bias_bps) };
}

async function fetchPrevWeights(chainId: number, addr: string): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `SELECT source, weight FROM oracle_cex_weights WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)`,
    [chainId, addr],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.source).toLowerCase()] = Number(r.weight);
  return out;
}

export async function runAutoCalibrateOnce() {
  const cfg = loadConfig();
  const oracles: any[] = (cfg as any).oracles ?? [];
  const sourcesAll = ['binance', 'okx', 'coinbase'];
  for (const o of oracles) {
    const chainId = Number(o.chainId);
    const addr = String(o.address);
    const symbol = String(o.symbol ?? 'BTCUSDC');
    const feedHb = Number(o.feedHeartbeatSeconds);
    const feedOffset = Number(o.feedDeviationBps);
    const prevCfg = await fetchPrevConfig(chainId, addr);
    const prevWeights = await fetchPrevWeights(chainId, addr);
    const alpha = 0.3; // EWMA smoothing factor
    // Heartbeat from event gaps
    const events = await fetchEvents(chainId, addr, 2000);
    const MAX_FIT_EVENTS = 120; // 固定最近事件窗口
    const fitEvents = events.slice(-MAX_FIT_EVENTS);
    console.log(`📊 calibrate using ${fitEvents.length}/${events.length} recent events for ${addr}`);
    const ts = fitEvents.map((e) => e.ts).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
    // Heartbeat: if feed-specified present, respect it; else compute
    const hb = Number.isFinite(feedHb) ? feedHb : Math.max(10, Math.round(median(gaps) ?? 60));
    // Fine lag search (ms) around previous lag using 100ms aggregated price
    async function priceAt100ms(symbol: string, tsMs: number): Promise<number | undefined> {
      const t = Math.floor(tsMs);
      const { rows } = await pool.query(
        `SELECT price FROM cex_agg_100ms WHERE symbol=$1 AND ts_ms <= $2 ORDER BY ts_ms DESC LIMIT 1`,
        [symbol, t],
      );
      if (rows.length > 0) return Number(rows[0].price);
      const { rows: rows2 } = await pool.query(
        `SELECT price FROM cex_agg_100ms WHERE symbol=$1 AND ts_ms BETWEEN $2 AND $3 ORDER BY ABS(ts_ms - $2) ASC LIMIT 1`,
        [symbol, t, t + 300],
      );
      if (rows2.length > 0) return Number(rows2[0].price);
      return undefined;
    }

    async function priceAt100msBySource(symbol: string, source: string, tsMs: number): Promise<number | undefined> {
      const t = Math.floor(tsMs);
      const { rows } = await pool.query(
        `SELECT price FROM cex_src_100ms WHERE symbol=$1 AND source=$2 AND ts_ms <= $3 ORDER BY ts_ms DESC LIMIT 1`,
        [symbol, source.toLowerCase(), t],
      );
      if (rows.length > 0) return Number(rows[0].price);
      const { rows: rows2 } = await pool.query(
        `SELECT price FROM cex_src_100ms WHERE symbol=$1 AND source=$2 AND ts_ms BETWEEN $3 AND $4 ORDER BY ABS(ts_ms - $3) ASC LIMIT 1`,
        [symbol, source.toLowerCase(), t, t + 300],
      );
      if (rows2.length > 0) return Number(rows2[0].price);
      return undefined;
    }
    const centerMs = Number.isFinite(prevCfg?.lagMs) && (prevCfg!.lagMs > 0) ? prevCfg!.lagMs : (Number.isFinite(prevCfg?.lag) ? prevCfg!.lag * 1000 : 1500);
    const lagMsList: number[] = [];
    for (let ms = Math.max(0, centerMs - 1500); ms <= Math.min(5000, centerMs + 1500); ms += 100) lagMsList.push(ms);
    if (lagMsList.length === 0) for (let ms = 0; ms <= 3000; ms += 100) lagMsList.push(ms);
    // Intelligent coverage: ensure 100ms points exist near t_event - lagGuess for recent events
    const lagGuess = Number.isFinite(prevCfg?.lagMs) && (prevCfg!.lagMs > 0) ? prevCfg!.lagMs : (Number.isFinite(prevCfg?.lag) ? prevCfg!.lag * 1000 : 1500);
    const checkWindowMs = 300;
    const gapTs: number[] = [];
    for (const e of fitEvents) {
      const t = e.ts * 1000 - lagGuess;
      const { rows: r1 } = await pool.query(`SELECT 1 FROM cex_agg_100ms WHERE symbol=$1 AND ts_ms BETWEEN $2 AND $3 LIMIT 1`, [symbol, Math.floor(t - checkWindowMs), Math.floor(t + checkWindowMs)]);
      const { rows: r2 } = await pool.query(`SELECT 1 FROM cex_src_100ms WHERE symbol=$1 AND ts_ms BETWEEN $2 AND $3 LIMIT 1`, [symbol, Math.floor(t - checkWindowMs), Math.floor(t + checkWindowMs)]);
      if (r1.length === 0 || r2.length === 0) gapTs.push(e.ts);
    }
    if (gapTs.length > 0) {
      try { const f = await makeFetchWithProxy(); await enrichEventsAt(chainId, addr, gapTs, 120, 10, f); } catch (e) { console.warn('coverage enrich failed:', e); }
    }

    let bestLag: { lagMs: number; p50: number; p90: number; used: number } | undefined;
    for (const lagMs of lagMsList) {
      const errs: number[] = [];
      let used = 0;
      for (const e of fitEvents) {
        const p = await priceAt100ms(symbol, e.ts * 1000 - lagMs);
        if (!(p && p > 0)) continue;
        const ratio = e.onchain / p;
        if (!Number.isFinite(ratio)) continue;
        const ebps = Math.round((ratio - 1) * 10_000);
        errs.push(Math.abs(ebps));
        used++;
      }
      {
      const required = Math.max(10, Math.floor(fitEvents.length * 0.25));
      if (errs.length < required) { console.warn(`lagMs ${lagMs}: have ${errs.length} < required ${required}`); continue; }
      }
      const p50 = median(errs) ?? Infinity;
      const p90 = percentile(errs, 0.9) ?? Infinity;
      const cand = { lagMs, p50, p90, used };
      if (!bestLag || p90 < bestLag.p90 || (p90 === bestLag.p90 && p50 < bestLag.p50)) bestLag = cand;
    }
    if (!bestLag) { console.warn('auto-calibrate: no bestLag found'); continue; }
    const lagRawSec = Math.round(bestLag.lagMs / 1000);
    const lags = [lagRawSec];
    const sources = sourcesAll.slice();
    // Evaluate per-exchange individual errors to rank sources
    const perExErrP90: Record<string, number> = {};
    for (const ex of sources) {
      const errs: number[] = [];
      for (const e of fitEvents) {
        const p = await fetchMedianAt(symbol, e.ts - (prevCfg?.lag ?? 0), ex);
        if (p === undefined) continue;
          const onchain = e.onchain;
        if (!Number.isFinite(onchain) || !(p > 0)) continue;
        const ratio = onchain / p;
        if (!Number.isFinite(ratio)) continue;
        errs.push(Math.abs(Math.round((ratio - 1) * 10_000)));
      }
      if (errs.length > 10) perExErrP90[ex] = percentile(errs, 0.9) ?? Infinity;
      else perExErrP90[ex] = Infinity;
    }
    const ranked = Object.entries(perExErrP90).sort((a,b)=>a[1]-b[1]).map(([k])=>k);
    const topSources = ranked.slice(0, Math.min(3, ranked.length));
    const subsetCombos = combos(topSources).filter((c) => c.length >= 1);
    // For each lag and subset, run a fine grid over weights to minimize p90 abs error
    // Precompute per-event per-exchange median prices at each lag to avoid repeated DB calls in weight loops
    const lagList = lags;
    const med: Record<string, Record<number, (number | undefined)[]>> = {};
    for (const ex of sources) {
      med[ex] = {} as any;
      for (const lag of lagList) med[ex][lag] = new Array(fitEvents.length).fill(undefined);
    }
    for (let i = 0; i < fitEvents.length; i++) {
      const e = fitEvents[i]!;
      for (const ex of sources) {
        for (const lag of lagList) {
          const p = await priceAt100msBySource(symbol, ex, (e.ts - lag) * 1000);
          med[ex][lag]![i] = p;
        }
      }
      if ((i + 1) % 50 === 0) console.log(`🔬 precompute medians: ${i + 1}/${fitEvents.length}`);
    }

    let best: any = undefined;
    for (const lag of lags) {
      for (const sub of subsetCombos) {
        const weightList = weightGrids(sub, 0.05); // finer grid
        for (const w of weightList) {
          const errsAbs: number[] = [];
          const errsSigned: number[] = [];
          for (let i = 0; i < fitEvents.length; i++) {
            let num = 0, den = 0; let ok = true;
            for (const ex of sub) { const p = med[ex][lag]![i]!; if (p === undefined) { ok = false; break; } const ww = w[ex] ?? 0; num += p * ww; den += ww; }
            if (!ok || den <= 0) continue;
            const pred = num / den;
            if (!(pred > 0)) continue;
            const onchain = fitEvents[i]!.onchain;
            if (!Number.isFinite(onchain)) continue;
            const ratio = onchain / pred;
            if (!Number.isFinite(ratio)) continue;
            const ebps = Math.round((ratio - 1) * 10_000);
            errsAbs.push(Math.abs(ebps));
            errsSigned.push(ebps);
          }
          if (errsAbs.length < 20) continue;
          const p50 = median(errsAbs) ?? Infinity;
          const p90 = percentile(errsAbs, 0.9) ?? Infinity;
          const bias = median(errsSigned) ?? 0; // signed median as bias
          const cand = { lag, sources: sub, weights: w, samples: errsAbs.length, p50, p90, bias };
          if (!best || p90 < best.p90 || (p90 === best.p90 && p50 < best.p50)) best = cand;
        }
        console.log(`🧪 evaluated subset=${sub.join('+')} lag=${lag} best_p90=${best?.p90}`);
      }
    }
    if (!best) continue;
    // Offset: if feed-specified present, respect it; else compute from residual p90 with floor
    const offsetRaw = Number.isFinite(feedOffset) ? feedOffset : Math.max(5, Math.round(best.p90));
    const biasRaw = Math.round(Number(best.bias ?? 0));
    const lagRaw = lagRawSec;
    // EWMA smoothing against previous config
    const lagSmoothed = prevCfg ? Math.round(alpha * lagRaw + (1 - alpha) * prevCfg.lag) : lagRaw;
    const lagSmoothedMs = prevCfg ? Math.round(alpha * bestLag.lagMs + (1 - alpha) * (prevCfg.lagMs || prevCfg.lag * 1000)) : bestLag.lagMs;
    const offsetSmoothed = prevCfg && !Number.isFinite(feedOffset)
      ? Math.round(alpha * offsetRaw + (1 - alpha) * prevCfg.offset)
      : offsetRaw;
    const biasSmoothed = prevCfg ? Math.round(alpha * biasRaw + (1 - alpha) * prevCfg.bias) : biasRaw;
    // Smooth weights with previous weights
    const newW = normalizeWeights(best.weights as Record<string, number>);
    const mergedSrcs = Array.from(new Set([...Object.keys(prevWeights), ...Object.keys(newW)]));
    const smoothW: Record<string, number> = {};
    for (const s of mergedSrcs) {
      const a = Number(newW[s] ?? 0);
      const b = Number(prevWeights[s] ?? 0);
      smoothW[s] = alpha * a + (1 - alpha) * b;
    }
    const weightsSmoothed = normalizeWeights(smoothW);
    // Persist results
    await pool.query(
      `INSERT INTO oracle_pred_config(chain_id, oracle_addr, heartbeat_seconds, offset_bps, bias_bps, decimals, scale_factor, lag_seconds, lag_ms, updated_at)
       VALUES($1,$2,$3,$4,$5, COALESCE((SELECT decimals FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), $6), COALESCE((SELECT scale_factor FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), $7), $8, $9, now())
       ON CONFLICT (chain_id, oracle_addr) DO UPDATE SET heartbeat_seconds=EXCLUDED.heartbeat_seconds, offset_bps=EXCLUDED.offset_bps, bias_bps=EXCLUDED.bias_bps, lag_seconds=EXCLUDED.lag_seconds, lag_ms=EXCLUDED.lag_ms, updated_at=now()`,
      [chainId, addr, hb, offsetSmoothed, biasSmoothed, Number(o.decimals), String(o.scaleFactor), lagSmoothed, lagSmoothedMs],
    );
    // Update weights table
    await pool.query('DELETE FROM oracle_cex_weights WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)', [chainId, addr]);
    for (const [src, w] of Object.entries(weightsSmoothed)) {
      await pool.query(
        `INSERT INTO oracle_cex_weights(chain_id, oracle_addr, source, weight) VALUES($1,$2,$3,$4)
         ON CONFLICT (chain_id, oracle_addr, source) DO UPDATE SET weight=EXCLUDED.weight, updated_at=now()`,
        [chainId, addr, src, w],
      );
    }
    console.log(`🔧 Auto-calibrated ${addr} on ${chainId}: hb=${hb}s, offset=${offsetSmoothed}bps, bias=${biasSmoothed}bps, lag=${lagSmoothed} (lagMs=${lagSmoothedMs}), weights=${JSON.stringify(weightsSmoothed)} (lagFitMs=${bestLag.lagMs}, samples=${best.samples}, p90=${best.p90}bps)`);
  }
}

export function startAutoCalibrateScheduler() {
  const MIN_INTERVAL_MS = 15 * 60_000; // 15分钟
  const MIN_NEW_EVENTS = 3; // 至少新增3条事件再触发
  const CHECK_MS = 60_000; // 每分钟检查一次
  let lastCal = 0;
  let lastCounts = new Map<string, number>();
  async function getCounts() {
    const { rows } = await pool.query(
      `SELECT chain_id, oracle_addr, COUNT(*)::int AS n FROM oracle_pred_samples GROUP BY chain_id, oracle_addr`
    );
    const m = new Map<string, number>();
    for (const r of rows) m.set(`${r.chain_id}:${String(r.oracle_addr).toLowerCase()}`, Number(r.n));
    return m;
  }
  async function tick() {
    try {
      const now = Date.now();
      const cur = await getCounts();
      if (lastCal === 0) { lastCal = now; lastCounts = cur; return; }
      let delta = 0;
      for (const [k, v] of cur) delta += Math.max(0, v - (lastCounts.get(k) ?? 0));
      const due = now - lastCal >= MIN_INTERVAL_MS;
      if (due && delta >= MIN_NEW_EVENTS) {
        console.log(`🛠️ auto-calibrate trigger: newEvents=${delta} since last run`);
        try { await runAutoCalibrateOnce(); } catch (e) { console.warn('auto-calibrate failed', e); }
        lastCal = Date.now();
        lastCounts = cur;
      }
    } catch (e) { /* noop */ }
  }
  setInterval(tick, CHECK_MS);
}
