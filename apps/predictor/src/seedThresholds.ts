import { pool } from './db.js';
import { loadConfig } from './config.js';

export async function seedOracleThresholdsFromConfig() {
  const cfg = loadConfig();
  const oracles: any[] = (cfg as any).oracles ?? [];
  for (const o of oracles) {
    const chainId = Number(o.chainId);
    const addr = String(o.address);
    const decimals = Number(o.decimals ?? 8);
    const scale = String(o.scaleFactor ?? '1');
    const offsetBps = Number(o.feedDeviationBps);
    const hb = Number(o.feedHeartbeatSeconds);
    if (!Number.isFinite(offsetBps) && !Number.isFinite(hb)) continue;
    // Do not overwrite existing thresholds on conflict; only insert if missing
    await pool.query(
      `INSERT INTO oracle_pred_config(chain_id, oracle_addr, heartbeat_seconds, offset_bps, decimals, scale_factor, lag_seconds, updated_at)
       VALUES($1,$2, $3, $4, $5, $6, 0, now())
       ON CONFLICT (chain_id, oracle_addr) DO NOTHING`,
      [chainId, addr, Number.isFinite(hb) ? hb : null, Number.isFinite(offsetBps) ? offsetBps : null, decimals, scale],
    );
  }
}
