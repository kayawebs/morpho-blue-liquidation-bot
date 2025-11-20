import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';

type Session = { kind?: string; reason?: string; startedAt?: number; endedAt?: number; };

function env(name: string, def?: string) {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : def;
}

function loadSessions(path: string): { start: number; end: number; reason?: string }[] {
  if (!fs.existsSync(path)) return [];
  const lines = fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  const out: { start: number; end: number; reason?: string }[] = [];
  for (const ln of lines) {
    try {
      const j = JSON.parse(ln) as Session;
      if (j && (j.kind === 'spraySession' || (!j.kind && (j.startedAt || j.endedAt)))) {
        const start = Number(j.startedAt);
        const end = Number(j.endedAt);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          out.push({ start, end, reason: j.reason });
        }
      }
    } catch {}
  }
  return out;
}

function covered(tsMs: number, sessions: { start: number; end: number }[]): boolean {
  for (const s of sessions) {
    if (tsMs >= s.start && tsMs <= s.end) return true;
  }
  return false;
}

async function main() {
  const chainId = Number(env('EVAL_CHAIN_ID', '8453'));
  const aggregator = (env('EVAL_AGGREGATOR', '0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8')!).toLowerCase();
  const marketId = (env('EVAL_MARKET_ID', '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836')!).toLowerCase();
  const limit = Number(env('EVAL_LIMIT', '100'));
  const hours = Number(env('EVAL_HOURS', '24'));
  const sessionsPath = env('SPRAY_SESSIONS_FILE', 'out/worker-sessions.ndjson')!;
  const dbUrl = env('POSTGRES_DATABASE_URL') ?? env('DATABASE_URL') ?? 'postgres://ponder:ponder@localhost:5432/ponder';
  const schema = env('PONDER_DB_SCHEMA') ?? env('DATABASE_SCHEMA') ?? 'mblb_ponder';

  const sessions = loadSessions(sessionsPath);
  const pool = new pg.Pool({ connectionString: dbUrl });

  const sinceTs = Math.floor(Date.now() / 1000) - Math.max(1, hours) * 3600;
  // Fetch recent transmits for this aggregator in last N hours
  const txSql = `select ts from ${schema}.oracle_transmission where chain_id=$1 and lower(oracle_addr)=$2 and ts >= $3 order by block_number desc limit $4`;
  const txRes = await pool.query(txSql, [chainId, aggregator, sinceTs, Math.max(1, Math.min(1000, limit))]);
  // Fetch recent liquidations for this market in last N hours
  const liqSql = `select ts from ${schema}.liquidation where chain_id=$1 and lower(market_id)=$2 and ts >= $3 order by block_number desc limit $4`;
  const liqRes = await pool.query(liqSql, [chainId, marketId, sinceTs, Math.max(1, Math.min(1000, limit))]);
  await pool.end();

  const transmits = txRes.rows.map((r) => Number(r.ts) * 1000).filter((x) => Number.isFinite(x));
  const liqs = liqRes.rows.map((r) => Number(r.ts) * 1000).filter((x) => Number.isFinite(x));
  // Filter sessions to the same evaluation window
  const windowStartMs = sinceTs * 1000;
  const windowEndMs = Date.now();
  const windowedSessions = sessions
    .filter((s) => s.end >= windowStartMs && s.start <= windowEndMs)
    .map((s) => ({ start: Math.max(s.start, windowStartMs), end: Math.min(s.end, windowEndMs), reason: s.reason }));

  let txCovered = 0;
  for (const t of transmits) if (covered(t, windowedSessions)) txCovered++;
  let liqCovered = 0;
  for (const t of liqs) if (covered(t, windowedSessions)) liqCovered++;

  const summary = {
    kind: 'spray-eval',
    chainId,
    aggregator,
    marketId,
    sessions: windowedSessions.length,
    transmits: transmits.length,
    liqs: liqs.length,
    coverage: {
      transmitPct: transmits.length ? Math.round((txCovered / transmits.length) * 100) : 0,
      liquidationPct: liqs.length ? Math.round((liqCovered / liqs.length) * 100) : 0,
    },
  };
  console.log(JSON.stringify(summary));
}

main().catch((e) => { console.error(e); process.exit(1); });
