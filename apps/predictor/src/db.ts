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
      decimals INTEGER NOT NULL,
      scale_factor NUMERIC NOT NULL,
      lag_seconds INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chain_id, oracle_addr)
    );
    ALTER TABLE oracle_pred_config ADD COLUMN IF NOT EXISTS lag_seconds INTEGER NOT NULL DEFAULT 0;

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
