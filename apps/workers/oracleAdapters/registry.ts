import type { OracleAdapter } from './adapter.js';
import { SingleFeedAdapter } from './adapter.js';

// Simple in-code registry: map (chainId, oracleAddr) to an adapter and params.
// Extend as needed for more markets and adapter types.

export function getAdapter(
  chainId: number,
  oracleAddr: string,
): { adapter: OracleAdapter; decimals: number; scaleFactor: bigint; feedAddr: `0x${string}` } {
  const key = `${chainId}:${oracleAddr.toLowerCase()}`;
  switch (key) {
    // Base cbBTC/USDC oracle (single-feed)
    case `8453:0x852ae0b1af1aaedb0fc4428b4b24420780976ca8`:
      return {
        adapter: new SingleFeedAdapter('BTCUSDC'),
        decimals: 8,
        scaleFactor: 100000000000000000000000000n,
        feedAddr: '0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8',
      };
  }
  // default fallback: single BTCUSDC
  return {
    adapter: new SingleFeedAdapter('BTCUSDC'),
    decimals: 8,
    scaleFactor: 100000000000000000000000000n,
    feedAddr: '0x0000000000000000000000000000000000000000',
  };
}
