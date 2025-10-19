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

  // Compute weighted CEX price at a given timestamp (seconds) using DB medians in ±2s window.
  app.get('/priceAt/:symbol', async (c) => {
    try {
      const symbol = c.req.param('symbol');
      const ts = Number(c.req.query('ts'));
      if (!Number.isFinite(ts)) return c.json({ error: 'ts (seconds) required' }, 400);
      const lag = Number(c.req.query('lag') ?? 0);
      const at = ts - (Number.isFinite(lag) ? lag : 0);
      const sourcesQ = (c.req.query('sources') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const weightsQ = c.req.query('weights'); // format: ex:w,ex2:w2
      const defaultSources = Object.keys((appCfg.aggregator as any).weights ?? { binance: 1, okx: 1, coinbase: 1 });
      const sources = sourcesQ.length > 0 ? sourcesQ : defaultSources;
      const weights: Record<string, number> = {};
      if (weightsQ) {
        for (const kv of weightsQ.split(',')) {
          const [k, v] = kv.split(':');
          const num = Number(v);
          if (k && Number.isFinite(num)) weights[k.toLowerCase()] = num;
        }
      } else {
        Object.assign(weights, (appCfg.aggregator as any).weights ?? {});
        if (Object.keys(weights).length === 0) for (const s of sources) weights[s] = 1 / sources.length;
      }
      // per-exchange medians
      const per: Record<string, number | null> = {};
      for (const s of sources) {
        const { rows } = await pool.query(
          `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::float AS p
           FROM cex_ticks WHERE symbol=$1 AND source=$2 AND ts BETWEEN to_timestamp($3-2) AND to_timestamp($3+2)`,
          [symbol, s, at],
        );
        const p = Number(rows[0]?.p);
        per[s] = Number.isFinite(p) ? p : null;
      }
      // weighted sum over available
      let num = 0;
      let den = 0;
      for (const s of sources) {
        const p = per[s];
        const w = Number(weights[s] ?? 0);
        if (p !== null && Number.isFinite(w) && w > 0) {
          num += p * w;
          den += w;
        }
      }
      const weighted = den > 0 ? num / den : null;
      return c.json({ symbol, ts, lag: Number.isFinite(lag) ? lag : 0, at, sources, weights, per, weighted });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Adapter-based predicted price at timestamp (seconds) with optional lag.
  app.get('/oracles/:chainId/:addr/predictionAt', async (c) => {
    const chainId = Number(c.req.param('chainId'));
    const addr = c.req.param('addr');
    const ts = Number(c.req.query('ts'));
    if (!Number.isFinite(ts)) return c.json({ error: 'ts (seconds) required' }, 400);
    const lag = Number(c.req.query('lag') ?? 0);
    const at = ts - (Number.isFinite(lag) ? lag : 0);
    const rowRes = await pool.query(
      'SELECT heartbeat_seconds, offset_bps, decimals, scale_factor FROM oracle_pred_config WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)',
      [chainId, addr],
    );
    if (rowRes.rows.length === 0) return c.json({ error: 'config not found' }, 404);
    const row = rowRes.rows[0]!;
    const adapter = buildAdapter(chainId, addr);
    const required = adapter.requiredSymbols();
    const aggMap: Record<string, number | undefined> = {};
    for (const s of required) {
      const { rows } = await pool.query(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::float AS p
         FROM cex_ticks WHERE symbol=$1 AND ts BETWEEN to_timestamp($2-2) AND to_timestamp($2+2)`,
        [s, at],
      );
      const p = Number(rows[0]?.p);
      if (!Number.isFinite(p)) return c.json({ error: `no price for ${s} at ts=${at}` }, 503);
      aggMap[s] = p;
    }
    const scale = BigInt(row.scale_factor);
    const { answer, price1e36 } = adapter.compute({ agg: aggMap, decimals: Number(row.decimals), scaleFactor: scale });
    return c.json({ chainId, oracle: addr, ts, lag: Number.isFinite(lag) ? lag : 0, at, required, aggMap, answer, price1e36: price1e36?.toString() });
  });

  return app;
}
