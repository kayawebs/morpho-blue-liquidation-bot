# Predictor Usage

## Overview
- Aggregates CEX prices at 100ms, fits lag/weights vs on-chain transmit, and serves APIs for workers.
- Fitted parameters persist in `oracle_pred_config` (heartbeat_seconds, offset_bps, bias_bps, lag_ms/lag_seconds).

## Start
- Command: `pnpm predictor:start`
- Health: `GET http://localhost:48080/health`
- Oracles: `GET http://localhost:48080/oracles` (shows lag_ms, lag_seconds)
- Weights: `GET /oracles/:chainId/:addr/weights`
- Fit summary: `GET /oracles/:chainId/:addr/fitSummary`

## Key APIs
- Price at time (ms): `GET /priceAt/:symbol?tsMs=...&lagMs=...`
- Oracle prediction at time (ms):
  - `GET /oracles/:chainId/:addr/predictionAt?tsMs=...&lagMs=...`
  - If `lag/lagMs` omitted, defaults to DB `lag_ms` (falls back to `lag_seconds*1000`).

## Historical 100ms enrich (per exchange)
- Fill 100ms gaps around transmit events by aggregating CEX trades in small windows:
  - `pnpm -C apps/predictor enrich:events --chain 8453 --oracle 0x852a... --limit 100 --window 120`
  - Writes per-exchange 100ms (`cex_src_100ms`) and merged 100ms (`cex_agg_100ms`).
  - Use after cleanup or cold starts to make lag/weight fit purely 100ms-based.

## Fitting logic (short)
- Startup fit (ms): scan `lagMs ∈ [0,3000]` every 100ms using 100ms aggregated price, pick p90/p50 error minimum → persist `lag_ms` and `lag_seconds`.
- Auto calibrate (periodic): in fixed lag, fit exchange weights and signed bias; compute heartbeat from gaps; EWMA-smooth and persist.
- 100ms aggregation: near-window in-memory cache prioritized; DB fallback; TTL cleanup (default 7d).

### Tuning windowMs
- `aggregator.windowMs` controls near-window fusion lag vs. robustness. Recommended 600–1000ms (default 800).
- After changing `windowMs`, clean old 100ms rows to avoid mixing regimes:
  - `pnpm -C apps/predictor cleanup:100ms`
  - Then restart predictor and re-run calibrate after collecting fresh samples.

## Validate accuracy
- Command: `pnpm -C apps/predictor validate:accuracy`
- Output includes thresholds (offset/heartbeat/lagMs), value error p50/p90, and offset-detection lead time.

## Notes
- Proxy (optional): set `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY` and `PREDICTOR_WS_DIRECT=1` for WS.
- Tuning: `apps/predictor/config.json` → `aggregator.windowMs` (500–1000), `aggregator.binMs` (100).
