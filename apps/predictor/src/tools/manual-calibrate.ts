import '../env.js';
import { initSchema } from '../db.js';
import { runAutoCalibrateOnce } from '../autoCalibrate.js';

async function main() {
  await initSchema();
  await runAutoCalibrateOnce();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

