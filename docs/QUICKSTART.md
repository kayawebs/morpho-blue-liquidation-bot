# Quick Start

## 0) 环境准备
- Node ≥ 18.14（推荐 Node 20），pnpm v9+。
- 复制 `.env.example` 为 `.env`，按需填写 RPC；调试时可开启代理（见下）。

## 1) 启动行情聚合 Predictor（长期运行）
- 配置：`apps/predictor/config.json`（交易所、交易对、聚合窗口、端口等）。
- 启动（无代理）：`pnpm predictor:start`
- 启动（走代理调试/受限网络）：`pnpm predictor:start:proxy`
  - `.env` 可设置：`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`；建议同时设置 `PREDICTOR_WS_DIRECT=1` 让 WS 直连走代理。
- 快速自检：
  - `GET http://localhost:48080/health`
  - `GET http://localhost:48080/price/BTCUSDC`
  - `GET http://localhost:48080/metrics`（聚合价/交易所活跃/阈值）
- 连通性测试（可选）：
  - REST：`pnpm -C apps/predictor test:connectivity`
  - WS：`pnpm -C apps/predictor test:ws`
- 仅用 HTTP 轮询（规避 WS）：在 `config.json` 设置 `"ws": false`。

## 2) 回测与校准（一次性，按需重跑）
- 回测写样本：`pnpm -C apps/predictor backtest:ocr2`
- 校准写阈值：`pnpm -C apps/predictor calibrate`
- 阈值存入：`oracle_pred_config`，Worker 会定期读取。

## 3) 启动候选索引 Ponder（长期运行）
- 编辑市场：根目录 `markets.json`
- 启动：`pnpm ponder:start`
- 自检：`GET http://localhost:42069/ready`、`/chain/:id/candidates`

## 4) 启动 Worker（长期运行）
- 启动示例（Base cbBTC/USDC）：`pnpm worker:base:cbbtc_usdc`
- 预测触发：默认开启（每秒检查），阈值每 60 秒从 predictor 刷新。
- 自检：`GET http://localhost:48100/metrics`（uptime/阈值/触发统计/候选数）。

## 常用路径
- 新增市场：
  - predictor：在 `config.json` 的 `pairs` 与 `oracles` 增加条目，重启 predictor；回测→校准一次。
  - ponder：`markets.json` 增加 marketId，重启 ponder。
  - worker：复制一个 worker 文件，更新常量与 registry 映射，新增启动脚本/PM2 项。

## 故障排查
- WS 握手超时/连不上：使用 `pnpm predictor:start:proxy` 并在 `.env` 配置代理；或将 `"ws": false` 改为 HTTP 轮询。
- REST 正常但 `/price` 无聚合价：检查 `minExchanges`、所选交易所是否有回包、时间窗口是否过短。
- 代理只支持 SOCKS5：优先同时设置 `HTTPS_PROXY` 以确保 `wss://` 可用。
