import { pool } from '../db.js';
import { loadConfig } from '../config.js';

type EventRow = { ts: number; answer: number };

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

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = args[i + 1];
      if (v && !v.startsWith('--')) { out[k] = v; i++; } else { out[k] = '1'; }
    }
  }
  return out;
}

function pctBps(newV: number, oldV: number) {
  if (!(newV > 0) || !(oldV > 0)) return NaN;
  return Math.round(((newV / oldV) - 1) * 10_000);
}

function median(nums: number[]) {
  if (nums.length === 0) return undefined as any;
  const a = [...nums].sort((x, y) => x - y); const n = a.length; const i = n % 2 === 1 ? (n >> 1) : ((n >> 1) - 1);
  return a[i]!;
}

function percentile(nums: number[], q: number) {
  if (nums.length === 0) return undefined as any;
  const a = [...nums].sort((x, y) => x - y); const idx = Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * q)));
  return a[idx]!;
}

async function main() {
  const cfg = loadConfig();
  const arg = parseArgs();
  const chainId = Number(arg.chain || arg.c || 8453);
  const oracle = String(arg.oracle || arg.o || '0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8');
  const symbol = String(arg.symbol || arg.s || 'BTCUSDC');
  const lookback = Math.max(20, Math.min(2000, Number(arg.limit || arg.n || 200)));
  const windowSec = Math.max(10, Math.min(300, Number(arg.window || arg.w || 90)));
  const stepMs = Math.max(50, Math.min(500, Number(arg.step || arg.d || 100)));

  // Load thresholds and lag
  const { rows: cfgRows } = await pool.query(
    `SELECT offset_bps, heartbeat_seconds, lag_seconds FROM oracle_pred_config
     WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)`,
    [chainId, oracle],
  );
  if (cfgRows.length === 0) throw new Error('config not found; seed or run calibrate first');
  const offsetBps = Number(cfgRows[0].offset_bps);
  const heartbeat = Number(cfgRows[0].heartbeat_seconds);
  const lagMs = Number(cfgRows[0].lag_seconds) * 1000;

  // Fetch recent events ascending to compute lastAnswer deltas
  const { rows: evRows } = await pool.query(
    `SELECT extract(epoch from event_ts)::bigint AS ts, answer::float AS answer
     FROM oracle_pred_samples WHERE chain_id=$1 AND lower(oracle_addr)=lower($2) AND event_ts IS NOT NULL
     ORDER BY event_ts DESC LIMIT $3`,
    [chainId, oracle, lookback],
  );
  const events: EventRow[] = evRows.map((r: any) => ({ ts: Number(r.ts), answer: Number(r.answer) }))
    .filter((x) => Number.isFinite(x.ts) && Number.isFinite(x.answer))
    .sort((a, b) => a.ts - b.ts);
  if (events.length < 10) throw new Error('not enough events');

  const valErrors: number[] = [];
  const leadTimes: number[] = [];
  let offsetDriven = 0;
  let heartbeatDriven = 0;
  let detected = 0;

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!;
    const cur = events[i]!;
    const tEventMs = cur.ts * 1000;
    // Value accuracy at transmit
    const pEvent = await priceAt100ms(symbol, tEventMs - lagMs);
    if (pEvent && pEvent > 0) {
      valErrors.push(Math.abs(pctBps(cur.answer, pEvent)));
    }
    // Classify event type
    const ebps = Math.abs(pctBps(cur.answer, prev.answer));
    const isOffset = Number.isFinite(ebps) && ebps >= offsetBps - 1; // -1bps margin
    if (isOffset) offsetDriven++; else heartbeatDriven++;
    // Backsearch earliest predicted crossing (offset-driven only)
    if (isOffset) {
      const startMs = tEventMs - windowSec * 1000;
      let foundAt: number | undefined;
      for (let t = startMs; t <= tEventMs; t += stepMs) {
        const p = await priceAt100ms(symbol, t - lagMs);
        if (!(p && p > 0)) continue;
        const dbps = Math.abs(pctBps(p, prev.answer));
        if (Number.isFinite(dbps) && dbps >= offsetBps) { foundAt = t; break; }
      }
      if (foundAt !== undefined) {
        detected++;
        leadTimes.push((tEventMs - foundAt) / 1000);
      }
    }
  }

  const p50Err = median(valErrors);
  const p90Err = percentile(valErrors, 0.9);
  const p50Lead = median(leadTimes);
  const p90Lead = percentile(leadTimes, 0.9);

  const summary = {
    chainId,
    oracle,
    symbol,
    samples: events.length,
    windowSec,
    stepMs,
    thresholds: { offsetBps, heartbeat, lagMs },
    valueErrorBps: { p50: p50Err, p90: p90Err, n: valErrors.length },
    leadTimeSec: { p50: p50Lead, p90: p90Lead, n: leadTimes.length },
    events: { offsetDriven, heartbeatDriven, detectedOffset: detected },
    coverage: offsetDriven > 0 ? +(detected / offsetDriven).toFixed(3) : 0,
  };
  console.log(JSON.stringify(summary));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

