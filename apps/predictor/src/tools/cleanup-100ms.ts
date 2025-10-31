import '../env.js';
import { pool, initSchema } from '../db.js';
import { loadConfig } from '../config.js';

async function main() {
  await initSchema();
  const cfg = loadConfig();
  const symbols = (cfg.pairs ?? []).map((p) => p.symbol);
  if (symbols.length === 0) return;
  for (const s of symbols) {
    const { rowCount } = await pool.query('DELETE FROM cex_agg_100ms WHERE symbol=$1', [s]);
    console.log(`🧹 Deleted ${rowCount ?? 0} rows from cex_agg_100ms for symbol=${s}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

