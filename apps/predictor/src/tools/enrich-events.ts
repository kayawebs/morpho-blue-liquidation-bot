import '../env.js';
import { initSchema, initSrcAgg100ms } from '../db.js';
import { makeFetchWithProxy } from '../utils/proxy.js';
import { enrichEvents } from '../enrich.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) { const k = a.slice(2); const v = args[i+1]; if (v && !v.startsWith('--')) { out[k]=v; i++; } else out[k]='1'; }
  }
  return out;
}

async function main() {
  await initSchema();
  await initSrcAgg100ms();
  const fetchImpl = await makeFetchWithProxy();
  const arg = parseArgs();
  const chainId = Number(arg.chain || arg.c || 8453);
  const oracle = String(arg.oracle || arg.o || '');
  const limit = Math.max(1, Math.min(500, Number(arg.limit || 100)));
  const windowSec = Math.max(10, Math.min(300, Number(arg.window || 120)));
  const aheadSec = Math.max(0, Math.min(30, Number(arg.ahead || 10)));
  if (!oracle) { console.error('usage: enrich-events --chain 8453 --oracle 0x... [--limit 100] [--window 120]'); process.exit(1); }
  await enrichEvents(chainId, oracle, limit, windowSec, aheadSec, fetchImpl);
  try { await pool.end(); } catch {}
}

main().catch((e)=>{ console.error(e); process.exit(1); });
