import { createPublicClient, http, getAbiItem } from 'viem';
import { pool, initSchema } from '../db.js';
import { morphoBlueAbi } from '../../../apps/ponder/abis/MorphoBlue.js';
import { loadConfig } from '../config.js';
import { buildAdapter } from '../oracleAdapters.js';

// Backtest OCR2 aggregator vs CEX price to estimate offset/heartbeat

async function main() {
  await initSchema();

  const cfg = loadConfig();
  const oracles = (cfg as any).oracles ?? [];
  if (!oracles.length) {
    console.error('No oracles in config.json');
    process.exit(1);
  }
  const newTransmission = getAbiItem({
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

  let total = 0;
  for (const o of oracles) {
    const chainId = Number(o.chainId);
    const rpcUrl = cfg.rpc[String(chainId)];
    if (!rpcUrl) {
      console.warn(`No RPC for chain ${chainId}, skip ${o.address}`);
      continue;
    }
    const oracleAddr = String(o.address);
    const scaleFactor = BigInt(String(o.scaleFactor));
    const decimals = Number(o.decimals);
    const adapter = buildAdapter(chainId, oracleAddr);
    const client = createPublicClient({ transport: http(rpcUrl) });
  const toBlock = await client.getBlockNumber();
  const fromBlock = toBlock - 10_000n > 0n ? toBlock - 10_000n : 0n;
  const logs = await client.getLogs({ address: oracleAddr as `0x${string}`, event: newTransmission, fromBlock, toBlock } as any);
    let samples = 0;
    for (const l of logs as any[]) {
      const ans = Number(l.args.answer) / 10 ** decimals;
      // 取事件块时间戳为 event_ts
      const blk = await client.getBlock({ blockNumber: l.blockNumber });
      const tsSec = Number(blk.timestamp);
      // 根据 adapter 所需符号，计算每个符号在 ±2s 窗口的中位数，组装 aggMap
      const required = adapter.requiredSymbols();
      const aggMap: Record<string, number | undefined> = {};
      let missing = false;
      for (const sym of required) {
        const { rows } = await pool.query(
          `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::float AS p
           FROM cex_ticks WHERE symbol=$1 AND ts BETWEEN to_timestamp($2-2) AND to_timestamp($2+2)`,
          [sym, tsSec],
        );
        const p = Number(rows[0]?.p);
        if (!Number.isFinite(p)) {
          missing = true;
          break;
        }
        aggMap[sym] = p;
      }
      if (missing) continue;
      // 用 adapter.compute() 得到预测价
      const { answer: pred } = adapter.compute({ agg: aggMap, decimals, scaleFactor });
      if (!Number.isFinite(pred)) continue;
      const errorBps = Math.round(((ans / (pred as number) - 1) * 10_000));
      await pool.query(
        `INSERT INTO oracle_pred_samples(chain_id, oracle_addr, block_number, tx_hash, answer, cex_price, error_bps)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [chainId, oracleAddr, Number(l.blockNumber), l.transactionHash, ans, pred, errorBps],
      );
      // 写回 event_ts
      await pool.query(`UPDATE oracle_pred_samples SET event_ts=to_timestamp($1) WHERE tx_hash=$2`, [tsSec, l.transactionHash]);
      samples += 1;
    }
    total += samples;
    console.log(`Backtest oracle ${oracleAddr} on chain ${chainId}: ${samples} samples`);
  }
  console.log(`Backtest done: total ${total} samples`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
