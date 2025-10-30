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

## Fitting logic (short)
- Startup fit (ms): scan `lagMs ∈ [0,3000]` every 100ms using 100ms aggregated price, pick p90/p50 error minimum → persist `lag_ms` and `lag_seconds`.
- Auto calibrate (periodic): in fixed lag, fit exchange weights and signed bias; compute heartbeat from gaps; EWMA-smooth and persist.
- 100ms aggregation: near-window in-memory cache prioritized; DB fallback; TTL cleanup (default 7d).

## Validate accuracy
- Command: `pnpm -C apps/predictor validate:accuracy`
- Output includes thresholds (offset/heartbeat/lagMs), value error p50/p90, and offset-detection lead time.

## Notes
- Proxy (optional): set `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY` and `PREDICTOR_WS_DIRECT=1` for WS.
- Tuning: `apps/predictor/config.json` → `aggregator.windowMs` (500–1000), `aggregator.binMs` (100).

