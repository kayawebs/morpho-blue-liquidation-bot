import { createPublicClient, http, getAbiItem } from 'viem';
import { base } from 'viem/chains';
import { pool, initSchema } from '../db.js';
import { morphoBlueAbi } from '../../../apps/ponder/abis/MorphoBlue.js';

// Backtest OCR2 aggregator vs CEX price to estimate offset/heartbeat

async function main() {
  await initSchema();

  const chainId = base.id;
  const rpcUrl = process.env.RPC_URL_8453;
  const oracleAddr = process.env.ORACLE_IMPL_ADDR; // e.g., 0x852aE0...
  const scaleFactor = BigInt(process.env.SCALE_FACTOR ?? '100000000000000000000000000');
  const decimals = Number(process.env.ANSWER_DECIMALS ?? '8');

  if (!rpcUrl || !oracleAddr) {
    console.error('Set RPC_URL_8453 and ORACLE_IMPL_ADDR');
    process.exit(1);
  }

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
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

  const toBlock = await client.getBlockNumber();
  const fromBlock = toBlock - 10_000n > 0n ? toBlock - 10_000n : 0n;

  const logs = await client.getLogs({
    address: oracleAddr as `0x${string}`,
    event: newTransmission,
    fromBlock,
    toBlock,
  } as any);

  // For each transmission, fetch closest CEX median price (simple avg here) and compute error_bps
  let samples = 0;
  for (const l of logs as any[]) {
    const ans = Number(l.args.answer) / 10 ** decimals;
    const onchainPrice = Number(scaleFactor) * ans; // 1e36-scaled
    // crude: average the last few seconds of Binance BTCUSDC
    const { rows } = await pool.query(
      `SELECT avg(price)::float AS p FROM cex_ticks WHERE source=$1 AND symbol=$2 AND ts > now() - interval '5 seconds'`,
      ['binance', 'BTCUSDC'],
    );
    const cex = Number(rows[0]?.p);
    if (!Number.isFinite(cex)) continue;
    const errorBps = Math.round(((onchainPrice / (Number(scaleFactor) * cex) - 1) * 10_000));
    await pool.query(
      `INSERT INTO oracle_pred_samples(chain_id, oracle_addr, block_number, tx_hash, answer, cex_price, error_bps)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [chainId, oracleAddr, Number(l.blockNumber), l.transactionHash, ans, cex, errorBps],
    );
    samples += 1;
  }

  console.log(`Backtest done: ${samples} samples`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

