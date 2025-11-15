import 'dotenv/config';
import pg from 'pg';
import { loadSchedulerConfig } from '../config.js';

function getEnv(name: string, def?: string) {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : def;
}

function quantile(sorted: number[], p: number) {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const h = idx - lo;
  return sorted[lo]! * (1 - h) + sorted[hi]! * h;
}

async function main() {
  // Load first feed from scheduler config
  const cfg = loadSchedulerConfig();
  if (!cfg.feeds || cfg.feeds.length === 0) {
    console.error('No feeds configured.');
    process.exit(1);
  }
  const feed = cfg.feeds[0]!; // evaluate the first feed by default
  const chainId = feed.chainId;
  const oracle = feed.aggregator.toLowerCase();

  // Connect to Predictor DB for windows
  const schedUrl = getEnv('SCHED_DB_URL') || getEnv('PREDICTOR_DB_URL') || getEnv('DATABASE_URL');
  if (!schedUrl) throw new Error('Missing scheduler DB URL (SCHED_DB_URL/PREDICTOR_DB_URL/DATABASE_URL)');
  const poolA = new pg.Pool({ connectionString: schedUrl });

  // Connect to Ponder DB for transmits
  const ponderUrl = getEnv('POSTGRES_DATABASE_URL') || getEnv('DATABASE_URL');
  if (!ponderUrl) throw new Error('Missing Ponder DB URL (POSTGRES_DATABASE_URL/DATABASE_URL)');
  const ponderSchema = getEnv('PONDER_DB_SCHEMA') || getEnv('DATABASE_SCHEMA') || 'mblb_ponder';
  const poolB = new pg.Pool({ connectionString: ponderUrl });

  // Fetch last 100 transmits for this feed
  const txRes = await poolB.query(
    `select round_id, ts from ${ponderSchema}.oracle_transmission
     where chain_id = $1 and lower(oracle_addr) = lower($2)
     order by block_number desc limit 100`,
    [chainId, oracle]
  );
  const transmits = txRes.rows.map((r) => ({ round: Number(r.round_id), ts: Number(r.ts) })).reverse();
  if (transmits.length === 0) {
    console.log(JSON.stringify({ kind: 'summary', error: 'no transmits' }));
    await poolA.end(); await poolB.end();
    return;
  }

  const minTs = transmits[0]!.ts - 3600; // 1h cushion
  // Fetch recent windows
  const winRes = await poolA.query(
    `select kind, start_ts, end_ts from oracle_schedule_windows
     where chain_id = $1 and lower(oracle_addr) = lower($2) and end_ts >= $3
     order by generated_at desc limit 1000`,
    [chainId, oracle, minTs]
  );
  const windows = winRes.rows.map((r) => ({ kind: String(r.kind), start: Number(r.start_ts), end: Number(r.end_ts) }));

  const heartbeats = windows.filter((w) => w.kind === 'heartbeat');
  const deviations = windows.filter((w) => w.kind === 'deviation');

  function coveredBy(ts: number, arr: { start: number; end: number }[]) {
    return arr.some((w) => ts >= w.start && ts <= w.end);
  }

  let coveredOverall = 0, coveredHb = 0, coveredDev = 0;
  const misses: any[] = [];
  for (const t of transmits) {
    const byHb = coveredBy(t.ts, heartbeats);
    const byDev = coveredBy(t.ts, deviations);
    const byAny = byHb || byDev;
    if (byAny) coveredOverall++;
    if (byHb) coveredHb++;
    if (byDev) coveredDev++;
    if (!byAny && misses.length < 10) misses.push({ round: t.round, ts: t.ts });
  }

  function widths(arr: { start: number; end: number }[]) {
    const ws = arr.map((w) => w.end - w.start).filter((x) => Number.isFinite(x) && x >= 0).sort((a,b)=>a-b);
    return { p50: quantile(ws, 0.5), p90: quantile(ws, 0.9) };
  }
  const wAll = widths(windows);
  const wHb = widths(heartbeats);
  const wDev = widths(deviations);

  const n = transmits.length || 1;
  const summary = {
    kind: 'summary',
    feed: { chainId, oracle },
    transmits: n,
    coverage: {
      overallPct: Math.round((coveredOverall / n) * 10000) / 100,
      heartbeatPct: Math.round((coveredHb / n) * 10000) / 100,
      deviationPct: Math.round((coveredDev / n) * 10000) / 100,
    },
    widthsSec: {
      overall: { p50: Number.isFinite(wAll.p50) ? Number(wAll.p50.toFixed(3)) : null, p90: Number.isFinite(wAll.p90) ? Number(wAll.p90.toFixed(3)) : null },
      heartbeat: { p50: Number.isFinite(wHb.p50) ? Number(wHb.p50.toFixed(3)) : null, p90: Number.isFinite(wHb.p90) ? Number(wHb.p90.toFixed(3)) : null },
      deviation: { p50: Number.isFinite(wDev.p50) ? Number(wDev.p50.toFixed(3)) : null, p90: Number.isFinite(wDev.p90) ? Number(wDev.p90.toFixed(3)) : null },
    },
    misses,
  };
  console.log(JSON.stringify(summary));

  await poolA.end();
  await poolB.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

