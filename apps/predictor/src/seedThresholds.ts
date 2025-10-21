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
    await pool.query(
      `INSERT INTO oracle_pred_config(chain_id, oracle_addr, heartbeat_seconds, offset_bps, decimals, scale_factor, lag_seconds, updated_at)
       VALUES($1,$2, COALESCE($3, COALESCE((SELECT heartbeat_seconds FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), 60)),
                     COALESCE($4, COALESCE((SELECT offset_bps FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), 10)),
                     $5, $6, COALESCE((SELECT lag_seconds FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), 0), now())
       ON CONFLICT (chain_id, oracle_addr) DO UPDATE SET
         heartbeat_seconds = COALESCE($3, oracle_pred_config.heartbeat_seconds),
         offset_bps = COALESCE($4, oracle_pred_config.offset_bps),
         decimals = $5,
         scale_factor = $6,
         updated_at = now()`,
      [chainId, addr, Number.isFinite(hb) ? hb : null, Number.isFinite(offsetBps) ? offsetBps : null, decimals, scale],
    );
  }
}

