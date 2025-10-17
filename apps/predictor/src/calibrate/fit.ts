import '../env.js';
import { pool } from '../db.js';
import { loadConfig } from '../config.js';
import { createPublicClient, http } from 'viem';

function median(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  const arr = [...nums].sort((a, b) => a - b);
  const n = arr.length;
  const idx = n % 2 === 1 ? (n >> 1) : ((n >> 1) - 1);
  return arr[idx];
}

async function calibrateOracle(chainId: number, oracle: string) {
  const cfg = loadConfig();
  const rpc = cfg.rpc[String(chainId)];
  if (!rpc) {
    console.warn(`No RPC for chain ${chainId}, skip calibrate ${oracle}`);
    return false;
  }
  const client = createPublicClient({ transport: http(rpc) });
  // Pull recent samples
  const { rows } = await pool.query(
    `SELECT block_number, error_bps, extract(epoch from event_ts) AS ts
     FROM oracle_pred_samples WHERE chain_id=$1 AND oracle_addr=$2 ORDER BY COALESCE(event_ts, to_timestamp(block_number)) ASC LIMIT 10000`,
    [chainId, oracle],
  );
  if (rows.length === 0) return false;
  const errors = rows.map((r) => Math.abs(Number(r.error_bps))).filter((x) => Number.isFinite(x));
  const offset_bps = Math.max(1, Math.round(median(errors) ?? 50));
  // Use event_ts if present; fallback to fetching block timestamps
  let times: number[] = rows.map((r) => Number(r.ts)).filter((t) => Number.isFinite(t));
  if (times.length !== rows.length) {
    const blocks: number[] = rows.map((r) => Number(r.block_number)).filter((x) => Number.isFinite(x));
    const uniq = Array.from(new Set(blocks));
    const tsMap = new Map<number, number>();
    for (const b of uniq) {
      try {
        const blk = await client.getBlock({ blockNumber: BigInt(b) });
        tsMap.set(b, Number(blk.timestamp));
      } catch {}
    }
    times = blocks.map((b) => tsMap.get(b)!).filter((t) => Number.isFinite(t));
  }
  const gapsSec: number[] = [];
  for (let i = 1; i < times.length; i++) gapsSec.push(times[i]! - times[i - 1]!);
  const hb = Math.max(10, Math.round(median(gapsSec) ?? 60));
  // Upsert into oracle_pred_config; keep decimals/scale if exist
  await pool.query(
    `INSERT INTO oracle_pred_config(chain_id, oracle_addr, heartbeat_seconds, offset_bps, decimals, scale_factor)
     VALUES($1,$2,$3,$4, COALESCE((SELECT decimals FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), 8),
                   COALESCE((SELECT scale_factor FROM oracle_pred_config WHERE chain_id=$1 AND oracle_addr=$2), 1))
     ON CONFLICT (chain_id, oracle_addr) DO UPDATE SET heartbeat_seconds=EXCLUDED.heartbeat_seconds, offset_bps=EXCLUDED.offset_bps, updated_at=now()`,
    [chainId, oracle, hb, offset_bps],
  );
  console.log(`Calibrated oracle ${oracle} on chain ${chainId}: heartbeat=${hb}s, offset=${offset_bps}bps`);
  return true;
}

async function main() {
  const cfg = loadConfig();
  const oracles = (cfg as any).oracles ?? [];
  let ok = 0;
  for (const o of oracles) {
    const res = await calibrateOracle(Number(o.chainId), String(o.address));
    if (res) ok++;
  }
  console.log(`Calibrated ${ok}/${oracles.length} oracles.`);
  try { await pool.end(); } catch {}
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
