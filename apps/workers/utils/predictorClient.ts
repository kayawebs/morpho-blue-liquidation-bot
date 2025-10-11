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

