import 'dotenv/config';
import { createPublicClient, http, getAbiItem } from 'viem';
import pg from 'pg';
import { chainConfig } from '@morpho-blue-liquidation-bot/config';
import { morphoBlueAbi } from '../../abis/MorphoBlue';
import { preLiquidationFactoryAbi } from '../../abis/PreLiquidationFactory';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Hex = `0x${string}`;

function env(name: string, def?: string) {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : def;
}

function parseFastOnlyMarkets(): Set<string> {
  const s = env('FAST_ONLY_MARKETS');
  if (s && s.trim() !== '') return new Set(s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  try {
    const raw = readFileSync(resolve(process.cwd(), 'markets.json'), 'utf8');
    const j = JSON.parse(raw) as { markets?: string[] };
    if (Array.isArray(j.markets) && j.markets.length > 0) return new Set(j.markets.map((x) => x.toLowerCase()));
  } catch {}
  return new Set();
}

async function main() {
  const chainId = Number(env('BACKFILL_CHAIN_ID', '8453'));
  const lookbackBlocks = BigInt(env('BACKFILL_LOOKBACK_BLOCKS', '200000')!);
  const chunkBlocks = BigInt(env('BACKFILL_CHUNK_BLOCKS', '4000')!);
  const cfg = chainConfig(chainId);
  const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
  const dbUrl = env('POSTGRES_DATABASE_URL') ?? env('DATABASE_URL') ?? 'postgres://ponder:ponder@localhost:5432/ponder';
  const schema = env('PONDER_DB_SCHEMA') ?? env('DATABASE_SCHEMA') ?? 'mblb_ponder';
  const pool = new pg.Pool({ connectionString: dbUrl });
  const fastMarkets = parseFastOnlyMarkets();

  const factoryAddr = cfg.preLiquidationFactory.address.toLowerCase() as Hex;
  const morphoAddr = cfg.morpho.address.toLowerCase() as Hex;

  // cache block timestamp by blockNumber
  const tsCache = new Map<bigint, number>();
  async function tsOf(blockNumber: bigint): Promise<number> {
    const hit = tsCache.get(blockNumber);
    if (hit) return hit;
    const blk = await client.getBlock({ blockNumber });
    const ts = Number(blk.timestamp);
    tsCache.set(blockNumber, ts);
    return ts;
  }

  // Build preLiq address -> marketId map from DB (existing rows) to aid authorization mapping
  async function loadPreMap(): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    try {
      const res = await pool.query(`select lower(address) as addr, market_id from ${schema}.pre_liquidation_contract where chain_id=$1`, [chainId]);
      for (const r of res.rows) m.set(String(r.addr), String(r.market_id));
    } catch {}
    return m;
  }
  const preMap = await loadPreMap();

  // 1) Backfill CreatePreLiquidation
  const evtCreate = getAbiItem({ abi: preLiquidationFactoryAbi, name: 'CreatePreLiquidation' });
  const head = await client.getBlockNumber();
  const from = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  console.log(`Backfill CreatePreLiquidation ${factoryAddr} blocks ${from}-${head} chunk=${chunkBlocks}`);
  for (let start = from; start <= head; start += chunkBlocks) {
    const to = start + chunkBlocks - 1n > head ? head : start + chunkBlocks - 1n;
    const logs = await client.getLogs({ address: factoryAddr, event: evtCreate as any, fromBlock: start, toBlock: to } as any);
    if (logs.length) {
      const rows: any[] = [];
      for (const l of logs as any[]) {
        const id = (l.args.id as string).toLowerCase();
        if (fastMarkets.size && !fastMarkets.has(id)) continue;
        const addr = (l.args.preLiquidation as string).toLowerCase();
        rows.push({
          marketId: id,
          address: addr,
          preLltv: String(l.args.preLiquidationParams.preLltv),
          preLCF1: String(l.args.preLiquidationParams.preLCF1),
          preLCF2: String(l.args.preLiquidationParams.preLCF2),
          preLIF1: String(l.args.preLiquidationParams.preLIF1),
          preLIF2: String(l.args.preLiquidationParams.preLIF2),
          preOracle: (l.args.preLiquidationParams.preLiquidationOracle as string).toLowerCase(),
        });
      }
      if (rows.length) {
        const text = `insert into ${schema}.pre_liquidation_contract
          (chain_id, market_id, address, pre_lltv, pre_lcf1, pre_lcf2, pre_lif1, pre_lif2, pre_liquidation_oracle)
          values ${rows.map((_, i) => `($1,$${i*9+2},$${i*9+3},$${i*9+4},$${i*9+5},$${i*9+6},$${i*9+7},$${i*9+8},$${i*9+9})`).join(',')}
          on conflict (chain_id, market_id, address) do nothing`;
        const values: any[] = [chainId];
        for (const r of rows) values.push(r.marketId, r.address, r.preLltv, r.preLCF1, r.preLCF2, r.preLIF1, r.preLIF2, r.preOracle);
        await pool.query(text, values);
        for (const r of rows) preMap.set(r.address, r.marketId);
        console.log(`  + contracts ${rows.length} @ ${start}-${to}`);
      }
    }
  }

  // 2) Backfill SetAuthorization
  const evtAuth = getAbiItem({ abi: morphoBlueAbi as any, name: 'SetAuthorization' });
  console.log(`Backfill SetAuthorization ${morphoAddr} blocks ${from}-${head} chunk=${chunkBlocks}`);
  for (let start = from; start <= head; start += chunkBlocks) {
    const to = start + chunkBlocks - 1n > head ? head : start + chunkBlocks - 1n;
    const logs = await client.getLogs({ address: morphoAddr, event: evtAuth as any, fromBlock: start, toBlock: to } as any);
    if (!logs.length) continue;
    // collect per-log
    const rows: any[] = [];
    for (const l of logs as any[]) {
      const authorizer = (l.args.authorizer as string).toLowerCase();
      const authorized = (l.args.authorized as string).toLowerCase();
      const isAuth = Boolean(l.args.newIsAuthorized);
      const marketId = preMap.get(authorized);
      if (!marketId) continue; // only care pre-liq contracts we know (by factory)
      if (fastMarkets.size && !fastMarkets.has(marketId)) continue;
      const ts = await tsOf(l.blockNumber);
      rows.push({ marketId, user: authorizer, pre: authorized, isAuth, block: l.blockNumber, ts });
    }
    if (!rows.length) continue;
    // upsert with monotonic block condition
    const text = `insert into ${schema}.pre_liquidation_position
      (chain_id, market_id, user, pre_liquidation, is_authorized, updated_block, updated_timestamp)
      values ${rows.map((_, i) => `($1,$${i*7+2},$${i*7+3},$${i*7+4},$${i*7+5},$${i*7+6},$${i*7+7})`).join(',')}
      on conflict (chain_id, market_id, user, pre_liquidation)
      do update set is_authorized=EXCLUDED.is_authorized, updated_block=EXCLUDED.updated_block, updated_timestamp=EXCLUDED.updated_timestamp
      where ${schema}.pre_liquidation_position.updated_block < EXCLUDED.updated_block`;
    const values: any[] = [chainId];
    for (const r of rows) values.push(r.marketId, r.user, r.pre, r.isAuth, String(r.block), String(r.ts));
    await pool.query(text, values);
    console.log(`  + auth ${rows.length} @ ${start}-${to}`);
  }

  await pool.end();
  console.log('Backfill done.');
}

main().catch((e) => { console.error(e); process.exit(1); });

