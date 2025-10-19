import { Hono } from 'hono';
import { pool } from './db.js';
import { PriceAggregator } from './aggregator.js';
import { createPublicClient, http } from 'viem';
import { readContract } from 'viem/actions';
import { AGGREGATOR_V2V3_ABI } from './abis/chainlink.js';
import { loadConfig } from './config.js';
import { buildAdapter } from './oracleAdapters.js';

export interface PredictorDeps {
  agg: PriceAggregator;
}

export function buildApp(deps: PredictorDeps) {
  const app = new Hono();
  const appCfg = loadConfig();

  app.get('/health', (c) => c.text('ok'));

  app.get('/stats/:symbol', (c) => {
    const sym = c.req.param('symbol');
    return c.json(deps.agg.stats(sym));
  });

  app.get('/price/:symbol', (c) => {
    const sym = c.req.param('symbol');
    const ag = deps.agg.aggregated(sym);
    return c.json({ symbol: sym, aggregatedPrice: ag.price, sources: ag.sources, count: ag.count });
  });

  // Lightweight metrics (no env config): current agg + recent tick rates + oracle configs
  app.get('/metrics', async (c) => {
    // Symbols from config
    const syms = (appCfg.pairs ?? []).map((p) => p.symbol);
    const symbols = syms.map((s) => {
      const ag = deps.agg.aggregated(s);
      return { symbol: s, aggregatedPrice: ag.price, sources: ag.sources, count: ag.count };
    });
    const { rows: exRows } = await pool.query(
      `SELECT symbol, source, COUNT(*)::int AS n
       FROM cex_ticks WHERE ts > now() - interval '60 seconds'
       GROUP BY symbol, source ORDER BY symbol, source`,
    );
    const { rows: orcRows } = await pool.query(
      `SELECT chain_id, oracle_addr, heartbeat_seconds, offset_bps, updated_at
       FROM oracle_pred_config ORDER BY updated_at DESC`,
    );
    return c.json({ symbols, exchanges: exRows, oracles: orcRows });
  });

  app.get('/metrics/backtest', async (c) => {
    const { rows } = await pool.query(
      `SELECT chain_id, oracle_addr, COUNT(*)::int AS samples
       FROM oracle_pred_samples GROUP BY chain_id, oracle_addr ORDER BY samples DESC`,
    );
    return c.json({ oracles: rows });
  });

  app.get('/oracles', async (c) => {
    const { rows } = await pool.query('SELECT chain_id, oracle_addr, heartbeat_seconds, offset_bps, decimals, scale_factor FROM oracle_pred_config');
    return c.json(rows);
  });

  app.get('/oracles/:chainId/:addr/prediction', async (c) => {
    const chainId = Number(c.req.param('chainId'));
    const addr = c.req.param('addr');
    const sym = c.req.query('symbol') ?? 'BTCUSDC';
    const rowRes = await pool.query(
      'SELECT heartbeat_seconds, offset_bps, decimals, scale_factor FROM oracle_pred_config WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)',
      [chainId, addr],
    );
    if (rowRes.rows.length === 0) return c.json({ error: 'config not found' }, 404);
    const row = rowRes.rows[0]!;

    const rpc = appCfg.rpc[String(chainId)];
    if (!rpc) return c.json({ error: `RPC for chain ${chainId} not set in config` }, 400);
    const client = createPublicClient({ transport: http(rpc) });

    // Read on-chain latest answer
    let chainAns = 0;
    let updatedAt = 0;
    try {
      const [round] = await Promise.all([
        readContract(client as any, {
          address: addr as `0x${string}`,
          abi: AGGREGATOR_V2V3_ABI,
          functionName: 'latestRoundData',
        }),
      ]);
      chainAns = Number(round[1]) / 10 ** Number(cfg.decimals);
      updatedAt = Number(round[3]);
    } catch {}

    const adapter = buildAdapter(chainId, addr);
    const required = adapter.requiredSymbols();
    const aggMap: Record<string, number | undefined> = {};
    for (const s of required) aggMap[s] = deps.agg.aggregated(s).price;
    if (required.some((s) => aggMap[s] === undefined)) return c.json({ error: 'no price' }, 503);

    const offset = Number(row.offset_bps);
    const m = aggMap[required[0]!]!;
    const deltaBps = Math.round(((m / (chainAns || m) - 1) * 10_000));
    const shouldByOffset = Math.abs(deltaBps) >= offset;

    const now = Math.floor(Date.now() / 1000);
    const hb = Number(row.heartbeat_seconds);
    const age = updatedAt ? now - updatedAt : hb + 1;
    const shouldByHb = age >= hb;

    const scale = BigInt(row.scale_factor);
    const { answer, price1e36 } = adapter.compute({ agg: aggMap, decimals: Number(row.decimals), scaleFactor: scale });

    return c.json({
      symbol: sym,
      chainId,
      oracle: addr,
      cexMedian: m,
      onchainAnswer: chainAns,
      updatedAt,
      deltaBps,
      shouldTransmit: shouldByOffset || shouldByHb,
      reasons: { offset: shouldByOffset, heartbeat: shouldByHb },
      predictedPrice1e36: price1e36?.toString(),
    });
  });

  return app;
}
