import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadSchedulerConfig } from './config.js';

async function main() {
  const cfg = loadSchedulerConfig();
  const app = new Hono();
  app.get('/health', (c) => c.text('ok'));
  app.get('/feeds', (c) => c.json(cfg.feeds));
  const port = 48200;
  serve({ fetch: app.fetch, port });
  console.log(`🔔 Oracle Scheduler stub listening on :${port}`);
  console.log(`Feeds loaded: ${cfg.feeds.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

