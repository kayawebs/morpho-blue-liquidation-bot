import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return cfg;
}
