export interface OracleAdapter {
  requiredSymbols(): string[];
  compute(params: { agg: Record<string, number | undefined>; decimals: number; scaleFactor: bigint }): { answer?: number; price1e36?: bigint };
}

export class SingleFeedAdapter implements OracleAdapter {
  private symbol: string;
  constructor(symbol: string) {
    this.symbol = symbol;
  }
  requiredSymbols(): string[] {
    return [this.symbol];
  }
  compute({ agg, decimals, scaleFactor }: { agg: Record<string, number | undefined>; decimals: number; scaleFactor: bigint }) {
    const p = agg[this.symbol];
    if (p === undefined) return {};
    const answer = p;
    const scaled = BigInt(Math.round(answer * 10 ** decimals));
    const price1e36 = scaleFactor * scaled;
    return { answer, price1e36 };
  }
}

