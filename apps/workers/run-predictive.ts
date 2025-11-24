#!/usr/bin/env tsx
import 'dotenv/config';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

// Load root .env first, then profile .env.cbbtcusdc (values in profile override root)
try { dotenv.config({ path: resolve(process.cwd(), '.env') }); } catch {}
try { dotenv.config({ path: resolve(process.cwd(), '.env.cbbtcusdc') }); } catch {}

// Sensible defaults if not provided in env/profile
process.env.WORKER_TOP_N = String(Math.max(1, Number(process.env.WORKER_TOP_N ?? '1')));
process.env.WORKER_SPRAY_CADENCE_MS = String(Math.max(50, Number(process.env.WORKER_SPRAY_CADENCE_MS ?? '200')));

console.log('🚀 Launching predictive worker (cbBTC/USDC) with profile .env.cbbtcusdc');
console.log(`🔧 TopN=${process.env.WORKER_TOP_N} cadenceMs=${process.env.WORKER_SPRAY_CADENCE_MS}`);

// Run the actual worker
await import('./base_cbbtc_usdc_predictive.ts');

