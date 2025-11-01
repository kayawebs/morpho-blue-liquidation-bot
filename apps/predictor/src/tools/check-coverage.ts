import '../env.js';
import { pool, initSchema } from '../db.js';
import { loadConfig } from '../config.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) { const k = a.slice(2); const v = args[i+1]; if (v && !v.startsWith('--')) { out[k]=v; i++; } else out[k]='1'; }
  }
  return out;
}

async function main() {
  await initSchema();
  const cfg = loadConfig();
  const arg = parseArgs();
  const chainId = Number(arg.chain || arg.c || 8453);
  const oracle = String(arg.oracle || arg.o || '');
  const symbol = String(arg.symbol || arg.s || (cfg.pairs?.[0]?.symbol ?? 'BTCUSDC'));
  const limit = Math.max(10, Math.min(500, Number(arg.limit || arg.n || 120)));
  const windowMs = Math.max(50, Math.min(1000, Number(arg.windowMs || arg.w || 300)));
  const lags = (arg.lags || '0,500,1000,1500,2000,2500,3000')
    .split(',').map((x)=>Number(x.trim())).filter((x)=>Number.isFinite(x) && x >= 0);
  if (!oracle) {
    console.error('Usage: check-coverage --chain 8453 --oracle 0x... [--symbol BTCUSDC] [--limit 120] [--windowMs 300] [--lags 0,500,1000,1500,...]');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT extract(epoch from event_ts)::bigint AS ts
     FROM oracle_pred_samples WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)
     AND event_ts IS NOT NULL ORDER BY event_ts DESC LIMIT $3`,
    [chainId, oracle, limit],
  );
  const events = rows.map((r:any)=>Number(r.ts)).filter((x)=>Number.isFinite(x));
  if (events.length === 0) { console.log('no events'); return; }

  const coverage: { lagMs: number; agg: number; src: number; total: number }[] = [];
  for (const lag of lags) {
    let aggHit = 0; let srcHit = 0;
    for (const ts of events) {
      const t = Math.floor(ts * 1000 - lag);
      const [r1, r2] = await Promise.all([
        pool.query(`SELECT 1 FROM cex_agg_100ms WHERE symbol=$1 AND ts_ms BETWEEN $2 AND $3 LIMIT 1`, [symbol, t - windowMs, t + windowMs]),
        pool.query(`SELECT 1 FROM cex_src_100ms WHERE symbol=$1 AND ts_ms BETWEEN $2 AND $3 LIMIT 1`, [symbol, t - windowMs, t + windowMs]),
      ]);
      if (r1.rows.length > 0) aggHit++;
      if (r2.rows.length > 0) srcHit++;
    }
    coverage.push({ lagMs: lag, agg: aggHit, src: srcHit, total: events.length });
  }

  // Print summary
  for (const c of coverage) {
    console.log(JSON.stringify({ kind: 'coverage', lagMs: c.lagMs, agg: `${c.agg}/${c.total}`, src: `${c.src}/${c.total}` }));
  }

  // For best guess lag (min among lags with highest agg/src), print missing examples
  const best = coverage.reduce((a,b)=> (b.agg+b.src > (a?.agg??0)+(a?.src??0) ? b : a), coverage[0]);
  if (best) {
    const miss: { ts: number; agg: boolean; src: boolean }[] = [];
    for (const ts of events) {
      const t = Math.floor(ts * 1000 - best.lagMs);
      const [r1, r2] = await Promise.all([
        pool.query(`SELECT 1 FROM cex_agg_100ms WHERE symbol=$1 AND ts_ms BETWEEN $2 AND $3 LIMIT 1`, [symbol, t - windowMs, t + windowMs]),
        pool.query(`SELECT 1 FROM cex_src_100ms WHERE symbol=$1 AND ts_ms BETWEEN $2 AND $3 LIMIT 1`, [symbol, t - windowMs, t + windowMs]),
      ]);
      const okAgg = r1.rows.length > 0; const okSrc = r2.rows.length > 0;
      if (!(okAgg && okSrc)) miss.push({ ts, agg: okAgg, src: okSrc });
      if (miss.length >= 10) break;
    }
    for (const m of miss) console.log(JSON.stringify({ kind: 'missing', lagMs: best.lagMs, ts: m.ts, hasAgg: m.agg, hasSrc: m.src }));
  }

  try { await pool.end(); } catch {}
  process.exit(0);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
