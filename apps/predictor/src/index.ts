import { initSchema, insertTick } from './db.js';
import { PriceAggregator } from './aggregator.js';
import { MultiCexConnector } from './connectors/ccxws.js';
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
  const connector = new MultiCexConnector(({ ts, price, source, symbol }) => {
    agg.push(symbol, { ts, price, source });
    // batch insert could be implemented; simple insert for scaffold
    void insertTick(source, symbol, ts, price);
  });

  await connector.start();
  const app = buildApp({ agg });
  const port = Number(cfg.service.port ?? 48080);
  serve({ fetch: app.fetch, port });
  console.log(`🛰 Predictor service listening on :${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
