import './env.js';
import { Pool } from 'pg';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

export interface OutlierRow {
  chainId: number;
  oracleAddr: string;
  roundId: number;
  reason: string;
  txHash?: string;
  ts?: number;
  gapSeconds?: number;
  deltaBps?: number;
  details?: Record<string, unknown>;
}

function resolvePredictorDbUrl(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const p = resolve(here, '..', '..', 'predictor', 'config.json');
    if (!existsSync(p)) return undefined;
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.db?.url ? String(parsed.db.url) : undefined;
  } catch {
    return undefined;
  }
}

const connectionString =
  process.env.SCHED_DB_URL ??
  process.env.PREDICTOR_DB_URL ??
  process.env.DATABASE_URL ??
  resolvePredictorDbUrl();

export const pool = connectionString ? new Pool({ connectionString, max: 5 }) : undefined;

export async function initSchedulerSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oracle_timing_outliers (
      chain_id INTEGER NOT NULL,
      oracle_addr TEXT NOT NULL,
      round_id BIGINT NOT NULL,
      reason TEXT NOT NULL,
      tx_hash TEXT,
      event_ts TIMESTAMPTZ,
      gap_seconds INTEGER,
      delta_bps DOUBLE PRECISION,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chain_id, oracle_addr, round_id, reason)
    );
    CREATE INDEX IF NOT EXISTS idx_oracle_timing_outliers_ts
      ON oracle_timing_outliers(oracle_addr, event_ts DESC);
  `);
}

export async function insertOutliers(rows: OutlierRow[]) {
  if (!pool || rows.length === 0) return;
  const values: string[] = [];
  const params: any[] = [];
  let i = 1;
  for (const row of rows) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(
      row.chainId,
      row.oracleAddr.toLowerCase(),
      row.roundId,
      row.reason,
      row.txHash ?? null,
      row.ts ? new Date(row.ts * 1000) : null,
      row.gapSeconds ?? null,
      row.deltaBps ?? null,
      row.details ?? null,
    );
  }
  const sql = `
    INSERT INTO oracle_timing_outliers
      (chain_id, oracle_addr, round_id, reason, tx_hash, event_ts, gap_seconds, delta_bps, details)
    VALUES ${values.join(',')}
    ON CONFLICT (chain_id, oracle_addr, round_id, reason)
    DO UPDATE SET
      tx_hash = EXCLUDED.tx_hash,
      event_ts = COALESCE(EXCLUDED.event_ts, oracle_timing_outliers.event_ts),
      gap_seconds = EXCLUDED.gap_seconds,
      delta_bps = EXCLUDED.delta_bps,
      details = EXCLUDED.details,
      created_at = now();
  `;
  await pool.query(sql, params);
}
