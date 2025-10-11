import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PredictorConfig {
  exchanges: string[];
  pairs: { symbol: string; binance?: string; okx?: string; coinbase?: string }[];
  aggregator: { windowMs: number };
  db: { url: string };
  rpc: Record<string, string>;
  service: { port: number };
}

export function loadConfig(): PredictorConfig {
  const p = resolve(process.cwd(), 'apps/predictor/config.json');
  const raw = readFileSync(p, 'utf8');
  const cfg = JSON.parse(raw) as PredictorConfig;
  return cfg;
}

