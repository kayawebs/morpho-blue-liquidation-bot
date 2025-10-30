// Lightweight in-memory cache for aggregated 100ms prices (near-window priority).
// Stores per-symbol bins for the last retainMs (default 120s).

type Bin = { ts: number; price: number };

const DEFAULT_RETAIN_MS = 120_000; // 120s
let retainMs = DEFAULT_RETAIN_MS;

try {
  const v = Number(process.env.PREDICTOR_MEM_RETAIN_MS);
  if (Number.isFinite(v) && v > 1000) retainMs = v;
} catch {}

const store: Map<string, Bin[]> = new Map();

export function recordAgg100ms(symbol: string, tsMs: number, price: number) {
  let arr = store.get(symbol);
  if (!arr) {
    arr = [];
    store.set(symbol, arr);
  }
  // Append if strictly increasing; replace if same bin
  const last = arr[arr.length - 1];
  if (last && last.ts === tsMs) {
    last.price = price;
  } else if (!last || tsMs > last.ts) {
    arr.push({ ts: tsMs, price });
  } else {
    // Out-of-order (rare) — insert at position to keep sorted
    let i = arr.length - 1;
    while (i >= 0 && arr[i]!.ts > tsMs) i--;
    arr.splice(i + 1, 0, { ts: tsMs, price });
  }
  // Trim old bins beyond retention window
  const cutoff = tsMs - retainMs;
  let idx = 0;
  while (idx < arr.length && arr[idx]!.ts < cutoff) idx++;
  if (idx > 0) arr.splice(0, idx);
}

export function getPrice100msLeft(symbol: string, tsMs: number): number | undefined {
  const arr = store.get(symbol);
  if (!arr || arr.length === 0) return undefined;
  // Walk from end to find the greatest ts <= tsMs
  for (let i = arr.length - 1; i >= 0; i--) {
    const b = arr[i]!;
    if (b.ts <= tsMs) return b.price;
  }
  return undefined;
}

export function getPrice100msNearest(symbol: string, tsMs: number, maxDeltaMs = 300): number | undefined {
  const arr = store.get(symbol);
  if (!arr || arr.length === 0) return undefined;
  // Binary-like search via linear scan is fine for ~1200 bins (120s @ 100ms)
  let best: Bin | undefined;
  let bestDelta = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i]!;
    const d = Math.abs(b.ts - tsMs);
    if (d < bestDelta) { bestDelta = d; best = b; }
  }
  if (best && bestDelta <= maxDeltaMs) return best.price;
  return undefined;
}

export function stats() {
  const out: Record<string, { bins: number; oldestMs?: number; newestMs?: number }> = {};
  for (const [k, arr] of store) {
    out[k] = { bins: arr.length, oldestMs: arr[0]?.ts, newestMs: arr[arr.length - 1]?.ts };
  }
  return { symbols: Object.keys(out).length, retainMs, details: out };
}

