import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.js';

export interface PredictorConfig {
  exchanges: string[];
  pairs: { symbol: string; binance?: string; okx?: string; coinbase?: string }[];
  aggregator: { windowMs: number };
  db: { url: string };
  rpc: Record<string, string>;
  service: { port: number };
}

export function loadConfig(): PredictorConfig {
  // Resolve relative to this package directory (apps/predictor)
  const here = dirname(fileURLToPath(import.meta.url));
  const p = resolve(here, '../config.json');
  const raw = readFileSync(p, 'utf8');
  const cfg = JSON.parse(raw) as PredictorConfig;
  // Override RPCs from environment variables RPC_URL_<CHAIN_ID>
  const env = process.env;
  const rpc = { ...(cfg.rpc ?? {}) } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^RPC_URL_(\d+)$/);
    if (m && v) {
      rpc[m[1]!] = v;
    }
  }
  // Also ensure any oracle chainId picks up env RPC if provided
  try {
    const oracles = (cfg as any).oracles ?? [];
    for (const o of oracles) {
      const id = String(o.chainId);
      const v = env[`RPC_URL_${id}`];
      if (v) rpc[id] = v;
    }
  } catch {}
  (cfg as any).rpc = rpc;
  return cfg;
}
