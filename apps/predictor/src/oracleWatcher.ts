import { createPublicClient, http, getAbiItem } from 'viem';
import { pool } from './db.js';
import { loadConfig } from './config.js';
import { buildAdapter } from './oracleAdapters.js';

async function medianAt(symbol: string, tsSec: number, source?: string): Promise<number | undefined> {
  const q = source
    ? `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::float AS p FROM cex_ticks WHERE symbol=$1 AND source=$2 AND ts BETWEEN to_timestamp($3-2) AND to_timestamp($3+2)`
    : `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::float AS p FROM cex_ticks WHERE symbol=$1 AND ts BETWEEN to_timestamp($2-2) AND to_timestamp($2+2)`;
  const params = source ? [symbol, source, tsSec] : [symbol, tsSec];
  const { rows } = await pool.query(q, params as any);
  const p = Number(rows[0]?.p);
  return Number.isFinite(p) ? p : undefined;
}

async function getOracleWeights(chainId: number, addr: string): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `SELECT source, weight FROM oracle_cex_weights WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)`,
    [chainId, addr],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.source).toLowerCase()] = Number(r.weight);
  return out;
}

export async function startOracleWatcher() {
  const cfg = loadConfig();
  const oracles: any[] = (cfg as any).oracles ?? [];
  if (!oracles.length) return;
  const evt = getAbiItem({
    abi: [
      { type: 'event', name: 'NewTransmission', inputs: [
        { indexed: true, name: 'aggregatorRoundId', type: 'uint32' },
        { indexed: false, name: 'answer', type: 'int192' },
        { indexed: false, name: 'transmitter', type: 'address' },
        { indexed: false, name: 'observations', type: 'int192[]' },
        { indexed: false, name: 'observers', type: 'bytes' },
        { indexed: false, name: 'rawReportContext', type: 'bytes32' },
      ]},
    ],
    name: 'NewTransmission',
  }) as any;
  for (const o of oracles) {
    const chainId = Number(o.chainId);
    const rpc = cfg.rpc[String(chainId)];
    if (!rpc) continue;
    const client = createPublicClient({ transport: http(rpc) });
    const addr = String(o.address);
    const decimals = Number(o.decimals);
    const adapter = buildAdapter(chainId, addr);
    const symbol = String(o.symbol ?? 'BTCUSDC');
    // polling watch: every 30s scan new logs
    let last: bigint | undefined;
    const tick = async () => {
      try {
        const head = await client.getBlockNumber();
        const from = last ? (last + 1n) : (head > 1000n ? head - 1000n : 0n);
        const logs = await client.getLogs({ address: addr as `0x${string}`, event: evt, fromBlock: from, toBlock: head } as any);
        for (const l of logs as any[]) {
          last = l.blockNumber as bigint;
          // Compute event timestamp
          const blk = await client.getBlock({ blockNumber: l.blockNumber });
          const tsSec = Number(blk.timestamp);
          const onchain = Number(l.args.answer) / 10 ** decimals;
          // Build per-symbol price using per-oracle weights if available; else fallback to global medians
          const weights = await getOracleWeights(chainId, addr);
          let combined: number | undefined;
          if (Object.keys(weights).length > 0) {
            let num = 0, den = 0;
            for (const [src, w] of Object.entries(weights)) {
              const p = await medianAt(symbol, tsSec, src);
              if (p !== undefined && w > 0) { num += p * w; den += w; }
            }
            combined = den > 0 ? num / den : undefined;
          } else {
            combined = await medianAt(symbol, tsSec);
          }
          if (combined === undefined) continue;
          const aggMap: Record<string, number> = { [symbol]: combined };
          const { answer: pred } = adapter.compute({ agg: aggMap, decimals, scaleFactor: BigInt(String(o.scaleFactor)) });
          if (!Number.isFinite(pred!)) continue;
          const ratio = onchain / (pred as number);
          if (!Number.isFinite(ratio)) continue;
          const errorBps = Math.round((ratio - 1) * 10_000);
          // insert sample
          await pool.query(
            `INSERT INTO oracle_pred_samples(chain_id, oracle_addr, block_number, tx_hash, answer, cex_price, error_bps, event_ts)
             VALUES($1,$2,$3,$4,$5,$6,$7, to_timestamp($8))
             ON CONFLICT DO NOTHING`,
            [chainId, addr, Number(l.blockNumber), l.transactionHash, onchain, pred, errorBps, tsSec],
          );
        }
      } catch {}
      setTimeout(tick, 30_000);
    };
    tick();
    console.log(`🔔 Oracle watcher started for ${addr} on chain ${chainId}`);
  }
}

