import 'dotenv/config';
import { createPublicClient, http, type Address, getAbiItem } from 'viem';
import { base } from 'viem/chains';

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

type Opts = {
  chainId: number;
  aggregator: Address;
  limit: number;
  fromBlock?: bigint;
  toBlock?: bigint;
  predictorUrl: string;
  symbol?: string; // fallback when /predictionAt not available
};

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
  const chainId = Number(args.get('chain') ?? getEnv('EVAL_CHAIN_ID', '8453'));
  const aggregator = (args.get('aggregator') ?? getEnv('EVAL_AGGREGATOR', '0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8')) as Address;
  const limit = Number(args.get('limit') ?? getEnv('EVAL_LIMIT', '200'));
  const predictorUrl = args.get('predictor') ?? getEnv('PREDICTOR_URL', 'http://localhost:48080')!;
  const symbol = args.get('symbol') ?? getEnv('EVAL_SYMBOL', 'BTCUSDC')!;
  const fromBlock = args.get('fromBlock') ? BigInt(args.get('fromBlock')!) : undefined;
  const toBlock = args.get('toBlock') ? BigInt(args.get('toBlock')!) : undefined;
  return { chainId, aggregator, limit, predictorUrl, symbol, fromBlock, toBlock };
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

async function fetchPredictionAt(predictorUrl: string, chainId: number, aggregator: Address, ts: number, fallbackSymbol?: string): Promise<number | undefined> {
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
  // Fallback to generic priceAt endpoint by symbol if available
  if (fallbackSymbol) {
    try {
      const url = new URL(`/priceAt/${fallbackSymbol}`, predictorUrl);
      url.searchParams.set('ts', String(ts));
      const res = await fetch(url);
      if (res.ok) {
        const j = await res.json();
        const v = (j?.price ?? j?.value) as number | string | undefined;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') return Number(v);
      }
    } catch {}
  }
  return undefined;
}

async function main() {
  const opts = parseArgs();
  const rpcUrl = getEnv(`RPC_URL_${opts.chainId}`) ?? getEnv('RPC_URL');
  if (!rpcUrl) throw new Error(`Missing RPC_URL_${opts.chainId} or RPC_URL in env`);

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  // Resolve decimals for scaling answer
  let decimals = 8;
  try {
    decimals = await client.readContract({ address: opts.aggregator, abi: AGGREGATOR_V2V3_ABI, functionName: 'decimals' }) as number;
  } catch {}

  // Fetch recent NewTransmission logs
  const eventAbi = getAbiItem({ abi: OCR2_NEW_TRANSMISSION as any, name: 'NewTransmission' });
  const head = await client.getBlockNumber();
  const step = 3_000n;
  const logs: any[] = [];
  let from = opts.fromBlock ?? (head > 50_000n ? head - 50_000n : 0n);
  const to = opts.toBlock ?? head;
  for (let start = to; start >= from && logs.length < opts.limit; start -= step) {
    const end = start;
    const begin = start > step ? start - step + 1n : 0n;
    try {
      const batch = await client.getLogs({ address: opts.aggregator, event: eventAbi as any, fromBlock: begin, toBlock: end } as any);
      logs.push(...batch.reverse()); // newest first -> reverse to process latest first
    } catch {}
  }
  logs.splice(opts.limit);

  if (logs.length === 0) {
    console.log('No transmit logs found in range.');
    return;
  }

  const samples: { ts: number; round: number; answer: number; predicted?: number; absErr?: number; signedErr?: number }[] = [];
  for (const l of logs) {
    const block = await client.getBlock({ blockHash: l.blockHash });
    const ts = Number(block.timestamp);
    const answerRaw = (l.args?.answer ?? l.args?.[1]) as bigint;
    const answer = Number(answerRaw) / Math.pow(10, decimals);
    const predicted = await fetchPredictionAt(opts.predictorUrl, opts.chainId, opts.aggregator, ts, opts.symbol);
    const round = Number((l.args?.aggregatorRoundId ?? l.args?.[0]) as bigint ?? 0n);
    const s: any = { ts, round, answer, predicted };
    if (typeof predicted === 'number') {
      const signedErr = 10_000 * (predicted - answer) / (answer === 0 ? 1 : answer);
      s.signedErr = signedErr;
      s.absErr = Math.abs(signedErr);
    }
    samples.push(s);
  }

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
  console.log(JSON.stringify({ kind: 'summary', count: samples.length, havePred: ok.length, coveragePct: Number(coverage.toFixed(2)), p50AbsErrBps: Number(p50?.toFixed?.(3) ?? 'NaN'), p90AbsErrBps: Number(p90?.toFixed?.(3) ?? 'NaN'), biasBps: Number(bias?.toFixed?.(3) ?? 'NaN'), decimals }));
}

main().catch((e) => { console.error(e); process.exit(1); });

