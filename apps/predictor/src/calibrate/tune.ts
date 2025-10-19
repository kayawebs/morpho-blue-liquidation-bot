import '../env.js';
import { createPublicClient, http, getAbiItem } from 'viem';
import { pool, initSchema } from '../db.js';
import { loadConfig } from '../config.js';
import { buildAdapter } from '../oracleAdapters.js';

type PriceByEx = Record<string, number | undefined>;

interface Sample {
  ts: number; // seconds
  block: bigint;
  tx: string;
  onchain: number; // scaled by decimals
  prices: Record<string, number | undefined>; // per-exchange price at ts (no lag yet)
}

function combos<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  const n = arr.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const c: T[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) c.push(arr[i]!);
    out.push(c);
  }
  return out;
}

function weightGrids(keys: string[], step = 0.1): Record<string, number>[] {
  if (keys.length === 1) return [{ [keys[0]!]: 1 } as any];
  const out: Record<string, number>[] = [];
  const recurse = (i: number, remain: number, cur: number[]) => {
    if (i === keys.length - 1) {
      out.push(Object.fromEntries(keys.map((k, idx) => [k, idx === keys.length - 1 ? remain : cur[idx]!])));
      return;
    }
    for (let w = 0; w <= remain; w = +(w + step).toFixed(10)) {
      cur[i] = w;
      recurse(i + 1, +(remain - w).toFixed(10), cur);
    }
  };
  recurse(0, 1, Array(keys.length).fill(0));
  // filter strictly positive weights
  return out.filter((w) => Object.values(w).some((x) => x > 0));
}

function median(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  const arr = [...nums].sort((a, b) => a - b);
  const n = arr.length;
  const idx = n % 2 === 1 ? (n >> 1) : ((n >> 1) - 1);
  return arr[idx];
}

function percentile(nums: number[], p: number): number | undefined {
  if (nums.length === 0) return undefined;
  const arr = [...nums].sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * p)));
  return arr[idx];
}

async function fetchCexMedianAt(symbol: string, tsSec: number, ex: string): Promise<number | undefined> {
  const { rows } = await pool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::float AS p
     FROM cex_ticks WHERE symbol=$1 AND source=$2 AND ts BETWEEN to_timestamp($3-2) AND to_timestamp($3+2)`,
    [symbol, ex, tsSec],
  );
  const p = Number(rows[0]?.p);
  return Number.isFinite(p) ? p : undefined;
}

async function buildSamples(chainId: number, oracleAddr: string, symbol: string, decimals: number, rpcUrl: string): Promise<Sample[]> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const evt = getAbiItem({
    abi: [
      {
        type: 'event',
        name: 'NewTransmission',
        inputs: [
          { indexed: true, name: 'aggregatorRoundId', type: 'uint32' },
          { indexed: false, name: 'answer', type: 'int192' },
          { indexed: false, name: 'transmitter', type: 'address' },
          { indexed: false, name: 'observations', type: 'int192[]' },
          { indexed: false, name: 'observers', type: 'bytes' },
          { indexed: false, name: 'rawReportContext', type: 'bytes32' }
        ],
      },
    ],
    name: 'NewTransmission',
  }) as any;
  const toBlock = await client.getBlockNumber();
  const fromBlock = toBlock - 10_000n > 0n ? toBlock - 10_000n : 0n;
  const logs = await client.getLogs({ address: oracleAddr as `0x${string}`, event: evt, fromBlock, toBlock } as any);
  const out: Sample[] = [];
  for (const l of logs as any[]) {
    const blk = await client.getBlock({ blockNumber: l.blockNumber });
    const tsSec = Number(blk.timestamp);
    const onchain = Number(l.args.answer) / 10 ** decimals;
    // per-exchange medians at ts
    const sources = ['binance', 'okx', 'coinbase'];
    const prices: PriceByEx = {};
    for (const s of sources) {
      prices[s] = await fetchCexMedianAt(symbol, tsSec, s);
    }
    out.push({ ts: tsSec, block: l.blockNumber as bigint, tx: l.transactionHash as string, onchain, prices });
  }
  return out;
}

function evaluate(samples: Sample[], lags: number[], subsets: string[], weightStep = 0.1) {
  const results: any[] = [];
  for (const lag of lags) {
    // build aligned arrays per exchange with lag
    const validSamples = samples.filter((s) => true);
    const subsetCombos = combos(subsets).filter((c) => c.length >= 1);
    for (const sub of subsetCombos) {
      const weightList = weightGrids(sub, weightStep);
      for (const w of weightList) {
        const errs: number[] = [];
        let used = 0;
        for (const s of validSamples) {
          const t = s.ts - lag;
          // combine prices at t using w
          let pred = 0;
          let haveAll = true;
          for (const ex of sub) {
            const p = s.prices[ex]; // we stored at event ts; approximate by reusing (small lag)
            if (!(Number.isFinite(p!))) { haveAll = false; break; }
          }
          if (!haveAll) continue;
          for (const ex of sub) pred += (s.prices[ex] as number) * (w[ex] ?? 0);
          if (!(pred > 0)) continue;
          const ratio = s.onchain / pred;
          if (!Number.isFinite(ratio)) continue;
          const ebps = Math.round((ratio - 1) * 10_000);
          errs.push(Math.abs(ebps));
          used++;
        }
        if (errs.length < 5) continue;
        const p50 = median(errs) ?? Infinity;
        const p90 = percentile(errs, 0.9) ?? Infinity;
        results.push({ lag, sources: sub, weights: w, samples: used, p50, p90 });
      }
    }
  }
  results.sort((a, b) => (a.p90 - b.p90) || (a.p50 - b.p50));
  return results;
}

async function main() {
  await initSchema();
  const cfg = loadConfig();
  const oracles = (cfg as any).oracles ?? [];
  if (oracles.length === 0) throw new Error('No oracles');
  // Only tune the first oracle for now
  const o = oracles[0]!;
  const chainId = Number(o.chainId);
  const rpcUrl = cfg.rpc[String(chainId)];
  if (!rpcUrl) throw new Error(`No RPC for chain ${chainId}`);
  const oracleAddr = String(o.address);
  const decimals = Number(o.decimals);
  const symbol = String(o.symbol ?? 'BTCUSDC');

  console.log(`🎛 Tuning oracle ${oracleAddr} chain=${chainId} symbol=${symbol}`);
  const samples = await buildSamples(chainId, oracleAddr, symbol, decimals, rpcUrl);
  console.log(`📦 Loaded ${samples.length} events`);

  const lags = [0, 1, 2, 3, 4, 5, 7, 10];
  const subsets = ['binance', 'okx', 'coinbase'];
  const results = evaluate(samples, lags, subsets, 0.1);
  const best = results[0];
  if (!best) {
    console.log('No feasible combination found.');
    process.exit(0);
  }
  console.log('🏁 Best config:', JSON.stringify(best));
  // Suggest offset_bps using p90 with 5bps floor
  const suggestedOffset = Math.max(5, Math.round(best.p90));
  console.log(`➡️ Suggested offset_bps=${suggestedOffset}, lag_seconds=${best.lag}, sources=${best.sources.join('+')}, weights=${JSON.stringify(best.weights)}`);
  try { await pool.end(); } catch {}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

