import { Pool } from 'pg';
import { loadConfig } from './config.js';

const cfg = loadConfig();
export const pool = new Pool({ connectionString: cfg.db.url, max: 10 });

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cex_ticks (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      symbol TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      price DOUBLE PRECISION NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cex_ticks_symbol_ts ON cex_ticks(symbol, ts DESC);

    CREATE TABLE IF NOT EXISTS oracle_pred_config (
      chain_id INTEGER NOT NULL,
      oracle_addr TEXT NOT NULL,
      heartbeat_seconds INTEGER NOT NULL,
      offset_bps INTEGER NOT NULL,
      bias_bps INTEGER NOT NULL DEFAULT 0,
      decimals INTEGER NOT NULL,
      scale_factor NUMERIC NOT NULL,
      lag_seconds INTEGER NOT NULL DEFAULT 0,
      lag_ms INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chain_id, oracle_addr)
    );
    ALTER TABLE oracle_pred_config ADD COLUMN IF NOT EXISTS lag_seconds INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE oracle_pred_config ADD COLUMN IF NOT EXISTS bias_bps INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE oracle_pred_config ADD COLUMN IF NOT EXISTS lag_ms INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS oracle_pred_samples (
      id BIGSERIAL PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      oracle_addr TEXT NOT NULL,
      block_number BIGINT NOT NULL,
      tx_hash TEXT NOT NULL,
      answer NUMERIC NOT NULL,
      cex_price DOUBLE PRECISION NOT NULL,
      event_ts TIMESTAMPTZ,
      error_bps INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE oracle_pred_samples ADD COLUMN IF NOT EXISTS event_ts TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_oracle_samples_addr_ts ON oracle_pred_samples(oracle_addr, event_ts DESC);

    -- Per-oracle CEX weights
    CREATE TABLE IF NOT EXISTS oracle_cex_weights (
      chain_id INTEGER NOT NULL,
      oracle_addr TEXT NOT NULL,
      source TEXT NOT NULL,
      weight NUMERIC NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chain_id, oracle_addr, source)
    );

    -- Sub-second aggregated prices (100ms bins)
    CREATE TABLE IF NOT EXISTS cex_agg_100ms (
      symbol TEXT NOT NULL,
      ts_ms BIGINT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (symbol, ts_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_cex_agg_100ms_symbol_ts ON cex_agg_100ms(symbol, ts_ms DESC);
  `);
}

// Simple batch inserter to reduce DB overhead
const batch: { source: string; symbol: string; ts: number; price: number }[] = [];
let flushing = false;
setInterval(async () => {
  if (flushing || batch.length === 0) return;
  flushing = true;
  const items = batch.splice(0, batch.length);
  const values: string[] = [];
  const params: any[] = [];
  let i = 1;
  for (const it of items) {
    values.push(`($${i++}, $${i++}, to_timestamp($${i++}), $${i++})`);
    params.push(it.source, it.symbol, it.ts / 1000, it.price);
  }
  try {
    await pool.query(
      `INSERT INTO cex_ticks(source, symbol, ts, price) VALUES ${values.join(',')}`,
      params,
    );
  } catch (e) {
    // fallback to individual insert to avoid data loss
    for (const it of items) {
      try {
        await pool.query(
          'INSERT INTO cex_ticks(source, symbol, ts, price) VALUES($1,$2,to_timestamp($3),$4)',
          [it.source, it.symbol, it.ts / 1000, it.price],
        );
      } catch {}
    }
  } finally {
    flushing = false;
  }
}, 500);

export async function insertTick(source: string, symbol: string, ts: number, price: number) {
  batch.push({ source, symbol, ts, price });
}

// 100ms aggregated write buffer
const agg100Batch: { symbol: string; tsMs: number; price: number }[] = [];
let aggFlushing = false;
setInterval(async () => {
  if (aggFlushing || agg100Batch.length === 0) return;
  aggFlushing = true;
  const items = agg100Batch.splice(0, agg100Batch.length);
  const values: string[] = [];
  const params: any[] = [];
  let i = 1;
  for (const it of items) {
    values.push(`($${i++}, $${i++}, $${i++})`);
    params.push(it.symbol, Math.floor(it.tsMs), it.price);
  }
  try {
    await pool.query(
      `INSERT INTO cex_agg_100ms(symbol, ts_ms, price) VALUES ${values.join(',')}
       ON CONFLICT (symbol, ts_ms) DO UPDATE SET price=EXCLUDED.price`,
      params,
    );
  } catch (e) {
    // fallback row-by-row
    for (const it of items) {
      try {
        await pool.query(
          `INSERT INTO cex_agg_100ms(symbol, ts_ms, price) VALUES ($1,$2,$3)
           ON CONFLICT (symbol, ts_ms) DO UPDATE SET price=EXCLUDED.price`,
          [it.symbol, Math.floor(it.tsMs), it.price],
        );
      } catch {}
    }
  } finally {
    aggFlushing = false;
  }
}, 1000);

export function insertAgg100ms(symbol: string, tsMs: number, price: number) {
  agg100Batch.push({ symbol, tsMs, price });
}

// TTL cleanup for 100ms table (default keep 7 days)
let ttlDays = 7;
try { const v = Number(process.env.PREDICTOR_100MS_TTL_DAYS); if (Number.isFinite(v) && v > 0) ttlDays = Math.floor(v); } catch {}
setInterval(async () => {
  try {
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    await pool.query(`DELETE FROM cex_agg_100ms WHERE ts_ms < $1`, [Math.floor(cutoff)]);
  } catch {}
}, 60 * 60 * 1000);
