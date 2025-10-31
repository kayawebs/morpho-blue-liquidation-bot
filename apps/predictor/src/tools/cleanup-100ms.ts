import '../env.js';
import { pool, initSchema } from '../db.js';
import { loadConfig } from '../config.js';

async function main() {
  await initSchema();
  const cfg = loadConfig();
  const symbols = (cfg.pairs ?? []).map((p) => p.symbol);
  if (symbols.length === 0) return;
  for (const s of symbols) {
    const { rowCount: r1 } = await pool.query('DELETE FROM cex_agg_100ms WHERE symbol=$1', [s]);
    console.log(`🧹 Deleted ${r1 ?? 0} rows from cex_agg_100ms for symbol=${s}`);
    const { rowCount: r2 } = await pool.query('DELETE FROM cex_ticks WHERE symbol=$1', [s]);
    console.log(`🧹 Deleted ${r2 ?? 0} rows from cex_ticks for symbol=${s}`);
  }
  try { await pool.end(); } catch {}
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
