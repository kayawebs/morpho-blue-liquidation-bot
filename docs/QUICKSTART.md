# Quick Start

## 1) 启动行情聚合（长期运行）
- 编辑配置：`apps/predictor/config.json`（交易所、符号、RPC、端口等）
- 启动：`pnpm predictor:start`
- 快速自检：
  - `GET http://localhost:48080/health`
  - `GET http://localhost:48080/price/BTCUSDC`
  - `GET http://localhost:48080/metrics`（聚合价/交易所活跃/阈值）

## 2) 回测与校准（一次性，按需重跑）
- 回测写样本：`pnpm -C apps/predictor backtest:ocr2`
- 校准写阈值：`pnpm -C apps/predictor calibrate`
- 阈值存入：`oracle_pred_config`，Worker 会定期读取

## 3) 启动候选索引（长期运行）
- 编辑市场：根目录 `markets.json`
- 启动：`pnpm ponder:start`
- 自检：`GET http://localhost:42069/ready`、`/chain/:id/candidates`

## 4) 启动 Worker（长期运行）
- 启动：`pnpm worker:base_cbbtc_usdc`
- 预测触发：默认开启（每秒检查），阈值每60秒从 predictor 刷新
- 自检：`GET http://localhost:48100/metrics`（uptime/阈值/触发统计/候选数）

## 常用路径
- 新增市场：
  - predictor：在 `config.json` 的 `pairs` 与 `oracles` 增加条目，重启 predictor；回测→校准一次
  - ponder：`markets.json` 增加 marketId，重启 ponder
  - worker：复制一个 worker 文件，更新常量与 registry 映射，新增启动脚本/PM2 项

## 备注
- predictor 仅提供“聚合价与阈值”，每个预言机的价格公式由 Worker 的 adapter 决定（按 oracle 地址在 registry 映射）。
