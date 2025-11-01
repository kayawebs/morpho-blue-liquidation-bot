import '../env.js';
import { initSchema } from '../db.js';
import { runAutoCalibrateOnce } from '../autoCalibrate.js';
import { enrichEvents } from '../enrich.js';
import { loadConfig } from '../config.js';
import { makeFetchWithProxy } from '../utils/proxy.js';

async function main() {
  await initSchema();
  // Strict mode: optionally enrich recent events into 100ms bins before calibrate
  try {
    const doEnrich = process.env.PREDICTOR_ENRICH_BEFORE_CALIBRATE !== '0';
    if (doEnrich) {
      const cfg = loadConfig();
      const f = await makeFetchWithProxy();
      const limit = Math.max(10, Math.min(300, Number(process.env.PREDICTOR_ENRICH_LIMIT ?? 120)));
      const windowSec = Math.max(30, Math.min(300, Number(process.env.PREDICTOR_ENRICH_WINDOW ?? 120)));
      const aheadSec = Math.max(0, Math.min(30, Number(process.env.PREDICTOR_ENRICH_AHEAD ?? 10)));
      for (const o of (cfg as any).oracles ?? []) {
        await enrichEvents(Number(o.chainId), String(o.address), limit, windowSec, aheadSec, f);
      }
    }
  } catch (e) {
    console.warn('enrich-before-calibrate failed:', e);
  }
  await runAutoCalibrateOnce();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
