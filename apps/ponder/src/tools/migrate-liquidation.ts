import 'dotenv/config';
import pg from 'pg';

function env(name: string, def?: string) {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : def;
}

async function main() {
  const dbUrl = env('POSTGRES_DATABASE_URL') ?? env('DATABASE_URL') ?? 'postgres://ponder:ponder@localhost:5432/ponder';
  const schema = env('PONDER_DB_SCHEMA') ?? env('DATABASE_SCHEMA') ?? 'mblb_ponder';
  const pool = new pg.Pool({ connectionString: dbUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.liquidation (
        chain_id INTEGER NOT NULL,
        market_id TEXT NOT NULL,
        borrower TEXT NOT NULL,
        repaid_assets BIGINT NOT NULL DEFAULT 0,
        repaid_shares BIGINT NOT NULL DEFAULT 0,
        seized_assets BIGINT NOT NULL DEFAULT 0,
        bad_debt_assets BIGINT NOT NULL DEFAULT 0,
        bad_debt_shares BIGINT NOT NULL DEFAULT 0,
        tx_hash TEXT NOT NULL,
        block_number BIGINT NOT NULL,
        ts BIGINT NOT NULL,
        liquidator TEXT NOT NULL,
        CONSTRAINT liquidation_pk PRIMARY KEY (chain_id, tx_hash)
      )`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS liquidation_idx_market ON ${schema}.liquidation (chain_id, market_id, block_number)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS liquidation_idx_borrower ON ${schema}.liquidation (chain_id, borrower, block_number)`,
    );
    await client.query('COMMIT');
    console.log(`Ensured table ${schema}.liquidation exists.`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Failed to create table:', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

