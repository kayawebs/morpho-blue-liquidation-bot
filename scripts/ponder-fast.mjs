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
  const env = {
    ...process.env,
    FAST_ONLY_MARKETS: fast,
    DATABASE_SCHEMA: process.env.PONDER_DB_SCHEMA ?? 'mblb_ponder',
    FAST_LOOKBACK_BLOCKS: process.env.FAST_LOOKBACK_BLOCKS ?? '10000',
  };

  console.log(`FAST_ONLY_MARKETS=${fast}`);

  const child = spawn('npx', ['ponder', 'start'], {
    cwd: resolve(process.cwd(), 'apps/ponder'),
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
