import 'dotenv/config';
import { createPublicClient, webSocket } from 'viem';
import { base } from 'viem/chains';

function nowSec() { return Math.floor(Date.now() / 1000); }

function getEnv(name: string, def?: string) {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : def;
}

async function main() {
  const wsUrl = getEnv('WS_RPC_URL_8453') || getEnv('WS_RPC_URL');
  if (!wsUrl) {
    console.error('WS RPC is required. Set WS_RPC_URL_8453 or WS_RPC_URL.');
    process.exit(1);
  }
  const aggregator = (getEnv('AGGREGATOR_ADDRESS_8453') || '0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8').toLowerCase();
  const client = createPublicClient({ chain: base, transport: webSocket(wsUrl, { retryDelay: 1000, retryCount: Infinity }) });

  const seen = new Map<string, { first: number; included?: { blockNumber: bigint; ts: number } }>();

  console.log(JSON.stringify({ kind: 'start', chainId: base.id, ws: wsUrl, aggregator }));

  const unwatch = client.watchPendingTransactions({
    onTransactions: async (hashes) => {
      for (const hash of hashes) {
        if (!hash) continue;
        // Filter only aggregator-bound tx
        try {
          const tx = await client.getTransaction({ hash });
          if (!tx?.to) continue;
          if (tx.to.toLowerCase() !== aggregator) continue;
          if (!seen.has(hash)) {
            seen.set(hash, { first: nowSec() });
            console.log(JSON.stringify({
              kind: 'pendingDetected', hash, from: tx.from, to: tx.to, nonce: Number(tx.nonce),
              maxFeePerGas: tx.maxFeePerGas ? Number(tx.maxFeePerGas) : undefined,
              maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? Number(tx.maxPriorityFeePerGas) : undefined,
            }));
          }
        } catch {}
      }
    },
  });

  const poll = async () => {
    for (const [hash, meta] of seen) {
      if (meta.included) continue;
      try {
        const r = await client.getTransactionReceipt({ hash });
        if (r && r.blockNumber) {
          const delta = nowSec() - meta.first;
          meta.included = { blockNumber: r.blockNumber, ts: nowSec() };
          console.log(JSON.stringify({ kind: 'included', hash, blockNumber: Number(r.blockNumber), status: r.status, delaySec: delta }));
        }
      } catch {}
    }
    setTimeout(poll, 1000);
  };
  void poll();

  process.on('SIGINT', () => { try { unwatch(); } catch {}; process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });

