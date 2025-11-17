import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readMarkets() {
  const p = resolve(process.cwd(), 'markets.json');
  const raw = readFileSync(p, 'utf8');
  const cfg = JSON.parse(raw);
  if (!cfg.markets || !Array.isArray(cfg.markets) || cfg.markets.length === 0) {
    console.error('markets.json missing non-empty "markets" array');
    process.exit(1);
  }
  return cfg.markets;
}

async function main() {
  const markets = readMarkets();
  const fast = markets.join(',');
  const baseEnv = {
    ...process.env,
    FAST_ONLY_MARKETS: fast,
    FAST_LOOKBACK_BLOCKS: process.env.FAST_LOOKBACK_BLOCKS ?? '10000',
  };

  console.log(`FAST_ONLY_MARKETS=${fast}`);

  const detectSchemaHasTables = async (schema) => {
    try {
      const { Client } = await import('pg');
      const url = process.env.POSTGRES_DATABASE_URL ?? 'postgres://ponder:ponder@localhost:5432/ponder';
      const client = new Client({ connectionString: url });
      await client.connect();
      const r = await client.query(
        `SELECT COUNT(*)::int AS n
         FROM information_schema.tables WHERE table_schema=$1`,
        [schema],
      );
      await client.end();
      return Number(r.rows?.[0]?.n ?? 0) > 0;
    } catch (e) {
      console.warn('⚠️ Could not inspect schema for resume detection; defaulting to lookback.', e?.message ?? e);
      return false;
    }
  };

  // Ensure target schema exists and create any custom tables Ponder won't manage itself
  const ensureBaseSchema = async (schema) => {
    try {
      const { Client } = await import('pg');
      const url = process.env.POSTGRES_DATABASE_URL ?? 'postgres://ponder:ponder@localhost:5432/ponder';
      const client = new Client({ connectionString: url });
      await client.connect();
      // Create schema if missing
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      // Create our custom liquidation table if missing (Ponder migrations don't know about it)
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
        )`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS liquidation_idx_market ON ${schema}.liquidation (chain_id, market_id, block_number)`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS liquidation_idx_borrower ON ${schema}.liquidation (chain_id, borrower, block_number)`
      );
      await client.end();
    } catch (e) {
      console.warn('⚠️ Failed to ensure base schema/tables (will continue):', e?.message ?? e);
    }
  };

  const startWithSchema = async (schema) => new Promise(async (resolveExit) => {
    const env = { ...baseEnv, DATABASE_SCHEMA: schema, PONDER_DB_SCHEMA: schema };
    await ensureBaseSchema(schema);
    // If schema already has tables, resume from DB (disable fast lookback). Else use configured/default lookback.
    const hasData = await detectSchemaHasTables(schema);
    env.FAST_LOOKBACK_BLOCKS = hasData ? '0' : (process.env.FAST_LOOKBACK_BLOCKS ?? '10000');
    console.log(`Using Ponder schema: ${schema} (hasData=${hasData}, LOOKBACK=${env.FAST_LOOKBACK_BLOCKS})`);
    const child = spawn('npx', ['ponder', 'start'], {
      cwd: resolve(process.cwd(), 'apps/ponder'),
      stdio: ['inherit', 'pipe', 'pipe'],
      env,
    });
    let conflict = false;
    const handleConflict = () => {
      if (conflict) return;
      conflict = true;
      console.error('❌ Schema conflict detected. Please drop the existing schema or set PONDER_DB_SCHEMA to a new name.');
      console.error(`   Current schema: ${schema}`);
      try { child.kill('SIGINT'); } catch {}
      resolveExit(1);
    };
    child.stdout.on('data', (d) => {
      const msg = d.toString();
      process.stdout.write(d);
      if (/previously used by a different Ponder app/i.test(msg)) {
        handleConflict();
      }
    });
    child.stderr.on('data', (d) => {
      const msg = d.toString();
      process.stderr.write(d);
      if (/previously used by a different Ponder app/i.test(msg)) {
        handleConflict();
      }
    });
    child.on('exit', (code) => {
      if (conflict) return;
      resolveExit(code ?? 0);
    });
  });

  const initial = process.env.PONDER_DB_SCHEMA ?? 'mblb_ponder';
  const code = await startWithSchema(initial);
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
