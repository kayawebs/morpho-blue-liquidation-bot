import 'dotenv/config';
import { type Address } from 'viem';
import pg from 'pg';

// Minimal OCR2 event ABI to fetch NewTransmission logs
const OCR2_NEW_TRANSMISSION = [
  {
    type: 'event',
    name: 'NewTransmission',
    inputs: [
      { indexed: true, name: 'aggregatorRoundId', type: 'uint32' },
      { indexed: false, name: 'answer', type: 'int192' },
      { indexed: false, name: 'transmitter', type: 'address' },
      { indexed: false, name: 'observations', type: 'int192[]' },
      { indexed: false, name: 'observers', type: 'bytes' },
      { indexed: false, name: 'rawReportContext', type: 'bytes32' },
    ],
  },
] as const;

const AGGREGATOR_V2V3_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint80', name: 'roundId' },
      { type: 'int256', name: 'answer' },
      { type: 'uint256', name: 'startedAt' },
      { type: 'uint256', name: 'updatedAt' },
      { type: 'uint80', name: 'answeredInRound' },
    ],
  },
] as const;

type Opts = { chainId: number; limit: number; predictorUrl: string };

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
  const chainId = Number(getEnv('EVAL_CHAIN_ID', '8453'));
  const limit = Number(getEnv('EVAL_LIMIT', '100'));
  const predictorUrl = getEnv('PREDICTOR_URL', 'http://localhost:48080')!;
  return { chainId, limit, predictorUrl };
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const h = idx - lo;
  return sorted[lo]! * (1 - h) + sorted[hi]! * h;
}

async function fetchPredictionAt(predictorUrl: string, chainId: number, aggregator: Address, ts: number): Promise<number | undefined> {
  try {
    const url = new URL(`/oracles/${chainId}/${aggregator}/predictionAt`, predictorUrl);
    url.searchParams.set('ts', String(ts));
    const res = await fetch(url);
    if (res.ok) {
      const j = await res.json();
      const v = (j?.predicted ?? j?.price ?? j?.value) as number | string | undefined;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') return Number(v);
    }
  } catch {}
  return undefined;
}

async function main() {
  const opts = parseArgs();
  const dbUrl = getEnv('POSTGRES_DATABASE_URL') ?? getEnv('DATABASE_URL') ?? 'postgres://ponder:ponder@localhost:5432/ponder';
  const schema = getEnv('PONDER_DB_SCHEMA') ?? getEnv('DATABASE_SCHEMA') ?? 'mblb_ponder';
  const pool = new pg.Pool({ connectionString: dbUrl });
  // Read last up to 100 transmissions from Ponder DB
  const limit = Math.max(1, Math.min(opts.limit, 100));
  const sql = `select chainid as chain_id, oracleaddr as oracle_addr, roundid as round_id, answerraw as answer_raw, ts
               from ${schema}.oracle_transmission
               where chainid = $1
               order by blocknumber desc
               limit $2`;
  const res = await pool.query(sql, [opts.chainId, limit]);
  if (res.rowCount === 0) {
    console.log('No transmit rows found in Ponder DB.');
    await pool.end();
    return;
  }
  const samples: { ts: number; round: number; answer: number; predicted?: number; absErr?: number; signedErr?: number }[] = [];
  for (const row of res.rows) {
    const ts = Number(row.ts);
    const answerRaw = BigInt(row.answer_raw as string | number | bigint);
    // Assume 8 decimals by default for BTCUSD-like feeds; adjust if your predictor scales differently
    const answer = Number(answerRaw) / Math.pow(10, 8);
    const predicted = await fetchPredictionAt(opts.predictorUrl, opts.chainId, row.oracle_addr as Address, ts);
    const round = Number(row.round_id);
    const s: any = { ts, round, answer, predicted };
    if (typeof predicted === 'number') {
      const signedErr = 10_000 * (predicted - answer) / (answer === 0 ? 1 : answer);
      s.signedErr = signedErr;
      s.absErr = Math.abs(signedErr);
    }
    samples.push(s);
  }
  await pool.end();

  const ok = samples.filter((s) => typeof s.absErr === 'number') as { absErr: number; signedErr: number }[];
  const coverage = (ok.length / samples.length) * 100;
  const absSorted = ok.map((s) => s.absErr).sort((a, b) => a - b);
  const signedSorted = ok.map((s) => s.signedErr).sort((a, b) => a - b);
  const p50 = quantile(absSorted, 0.5);
  const p90 = quantile(absSorted, 0.9);
  const bias = quantile(signedSorted, 0.5);

  // Print a few samples
  for (const s of samples.slice(0, 5)) {
    console.log(JSON.stringify({ kind: 'sample', ts: s.ts, round: s.round, answer: s.answer, predicted: s.predicted, signedErrBps: s.signedErr, absErrBps: s.absErr }));
  }
  console.log(JSON.stringify({ kind: 'summary', count: samples.length, havePred: ok.length, coveragePct: Number(coverage.toFixed(2)), p50AbsErrBps: Number(p50?.toFixed?.(3) ?? 'NaN'), p90AbsErrBps: Number(p90?.toFixed?.(3) ?? 'NaN'), biasBps: Number(bias?.toFixed?.(3) ?? 'NaN') }));
}

main().catch((e) => { console.error(e); process.exit(1); });
