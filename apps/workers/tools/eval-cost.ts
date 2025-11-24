#!/usr/bin/env tsx
/**
 * Evaluate gas costs for predictive spray attempts.
 * - Computes actual on-chain failure costs over the last N hours by reading
 *   out/worker-tx-failures.ndjson and fetching receipts (effectiveGasPrice).
 * - Estimates worst-case spray costs: for each spray session in out/worker-sessions.ndjson,
 *   assume every tick attempts Top-N (default 5) up to executors count and all fail.
 *
 * Env (optional):
 *   RPC_URL_8453 / RPC_URL          HTTP RPC used to fetch receipts/blocks
 *   EVAL_HOURS                      Lookback window in hours (default 24)
 *   SCHED_SPRAY_CADENCE_MS          Cadence per tick (default 150)
 *   RISK_TOP_N                      Top-N attempted per tick (default 5)
 *   LIQUIDATION_PRIVATE_KEYS_8453   Comma-separated private keys (to infer executors)
 *   LIQUIDATION_PRIVATE_KEY_8453    Single private key fallback
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

function env(k: string, d?: string) { return process.env[k] ?? d; }

const HOURS = Number(env('EVAL_HOURS', '24'));
const CADENCE_MS = Number(env('SCHED_SPRAY_CADENCE_MS', '150'));
const TOP_N = Number(env('RISK_TOP_N', '5'));

function countExecutors(): number {
  const multi = env('LIQUIDATION_PRIVATE_KEYS_8453');
  if (multi && multi.includes(',')) return multi.split(',').map(s => s.trim()).filter(Boolean).length;
  const single = env('LIQUIDATION_PRIVATE_KEY_8453') ?? env('LIQUIDATION_PRIVATE_KEY');
  return single ? 1 : 0;
}

const EXECUTORS = Math.max(1, countExecutors());

const RPC = env('RPC_URL_8453') ?? env('RPC_URL') ?? 'http://127.0.0.1:8545';
const client = createPublicClient({ chain: base, transport: http(RPC) });

type NdFail = { kind: 'onchainFail'; tx: `0x${string}`; gasUsed?: string; ts?: number; blockNumber?: string };
type NdSess = { kind: 'spraySession'; startedAt?: number; endedAt?: number; durationMs?: number };

function loadNdjson<T = any>(p: string): T[] {
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, 'utf8').trim();
  if (raw.length === 0) return [];
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out: T[] = [];
  for (const ln of lines) {
    try { out.push(JSON.parse(ln)); } catch {}
  }
  return out;
}

function median(nums: bigint[]): bigint {
  if (nums.length === 0) return 0n;
  const arr = [...nums].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  return arr[Math.floor(arr.length / 2)]!;
}

async function main() {
  const now = Date.now();
  const sinceMs = now - HOURS * 3600 * 1000;
  const outDir = resolve(process.cwd(), 'out');
  const failsPath = resolve(outDir, 'worker-tx-failures.ndjson');
  const sessPath = resolve(outDir, 'worker-sessions.ndjson');

  const fails = loadNdjson<NdFail>(failsPath).filter(x => x && x.tx);
  const failsWin = fails.filter(x => (x.ts ?? now) >= sinceMs);

  // Fetch receipts to get effectiveGasPrice; dedupe tx hashes
  const uniq = Array.from(new Set(failsWin.map(f => f.tx)));
  const actualGasUsed: bigint[] = [];
  const actualEffPrice: bigint[] = [];
  let actualCost = 0n;

  for (const h of uniq) {
    try {
      const rc = await client.getTransactionReceipt({ hash: h });
      const gasUsed = rc.gasUsed ?? 0n;
      const eff = (rc as any).effectiveGasPrice as bigint ?? 0n;
      actualGasUsed.push(gasUsed);
      actualEffPrice.push(eff);
      actualCost += gasUsed * eff;
    } catch {}
  }

  let medGasUsed = median(actualGasUsed.length ? actualGasUsed : failsWin.map(f => BigInt(f.gasUsed ?? '0')));
  let medEffWei = median(actualEffPrice);
  // Fallbacks when no on-chain attempts yet
  if (medGasUsed === 0n) {
    const est = BigInt(env('WORKER_EST_GASUSED', '120000'));
    medGasUsed = est;
  }
  if (medEffWei === 0n) {
    try {
      const blk = await client.getBlock();
      const base = blk?.baseFeePerGas ?? 0n;
      const prioGwei = Number(env('WORKER_PRIORITY_EST_GWEI', '1.5'));
      const prioWei = BigInt(Math.round(prioGwei * 1e9));
      medEffWei = base + prioWei;
    } catch {}
  }

  // Worst-case per session estimation using median values
  const sessions = loadNdjson<NdSess>(sessPath).filter(x => x && x.kind === 'spraySession');
  const sessionsWin = sessions.filter(s => (s.endedAt ?? now) >= sinceMs);
  const attemptsPerTick = Math.min(TOP_N, EXECUTORS);
  let worstSessionsCost = 0n;
  for (const s of sessionsWin) {
    const durMs = s.durationMs ?? ((s.endedAt ?? now) - (s.startedAt ?? now));
    const ticks = Math.max(0, Math.floor((durMs ?? 0) / Math.max(1, CADENCE_MS)));
    const attempts = BigInt(ticks * attemptsPerTick);
    worstSessionsCost += attempts * medGasUsed * medEffWei;
  }

  // If no sessions were found in the window, provide a naive upper-bound estimate using duty cycle
  if (sessionsWin.length === 0) {
    const duty = Number(env('WORKER_SPRAY_DUTY', '0.10')); // fraction of time spraying
    const ticks = Math.floor((HOURS * 3600 * 1000 * duty) / Math.max(1, CADENCE_MS));
    const attempts = BigInt(ticks * attemptsPerTick);
    worstSessionsCost = attempts * medGasUsed * medEffWei;
  }

  function toEth(x: bigint) { return Number(x) / 1e18; }
  function toGwei(x: bigint) { return Number(x) / 1e9; }

  const summary = {
    rpc: RPC,
    hours: HOURS,
    cadenceMs: CADENCE_MS,
    topN: TOP_N,
    executors: EXECUTORS,
    actual: {
      failures: uniq.length,
      medianGasUsed: medGasUsed.toString(),
      medianEffPriceWei: medEffWei.toString(),
      medianEffPriceGwei: toGwei(medEffWei),
      totalCostWei: actualCost.toString(),
      totalCostEth: toEth(actualCost),
    },
    worstCase: {
      sessions: sessionsWin.length,
      attemptsPerTick,
      medianGasUsed: medGasUsed.toString(),
      medianEffPriceWei: medEffWei.toString(),
      perAttemptWei: (medGasUsed * medEffWei).toString(),
      perAttemptEth: toEth(medGasUsed * medEffWei),
      totalCostWei: worstSessionsCost.toString(),
      totalCostEth: toEth(worstSessionsCost),
    },
  };

  console.log(JSON.stringify(summary));
}

main().catch((e) => { console.error(e); process.exit(1); });
