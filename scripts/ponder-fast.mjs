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

  const startWithSchema = (schema) => new Promise((resolveExit) => {
    const env = { ...baseEnv, DATABASE_SCHEMA: schema, PONDER_DB_SCHEMA: schema };
    console.log(`Using Ponder schema: ${schema}`);
    const child = spawn('npx', ['ponder', 'start'], {
      cwd: resolve(process.cwd(), 'apps/ponder'),
      stdio: ['inherit', 'pipe', 'pipe'],
      env,
    });
    child.stdout.on('data', (d) => process.stdout.write(d));
    let rolled = false;
    child.stderr.on('data', (d) => {
      const msg = d.toString();
      process.stderr.write(d);
      if (!rolled && /previously used by a different Ponder app/i.test(msg)) {
        rolled = true;
        try { child.kill('SIGINT'); } catch {}
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const next = `${schema}_v${ts}`;
        console.warn(`⚠️  Schema conflict. Auto-rolling to ${next} ...`);
        startWithSchema(next).then((code) => resolveExit(code));
      }
    });
    child.on('exit', (code) => {
      if (!rolled) resolveExit(code ?? 0);
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
