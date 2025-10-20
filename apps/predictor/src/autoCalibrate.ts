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

export async function runAutoCalibrateOnce() {
  const cfg = loadConfig();
  const oracles: any[] = (cfg as any).oracles ?? [];
  const sources = ['binance', 'okx', 'coinbase'];
  for (const o of oracles) {
    const chainId = Number(o.chainId);
    const addr = String(o.address);
    const symbol = String(o.symbol ?? 'BTCUSDC');
    // Heartbeat from event gaps
    const events = await fetchEvents(chainId, addr, 2000);
    const ts = events.map((e) => e.ts).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
    const hb = Math.max(10, Math.round(median(gaps) ?? 60));
    // Tune lag/weights with a coarse grid to avoid heavy runtime
    const lags = [0, 1, 2, 3, 5, 7, 10];
    const subsetCombos = combos(sources).filter((c) => c.length >= 1);
    let best: any = undefined;
    for (const lag of lags) {
      for (const sub of subsetCombos) {
        const weightList = weightGrids(sub, 0.2);
        for (const w of weightList) {
          const errs: number[] = [];
          for (const e of events) {
            const t = e.ts - lag;
            let num = 0, den = 0;
            let ok = true;
            for (const ex of sub) {
              const p = await fetchMedianAt(symbol, t, ex);
              if (p === undefined) { ok = false; break; }
              num += p * (w[ex] ?? 0);
              den += (w[ex] ?? 0);
            }
            if (!ok || den <= 0) continue;
            const pred = num / den;
            if (!(pred > 0)) continue;
            // Fetch onchain answer: we have it in samples; simplify by using nearest sample row at e.ts
            // Ideally, join with samples table. Here we recompute by reading samples table.
            const { rows } = await pool.query(
              `SELECT answer FROM oracle_pred_samples WHERE chain_id=$1 AND lower(oracle_addr)=lower($2) AND event_ts=to_timestamp($3) LIMIT 1`,
              [chainId, addr, e.ts],
            );
            const onchain = Number(rows[0]?.answer);
            if (!Number.isFinite(onchain)) continue;
            const ratio = onchain / pred;
            if (!Number.isFinite(ratio)) continue;
            errs.push(Math.abs(Math.round((ratio - 1) * 10_000)));
          }
          if (errs.length < 20) continue;
          const p50 = median(errs) ?? Infinity;
          const p90 = percentile(errs, 0.9) ?? Infinity;
          const cand = { lag, sources: sub, weights: w, samples: errs.length, p50, p90 };
          if (!best || p90 < best.p90 || (p90 === best.p90 && p50 < best.p50)) best = cand;
        }
      }
    }
    if (!best) continue;
    const offset = Math.max(5, Math.round(best.p90));
    // Persist results
    await pool.query(
      `INSERT INTO oracle_pred_config(chain_id, oracle_addr, heartbeat_seconds, offset_bps, decimals, scale_factor, lag_seconds, updated_at)
       VALUES($1,$2,$3,$4, COALESCE((SELECT decimals FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), $5), COALESCE((SELECT scale_factor FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), $6), $7, now())
       ON CONFLICT (chain_id, oracle_addr) DO UPDATE SET heartbeat_seconds=EXCLUDED.heartbeat_seconds, offset_bps=EXCLUDED.offset_bps, lag_seconds=EXCLUDED.lag_seconds, updated_at=now()`,
      [chainId, addr, hb, offset, Number(o.decimals), String(o.scaleFactor), best.lag],
    );
    // Update weights table
    await pool.query('DELETE FROM oracle_cex_weights WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)', [chainId, addr]);
    for (const [src, w] of Object.entries(best.weights as Record<string, number>)) {
      await pool.query(
        `INSERT INTO oracle_cex_weights(chain_id, oracle_addr, source, weight) VALUES($1,$2,$3,$4)
         ON CONFLICT (chain_id, oracle_addr, source) DO UPDATE SET weight=EXCLUDED.weight, updated_at=now()`,
        [chainId, addr, src, w],
      );
    }
    console.log(`🔧 Auto-calibrated ${addr} on ${chainId}: hb=${hb}s, offset=${offset}bps, lag=${best.lag}, weights=${JSON.stringify(best.weights)} (samples=${best.samples}, p90=${best.p90}bps)`);
  }
}

export function startAutoCalibrateScheduler(intervalMs = 15 * 60_000) {
  const run = async () => {
    try { await runAutoCalibrateOnce(); } catch (e) { console.warn('auto-calibrate failed', e); }
    setTimeout(run, intervalMs);
  };
  run();
}

