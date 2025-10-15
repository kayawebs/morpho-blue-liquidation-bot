import { initSchema, insertTick } from './db.js';
import { PriceAggregator } from './aggregator.js';
import { MultiCexConnector } from './connectors/ccxws.js';
import { HttpPollConnector } from './connectors/httpPoll.js';
import { buildApp } from './service.js';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';

async function main() {
  await initSchema();
  const cfg = loadConfig();
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
  const wsConnector = new MultiCexConnector(onTick);
  const httpConnector = new HttpPollConnector(onTick, 1000);
  if (useWs) {
    await wsConnector.start();
  } else {
    console.log('🔇 WS disabled by config; using HTTP polling only');
  }
  await httpConnector.start();
  const app = buildApp({ agg });
  const port = Number(cfg.service.port ?? 48080);
  serve({ fetch: app.fetch, port });
  console.log(`🛰 Predictor service listening on :${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
