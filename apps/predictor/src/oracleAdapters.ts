import { loadConfig } from './config.js';

export type AggregatedMap = Record<string, number | undefined>;

export interface OracleAdapter {
  requiredSymbols(): string[];
  // Returns predicted answer (float) and 1e36 price bigint string
  compute(params: { agg: AggregatedMap; decimals: number; scaleFactor: bigint }): { answer?: number; price1e36?: bigint };
}

export class SingleFeedAdapter implements OracleAdapter {
  private symbol: string;
  constructor(symbol: string) {
    this.symbol = symbol;
  }
  requiredSymbols(): string[] {
    return [this.symbol];
  }
  compute({ agg, decimals, scaleFactor }: { agg: AggregatedMap; decimals: number; scaleFactor: bigint }) {
    const p = agg[this.symbol];
    if (p === undefined) return {};
    const answer = p; // already in quote units (e.g., USDC)
    const scaled = BigInt(Math.round(answer * 10 ** decimals));
    const price1e36 = scaleFactor * scaled; // 1e36
    return { answer, price1e36 };
  }
}

export function buildAdapter(chainId: number, oracleAddr: string): OracleAdapter {
  const cfg = loadConfig();
  const oc = (cfg as any).oracles?.find((o: any) => Number(o.chainId) === Number(chainId) && o.address.toLowerCase() === oracleAddr.toLowerCase());
  if (oc && oc.type === 'single' && oc.symbol) {
    return new SingleFeedAdapter(oc.symbol);
  }
  // default fallback
  return new SingleFeedAdapter('BTCUSDC');
}

