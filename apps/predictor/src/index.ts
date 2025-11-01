import './env.js';
import { initSchema, insertTick, insertAgg100ms, initSrcAgg100ms, insertSrcAgg100ms } from './db.js';
// No global fetch proxy injection here to avoid undici Response mismatch issues.
import { PriceAggregator } from './aggregator.js';
import { MultiCexConnector } from './connectors/ccxws.js';
import { DirectWsConnector } from './connectors/directWs.js';
import { HttpPollConnector } from './connectors/httpPoll.js';
import { buildApp } from './service.js';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { runBackfillIfNeeded } from './backfill.js';
import { startOracleWatcher } from './oracleWatcher.js';
import { startAutoCalibrateScheduler } from './autoCalibrate.js';
import { seedOracleThresholdsFromConfig } from './seedThresholds.js';
import { runStartupFit } from './startupFit.js';
import { enrichEvents } from './enrich.js';
import { makeFetchWithProxy } from './utils/proxy.js';
import { recordAgg100ms } from './memory.js';

async function main() {
  // Fetch proxy is applied per-request inside HttpPollConnector.
  await initSchema();
  await initSrcAgg100ms();
  const cfg = loadConfig();
  // Backfill recent CEX prices if local history is missing/stale to enable immediate backtest/calibrate.
  await runBackfillIfNeeded();
  // Seed feed thresholds from config if provided (deviation/heartbeat pinned by feed owner)
  await seedOracleThresholdsFromConfig();
  // Strict mode: enrich recent events into 100ms bins before fitting (default on; disable with PREDICTOR_ENRICH_ON_START=0)
  try {
    const doEnrich = process.env.PREDICTOR_ENRICH_ON_START !== '0';
    if (doEnrich) {
      const f = await makeFetchWithProxy();
      const cfg = loadConfig();
      const limit = Math.max(10, Math.min(200, Number(process.env.PREDICTOR_ENRICH_LIMIT ?? 100)));
      const windowSec = Math.max(30, Math.min(300, Number(process.env.PREDICTOR_ENRICH_WINDOW ?? 120)));
      const aheadSec = Math.max(0, Math.min(30, Number(process.env.PREDICTOR_ENRICH_AHEAD ?? 10)));
      for (const o of (cfg as any).oracles ?? []) {
        await enrichEvents(Number(o.chainId), String(o.address), limit, windowSec, aheadSec, f);
      }
    }
  } catch (e) { console.warn('enrich-on-start failed:', e); }
  // Startup backtest fitting (slow & gentle): derives lagSeconds and weights (~100ms grid using DB seconds)
  try { await runStartupFit(); } catch (e) { console.warn('startup fit failed:', e); }
  // Start oracle transmit watcher (polling) to continuously build samples
  await startOracleWatcher();
  const agg = new PriceAggregator(
    cfg.aggregator.windowMs ?? 3000,
    cfg.aggregator.trimRatio ?? 0.2,
    cfg.aggregator.minExchanges ?? 2,
    cfg.aggregator.weights ?? {},
  );
  const onTick = ({ ts, price, source, symbol }: { ts: number; price: number; source: string; symbol: string }) => {
    agg.push(symbol, { ts, price, source });
    // batch insert could be implemented; simple insert for scaffold
    void insertTick(source, symbol, ts, price);
  };

  const useWs = cfg.aggregator && (cfg.aggregator as any).ws !== false;
  const useDirectWs = process.env.PREDICTOR_WS_DIRECT === '1' || process.env.PREDICTOR_WS_MODE === 'direct';
  const wsConnector = useDirectWs ? new DirectWsConnector(onTick) : new MultiCexConnector(onTick);
  const httpConnector = new HttpPollConnector(onTick, 1000);
  if (useWs) {
    await wsConnector.start();
  } else {
    console.log('🔇 WS disabled by config; using HTTP polling only');
  }
  await httpConnector.start();
  // Sub-second aggregated writer (100ms bins)
  const symbols = (cfg.pairs ?? []).map((p) => p.symbol);
  const lastBin: Record<string, number> = {};
  const binMs = Number((cfg.aggregator as any).binMs ?? 100);
  setInterval(() => {
    const now = Date.now();
    const b = now - (now % binMs);
    for (const s of symbols) {
      if (lastBin[s] === b) continue;
      const ag = agg.aggregated(s);
      if (typeof ag.price === 'number' && Number.isFinite(ag.price)) {
        // Write both in-memory (near-window fast path) and DB (persistence)
        recordAgg100ms(s, b, ag.price);
        insertAgg100ms(s, b, ag.price);
        lastBin[s] = b;
      }
      // Also persist per-source medians at this bin for weight fitting/enrich
      const perSrc = agg.perSourceMedians(s);
      for (const [src, val] of Object.entries(perSrc)) {
        if (typeof val === 'number' && Number.isFinite(val)) insertSrcAgg100ms(s, src, b, val);
      }
    }
  }, Number.isFinite((cfg.aggregator as any).binMs) ? Number((cfg.aggregator as any).binMs) : 100);
  const app = buildApp({ agg });
  const port = Number(cfg.service.port ?? 48080);
  serve({ fetch: app.fetch, port });
  console.log(`🛰 Predictor service listening on :${port}`);
  // Start periodic auto-calibration (runs in background)
  startAutoCalibrateScheduler();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
