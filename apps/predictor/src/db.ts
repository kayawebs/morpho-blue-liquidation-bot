import { Pool } from 'pg';

const DEFAULT_URL = 'postgres://ponder:ponder@localhost:5432/ponder';

export const pool = new Pool({
  connectionString: process.env.POSTGRES_DATABASE_URL ?? DEFAULT_URL,
  max: 10,
});

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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chain_id, oracle_addr)
    );

    CREATE TABLE IF NOT EXISTS oracle_pred_samples (
      id BIGSERIAL PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      oracle_addr TEXT NOT NULL,
      block_number BIGINT NOT NULL,
      tx_hash TEXT NOT NULL,
      answer NUMERIC NOT NULL,
      cex_price DOUBLE PRECISION NOT NULL,
      error_bps INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function insertTick(source: string, symbol: string, ts: number, price: number) {
  await pool.query(
    'INSERT INTO cex_ticks(source, symbol, ts, price) VALUES($1,$2,to_timestamp($3),$4)',
    [source, symbol, ts / 1000, price],
  );
}

