import 'dotenv/config';
import pg from 'pg';

type Opts = { chainId: number; hours: number };

function getEnv(name: string, def?: string) {
  const v = process.env[name];
  if (!v || v.trim() === '') return def;
  return v.trim();
}

function parseArgs(): Opts {
  const args = new Map<string, string>();
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args.set(m[1], m[2]);
  }
  const chainId = Number(getEnv('EVAL_CHAIN_ID', args.get('chainId') ?? '8453'));
  const hours = Number(getEnv('EVAL_HOURS', args.get('hours') ?? '24'));
  return { chainId, hours };
}

function getOurLiquidators(chainId: number): string[] {
  const out: string[] = [];
  const suffix = `_${chainId}`;
  const candidates = Object.entries(process.env)
    .filter(([k]) =>
      /(FLASH_LIQUIDATOR_ADDRESS|LIQUIDATOR_ADDRESS|LIQUIDATOR_ADDRESSES|EXECUTOR_ADDRESS)/.test(k)
    );
  for (const [k, v] of candidates) {
    if (!v) continue;
    if (k.endsWith(suffix) || !/_\d+$/.test(k)) {
      v.split(',').forEach((a) => {
        const addr = a.trim();
        if (addr) out.push(addr.toLowerCase());
      });
    }
  }
  return Array.from(new Set(out));
}

async function main() {
  const { chainId, hours } = parseArgs();
  const dbUrl = getEnv('POSTGRES_DATABASE_URL') ?? getEnv('DATABASE_URL') ?? 'postgres://ponder:ponder@localhost:5432/ponder';
  const schema = getEnv('PONDER_DB_SCHEMA') ?? getEnv('DATABASE_SCHEMA') ?? 'mblb_ponder';
  const pool = new pg.Pool({ connectionString: dbUrl });
  const since = Math.floor(Date.now() / 1000) - Math.max(1, hours) * 3600;
  const sql = `select market_id, borrower, liquidator, repaid_assets, repaid_shares, seized_assets, tx_hash, ts
               from ${schema}.liquidation
               where chain_id = $1 and ts >= $2
               order by ts desc`;
  const res = await pool.query(sql, [chainId, since]);
  await pool.end();

  const ours = new Set(getOurLiquidators(chainId));
  const events = res.rows.map((r) => ({
    marketId: r.market_id as string,
    borrower: r.borrower as string,
    liquidator: (r.liquidator as string).toLowerCase(),
    tx: r.tx_hash as string,
    ts: Number(r.ts),
    repaidAssets: BigInt(r.repaid_assets as string),
    repaidShares: BigInt(r.repaid_shares as string),
    seizedAssets: BigInt(r.seized_assets as string),
    ours: ours.has((r.liquidator as string).toLowerCase()),
  }));

  const total = events.length;
  const oursCount = events.filter((e) => e.ours).length;
  const missed = total - oursCount;
  const uniqueBorrowers = new Set(events.map((e) => e.borrower.toLowerCase())).size;
  const uniqueMarkets = new Set(events.map((e) => e.marketId.toLowerCase())).size;

  console.log(JSON.stringify({
    kind: 'summary',
    chainId,
    hours,
    total,
    ours: oursCount,
    missed,
    uniqueBorrowers,
    uniqueMarkets,
    ourLiquidators: Array.from(ours),
  }));

  for (const e of events.slice(0, 10)) {
    console.log(JSON.stringify({ kind: 'sample', ts: e.ts, marketId: e.marketId, borrower: e.borrower, liquidator: e.liquidator, ours: e.ours, tx: e.tx }));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

