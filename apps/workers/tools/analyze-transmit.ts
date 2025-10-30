// Offline analyzer for a specific OCR2 NewTransmission tx.
// Reconstructs event context and evaluates liquidatability at that block.
// Usage:
//   tsx apps/workers/tools/analyze-transmit.ts --env-file=.env 0x<txHash>
// Env:
//   RPC_URL_8453 (HTTP), optional PONDER_API_URL, AGGREGATOR_ADDRESS_8453

import 'dotenv/config';
import { base } from 'viem/chains';
import { createPublicClient, http, getAbiItem, decodeEventLog, type Address } from 'viem';
import { morphoBlueAbi } from '../../ponder/abis/MorphoBlue.js';
import { getAdapter } from '../oracleAdapters/registry.js';

const TX = process.argv.find((a) => a.startsWith('0x')) as `0x${string}` | undefined;
const RPC = process.env.RPC_URL_8453 || process.env.RPC_URL || '';
const AGG = (process.env.AGGREGATOR_ADDRESS_8453 || '0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8') as `0x${string}`;

// Market constants (Base cbBTC/USDC)
const CHAIN_ID = base.id;
const MARKET_ID = '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836' as const;
const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;
const PONDER_API = process.env.PONDER_API_URL || 'http://localhost:42069';

if (!TX) {
  console.error('Usage: tsx apps/workers/tools/analyze-transmit.ts --env-file=.env 0x<txHash>');
  process.exit(1);
}
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

async function gatherCandidates(client: any, blockNumber: bigint): Promise<Address[]> {
  // Prefer Ponder API
  try {
    const res = await fetch(new URL(`/chain/${CHAIN_ID}/candidates`, PONDER_API), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketIds: [MARKET_ID] }),
    });
    if (res.ok) {
      const data = (await res.json()) as Record<string, Address[]>;
      const arr = (data[MARKET_ID] ?? []).map((a) => a.toLowerCase()) as Address[];
      if (arr.length > 0) return arr;
    }
  } catch {}
  // Fallback: scan recent logs to assemble candidate set
  const out = new Set<string>();
  const fromBlock = blockNumber > 5_000n ? blockNumber - 5_000n : 0n;
  const borrowEvent = getAbiItem({ abi: morphoBlueAbi, name: 'Borrow' }) as any;
  const supplyColEvent = getAbiItem({ abi: morphoBlueAbi, name: 'SupplyCollateral' }) as any;
  const step = 2000n;
  for (let start = fromBlock; start <= blockNumber; start += step) {
    const end = start + step - 1n > blockNumber ? blockNumber : start + step - 1n;
    try {
      const [borrows, supplies] = await Promise.all([
        client.getLogs({ address: MORPHO, event: borrowEvent, args: { id: MARKET_ID as any }, fromBlock: start, toBlock: end } as any),
        client.getLogs({ address: MORPHO, event: supplyColEvent, args: { id: MARKET_ID as any }, fromBlock: start, toBlock: end } as any),
      ]);
      for (const l of borrows as any[]) out.add(String(l.args.onBehalf).toLowerCase());
      for (const l of supplies as any[]) out.add(String(l.args.onBehalf).toLowerCase());
    } catch {}
  }
  return [...out] as Address[];
}

async function main() {
  const client = createPublicClient({ transport: http(RPC) });
  const receipt = await client.getTransactionReceipt({ hash: TX! });
  const blk = await client.getBlock({ blockNumber: receipt.blockNumber! });
  const ts = Number(blk.timestamp);
  const log = receipt.logs.find((l) => (l.address as string).toLowerCase() === AGG.toLowerCase());
  if (!log) throw new Error('No aggregator log in tx');
  const dec = decodeEventLog({ abi: [OCR2_EVENT], data: log.data, topics: log.topics as any });
  const args: any = dec.args ?? {};
  const roundId = (args?.aggregatorRoundId as any)?.toString?.() ?? String(args?.aggregatorRoundId);
  const answerRaw = args?.answer as bigint | undefined;
  if (typeof answerRaw !== 'bigint') throw new Error('answerRaw not bigint');
  const { scaleFactor, decimals } = getAdapter(CHAIN_ID, AGG);
  const price1e36 = scaleFactor * answerRaw;

  // Fetch previous transmit (for classification)
  let prevAnswer: number | undefined;
  try {
    const prevLogs = await client.getLogs({ address: AGG, event: OCR2_EVENT, fromBlock: (receipt.blockNumber! > 2000n ? receipt.blockNumber! - 2000n : 0n), toBlock: receipt.blockNumber! } as any);
    const filtered = (prevLogs as any[])
      .filter((l) => (l.blockNumber < (receipt.blockNumber as bigint)) || (l.blockNumber === receipt.blockNumber && (l.logIndex ?? 0) < (log.logIndex ?? 0)))
      .sort((a, b) => (a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : Number(a.blockNumber - b.blockNumber)));
    const last = filtered[filtered.length - 1];
    if (last) {
      const d = decodeEventLog({ abi: [OCR2_EVENT], data: last.data, topics: last.topics as any });
      const ansPrev = d.args?.answer as bigint;
      prevAnswer = Number(ansPrev) / 10 ** decimals;
    }
  } catch {}

  // Read market params/view at block
  const [paramsRaw, viewRaw] = await Promise.all([
    client.readContract({ address: MORPHO, abi: morphoBlueAbi, functionName: 'idToMarketParams', args: [MARKET_ID], blockNumber: receipt.blockNumber! } as any),
    client.readContract({ address: MORPHO, abi: morphoBlueAbi, functionName: 'market', args: [MARKET_ID], blockNumber: receipt.blockNumber! } as any),
  ]);
  const mp = Array.isArray(paramsRaw)
    ? { loanToken: paramsRaw[0], collateralToken: paramsRaw[1], oracle: paramsRaw[2], irm: paramsRaw[3], lltv: paramsRaw[4] }
    : (paramsRaw as any);
  const mp2 = { ...mp, lltv: typeof (mp as any).lltv === 'bigint' ? (mp as any).lltv : BigInt((mp as any).lltv) } as any;
  const view = Array.isArray(viewRaw)
    ? { totalSupplyAssets: viewRaw[0], totalSupplyShares: viewRaw[1], totalBorrowAssets: viewRaw[2], totalBorrowShares: viewRaw[3], lastUpdate: viewRaw[4], fee: viewRaw[5] }
    : (viewRaw as any);
  const MarketNS = await import('@morpho-org/blue-sdk');
  const marketObj = new (MarketNS as any).Market({
    chainId: CHAIN_ID,
    id: MARKET_ID as any,
    params: new (MarketNS as any).MarketParams(mp2),
    price: price1e36,
    totalSupplyAssets: view.totalSupplyAssets,
    totalSupplyShares: view.totalSupplyShares,
    totalBorrowAssets: view.totalBorrowAssets,
    totalBorrowShares: view.totalBorrowShares,
    lastUpdate: view.lastUpdate,
    fee: view.fee,
  }).accrueInterest(String(ts));

  // Candidates
  const candidates = await gatherCandidates(client, receipt.blockNumber!);
  const viable: { user: Address; seizable: bigint }[] = [];
  for (const user of candidates) {
    try {
      const pos = (await client.readContract({ address: MORPHO, abi: morphoBlueAbi, functionName: 'position', args: [MARKET_ID, user], blockNumber: receipt.blockNumber! } as any)) as { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
      if (pos.borrowShares === 0n) continue;
      const iposition = { chainId: CHAIN_ID, marketId: MARKET_ID as any, user, supplyShares: pos.supplyShares, borrowShares: pos.borrowShares, collateral: pos.collateral } as any;
      const ap = new (MarketNS as any).AccrualPosition(iposition, marketObj);
      const seize = (ap as any).seizableCollateral as bigint | undefined;
      if (typeof seize === 'bigint' && seize > 0n) viable.push({ user, seizable: seize });
    } catch {}
  }
  viable.sort((a, b) => (a.seizable === b.seizable ? 0 : a.seizable > b.seizable ? -1 : 1));
  const top = viable.slice(0, 10).map((v) => ({ user: v.user, seizable: v.seizable.toString() }));

  // Classify event type and delta
  const curAns = Number(answerRaw) / 10 ** decimals;
  const deltaBps = prevAnswer ? Math.round(((curAns / prevAnswer) - 1) * 10_000) : undefined;

  const out = {
    tx: TX,
    block: (receipt.blockNumber as bigint).toString(),
    ts,
    roundId,
    onchainAnswer: curAns,
    deltaBps,
    candidates: candidates.length,
    viable: viable.length,
    top,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

