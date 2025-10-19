export async function fetchAggregatedPrices(predictorUrl: string, symbols: string[]): Promise<Record<string, number | undefined>> {
  const out: Record<string, number | undefined> = {};
  for (const s of symbols) {
    try {
      const res = await fetch(new URL(`/price/${s}`, predictorUrl));
      if (!res.ok) continue;
      const data = (await res.json()) as { aggregatedPrice?: number };
      out[s] = typeof data.aggregatedPrice === 'number' ? data.aggregatedPrice : undefined;
    } catch {
      out[s] = undefined;
    }
  }
  return out;
}

export async function fetchPredictedAt(
  predictorUrl: string,
  chainId: number,
  oracleAddr: string,
  tsSec: number,
  lagSeconds: number,
): Promise<{ answer?: number; price1e36?: string; at: number } | undefined> {
  try {
    const url = new URL(`/oracles/${chainId}/${oracleAddr}/predictionAt`, predictorUrl);
    url.searchParams.set('ts', String(tsSec));
    if (lagSeconds) url.searchParams.set('lag', String(lagSeconds));
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const data = await res.json();
    return { answer: Number(data?.answer), price1e36: data?.price1e36, at: Number(data?.at) };
  } catch {
    return undefined;
  }
}
