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
// import { runBackfillIfNeeded } from './backfill.js';
import { startOracleWatcher } from './oracleWatcher.js';
import { startAutoCalibrateScheduler, runAutoCalibrateOnce } from './autoCalibrate.js';
import { seedOracleThresholdsFromConfig } from './seedThresholds.js';
// import { runStartupFit } from './startupFit.js';
import { enrichEvents } from './enrich.js';
import { makeFetchWithProxy } from './utils/proxy.js';
import { recordAgg100ms } from './memory.js';

async function main() {
  // Fetch proxy is applied per-request inside HttpPollConnector.
  await initSchema();
  await initSrcAgg100ms();
  const cfg = loadConfig();
  // 严格模式：不做1m回填，完全依赖 100ms enrich + 实时writer
  // Seed feed thresholds from config if provided (deviation/heartbeat pinned by feed owner)
  await seedOracleThresholdsFromConfig();
  // 启动时：若不存在有效校准（lag_ms>0 且存在权重），则先 enrich 再 calibrate
  try {
    const f = await makeFetchWithProxy();
    const cfg2 = loadConfig();
    for (const o of (cfg2 as any).oracles ?? []) {
      const { rows } = await pool.query(
        `SELECT lag_ms FROM oracle_pred_config WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)`,
        [Number(o.chainId), String(o.address)],
      );
      const lagMs = Number(rows[0]?.lag_ms ?? 0);
      const { rows: wrows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM oracle_cex_weights WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)`,
        [Number(o.chainId), String(o.address)],
      );
      const hasWeights = Number(wrows[0]?.n ?? 0) > 0;
      if (!(lagMs > 0 && hasWeights)) {
        console.log(`⚙️  missing calibration for ${o.address}, enriching & calibrating...`);
        await enrichEvents(Number(o.chainId), String(o.address), 120, 120, 10, f);
        await runAutoCalibrateOnce();
      }
    }
  } catch (e) { console.warn('startup enrich/calibrate failed:', e); }
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
