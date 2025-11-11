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

  const startWithSchema = async (schema) => new Promise(async (resolveExit) => {
    const env = { ...baseEnv, DATABASE_SCHEMA: schema, PONDER_DB_SCHEMA: schema };
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
