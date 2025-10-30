import { pool } from './db.js';
import { loadConfig } from './config.js';

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

async function fetchEvents(chainId: number, oracle: string, limit = 1000): Promise<{ ts: number }[]> {
  const { rows } = await pool.query(
    `SELECT extract(epoch from event_ts)::bigint AS ts
     FROM oracle_pred_samples WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)
     AND event_ts IS NOT NULL ORDER BY event_ts DESC LIMIT $3`,
    [chainId, oracle, limit],
  );
  return rows.map((r) => ({ ts: Number(r.ts) })).filter((x) => Number.isFinite(x.ts));
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

async function fetchPrevConfig(chainId: number, addr: string): Promise<{ lag: number; offset: number; hb: number; bias: number } | undefined> {
  const { rows } = await pool.query(
    `SELECT heartbeat_seconds, offset_bps, lag_seconds, COALESCE(bias_bps,0) AS bias_bps
     FROM oracle_pred_config WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)`,
    [chainId, addr],
  );
  if (rows.length === 0) return undefined;
  return { hb: Number(rows[0].heartbeat_seconds), offset: Number(rows[0].offset_bps), lag: Number(rows[0].lag_seconds), bias: Number(rows[0].bias_bps) };
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
    const ts = events.map((e) => e.ts).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
    // Heartbeat: if feed-specified present, respect it; else compute
    const hb = Number.isFinite(feedHb) ? feedHb : Math.max(10, Math.round(median(gaps) ?? 60));
    // Candidate lags: include previous around ±1s plus coarse
    const lagSet = new Set<number>([0,1,2,3,5,7,10]);
    if (prevCfg && Number.isFinite(prevCfg.lag)) { lagSet.add(prevCfg.lag); lagSet.add(prevCfg.lag + 1); if (prevCfg.lag > 0) lagSet.add(prevCfg.lag - 1); }
    const lags = Array.from(lagSet.values()).sort((a,b)=>a-b);
    // Precompute per-event per-exchange prices at each lag to reduce repeated queries
    const sources = sourcesAll.slice();
    // Evaluate per-exchange individual errors to rank sources
    const perExErrP90: Record<string, number> = {};
    for (const ex of sources) {
      const errs: number[] = [];
      for (const e of events) {
        const p = await fetchMedianAt(symbol, e.ts - (prevCfg?.lag ?? 0), ex);
        if (p === undefined) continue;
        const { rows } = await pool.query(
          `SELECT answer FROM oracle_pred_samples WHERE chain_id=$1 AND lower(oracle_addr)=lower($2) AND event_ts=to_timestamp($3) LIMIT 1`,
          [chainId, addr, e.ts],
        );
        const onchain = Number(rows[0]?.answer);
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
    let best: any = undefined;
    for (const lag of lags) {
      for (const sub of subsetCombos) {
        const weightList = weightGrids(sub, 0.05); // finer grid
        for (const w of weightList) {
          const errsAbs: number[] = [];
          const errsSigned: number[] = [];
          for (const e of events) {
            const t = e.ts - lag;
            let num = 0, den = 0;
            let ok = true;
            for (const ex of sub) {
              const p = await fetchMedianAt(symbol, t, ex);
              if (p === undefined) { ok = false; break; }
              const ww = w[ex] ?? 0;
              num += p * ww;
              den += ww;
            }
            if (!ok || den <= 0) continue;
            const pred = num / den;
            if (!(pred > 0)) continue;
            const { rows } = await pool.query(
              `SELECT answer FROM oracle_pred_samples WHERE chain_id=$1 AND lower(oracle_addr)=lower($2) AND event_ts=to_timestamp($3) LIMIT 1`,
              [chainId, addr, e.ts],
            );
            const onchain = Number(rows[0]?.answer);
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
      }
    }
    if (!best) continue;
    // Offset: if feed-specified present, respect it; else compute from residual p90 with floor
    const offsetRaw = Number.isFinite(feedOffset) ? feedOffset : Math.max(5, Math.round(best.p90));
    const biasRaw = Math.round(Number(best.bias ?? 0));
    const lagRaw = Number(best.lag);
    // EWMA smoothing against previous config
    const lagSmoothed = prevCfg ? Math.round(alpha * lagRaw + (1 - alpha) * prevCfg.lag) : lagRaw;
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
      `INSERT INTO oracle_pred_config(chain_id, oracle_addr, heartbeat_seconds, offset_bps, bias_bps, decimals, scale_factor, lag_seconds, updated_at)
       VALUES($1,$2,$3,$4,$5, COALESCE((SELECT decimals FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), $6), COALESCE((SELECT scale_factor FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), $7), $8, now())
       ON CONFLICT (chain_id, oracle_addr) DO UPDATE SET heartbeat_seconds=EXCLUDED.heartbeat_seconds, offset_bps=EXCLUDED.offset_bps, bias_bps=EXCLUDED.bias_bps, lag_seconds=EXCLUDED.lag_seconds, updated_at=now()`,
      [chainId, addr, hb, offsetSmoothed, biasSmoothed, Number(o.decimals), String(o.scaleFactor), lagSmoothed],
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
    console.log(`🔧 Auto-calibrated ${addr} on ${chainId}: hb=${hb}s, offset=${offsetSmoothed}bps, bias=${biasSmoothed}bps, lag=${lagSmoothed}, weights=${JSON.stringify(weightsSmoothed)} (samples=${best.samples}, p90=${best.p90}bps)`);
  }
}

export function startAutoCalibrateScheduler(intervalMs = 15 * 60_000) {
  const run = async () => {
    try { await runAutoCalibrateOnce(); } catch (e) { console.warn('auto-calibrate failed', e); }
    setTimeout(run, intervalMs);
  };
  run();
}
