import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FeedConfig {
  chainId: number;
  symbol: string;
  aggregator: `0x${string}`;
  feed: `0x${string}`;
  heartbeatSeconds: number;
  deviationBps: number;
}

export interface SchedulerConfig {
  feeds: FeedConfig[];
}

export function loadSchedulerConfig(): SchedulerConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  const p = resolve(here, '../config.json');
  const raw = readFileSync(p, 'utf8');
  return JSON.parse(raw) as SchedulerConfig;
}

