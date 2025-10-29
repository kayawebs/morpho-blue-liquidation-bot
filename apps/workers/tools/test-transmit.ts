// Quick test for OCR2 NewTransmission parsing & latestRoundData handling
import 'dotenv/config';
// Usage:
//   tsx apps/workers/tools/test-transmit.ts --env-file=.env 0x<txHash>
// Env:
//   RPC_URL_8453, AGGREGATOR_ADDRESS_8453 (optional, defaults to BTCUSDC aggregator)

import { createPublicClient, http, getAbiItem, decodeEventLog } from 'viem';
import { getAdapter } from '../oracleAdapters/registry.js';

const TX = process.argv.find((a) => a.startsWith('0x')) ?? '0x785c99eb6cca67a0a42a77977ea7dfa317d9b2acab1da43702cf9dc09af4b4ef';
const RPC = process.env.RPC_URL_8453 || process.env.RPC_URL || '';
const AGG = (process.env.AGGREGATOR_ADDRESS_8453 || '0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8') as `0x${string}`;

if (!RPC) {
  console.error('Missing RPC_URL_8453 in env');
  process.exit(1);
}

const OCR2_EVENT = getAbiItem({
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
        { indexed: false, name: 'rawReportContext', type: 'bytes32' },
      ],
    },
  ],
  name: 'NewTransmission',
}) as any;

async function main() {
  const client = createPublicClient({ transport: http(RPC) });
  const receipt = await client.getTransactionReceipt({ hash: TX as `0x${string}` });
  console.log('tx.blockNumber =', receipt.blockNumber?.toString());
  // Find matching log for aggregator
  const log = receipt.logs.find((l) => (l.address as string).toLowerCase() === AGG.toLowerCase());
  if (!log) {
    console.error('No log from aggregator in this tx');
    process.exit(1);
  }
  // Decode event
  const decoded = decodeEventLog({
    abi: [OCR2_EVENT],
    data: log.data,
    topics: log.topics as any,
  });
  console.log('decoded.name =', decoded.eventName);
  const args: any = decoded.args;
  const aggRoundId = args?.aggregatorRoundId as number | bigint | undefined;
  const answerRaw = args?.answer as bigint | undefined;
  console.log('aggregatorRoundId =', aggRoundId?.toString?.() ?? String(aggRoundId));
  console.log('answerRaw (int192) =', answerRaw?.toString?.());

  // Compute price1e36 using adapter params (decimals & scaleFactor)
  const { decimals, scaleFactor } = getAdapter(8453, AGG);
  if (typeof answerRaw !== 'bigint') {
    console.error('answerRaw is not bigint');
    process.exit(1);
  }
  const onchain = Number(answerRaw) / 10 ** decimals;
  const price1e36 = scaleFactor * answerRaw; // keep full precision path (1e36)
  console.log('decimals =', decimals);
  console.log('scaleFactor =', scaleFactor.toString());
  console.log('onchain (float) =', onchain);
  console.log('price1e36 (bigint) =', price1e36.toString());

  // Also print block timestamp for reference
  const blk = await client.getBlock({ blockNumber: receipt.blockNumber! });
  console.log('block.timestamp =', Number(blk.timestamp));
  console.log('OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
