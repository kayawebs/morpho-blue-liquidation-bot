# Quick Start

## 0) 环境与配置
- 运行环境：Node ≥ 18.14（推荐 Node 20）、pnpm v9+、Postgres 可用。
- 复制并编辑根目录 `.env`：
  - 基础 RPC（Base 主网）：`RPC_URL_8453`、`WS_RPC_URL_8453`
  - 确认型 Worker（单执行器）：`EXECUTOR_ADDRESS_8453`、`LIQUIDATION_PRIVATE_KEY_8453`
  - 确认型 Worker（多执行器，可选，逗号分隔）：`EXECUTOR_ADDRESSES_8453`、`LIQUIDATION_PRIVATE_KEYS_8453`
  - 预测型 Worker（硬门控，多私钥并发，逗号分隔）：`GUARD_ADDRESSES_8453`、`LIQUIDATION_PRIVATE_KEYS_8453`
  - 代理（可选调试）：`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`；建议 `PREDICTOR_WS_DIRECT=1`
- Predictor 聚合参数（建议）：`apps/predictor/config.json` 中 `aggregator.windowMs=500~1000`、`aggregator.binMs=100`。

## 1) 启动行情聚合 Predictor（长期运行）
- 启动：`pnpm predictor:start`
- 健康检查：
  - `GET http://localhost:48080/health`
  - `GET http://localhost:48080/oracles`（含 `lag_seconds`）
  - `GET http://localhost:48080/oracles/8453/0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8/weights`
- 说明：启动时自动回填 + 100ms 网格拟合（lag 与权重）、持续 100ms 聚合入库。

## 2) 启动候选索引 Ponder（长期运行）
- 市场配置：根目录 `markets.json`
- 启动：`pnpm ponder:start`
- 快速检查：`POST http://localhost:42069/chain/8453/candidates`（Body：`{ marketIds: ["<marketId>"] }`）
- 常用 API：
  - 清算与预清算机会（仅返回“可清算/可预清算”的仓位）
    - `POST /chain/:chainId/liquidatable-positions`
    - Body：`{ marketIds: ["<marketId>"] }`
    - 示例：
      - `curl -s -X POST http://localhost:42069/chain/8453/liquidatable-positions -H 'content-type: application/json' -d '{"marketIds":["0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836"]}'`
  - 全量仓位（可选仅含“已授权预清算”的仓位；可选返回授权合约地址）
    - `POST /chain/:chainId/positions`
    - Body：`{ marketIds: ["<marketId>"], onlyPreLiq?: boolean, includeContracts?: boolean }`
    - 示例：
      - 全量：
        - `curl -s -X POST http://localhost:42069/chain/8453/positions -H 'content-type: application/json' -d '{"marketIds":["0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836"]}'`
      - 仅含预清算且返回合约：
        - `curl -s -X POST http://localhost:42069/chain/8453/positions -H 'content-type: application/json' -d '{"marketIds":["0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836"],"onlyPreLiq":true,"includeContracts":true}'`

## 3) 启动 Worker（确认型，推荐基线）
- 需要：Predictor + Ponder 均已运行；`.env` 中至少填写单执行器或多执行器配置。
- 单执行器（最简）：
  - `.env`：`EXECUTOR_ADDRESS_8453`、`LIQUIDATION_PRIVATE_KEY_8453`
  - 启动：`pnpm worker:confirmed:base:cbbtc_usdc`
- 多执行器并发（可选，提升吞吐）：
  - `.env`：`EXECUTOR_ADDRESSES_8453=0xA,0xB`、`LIQUIDATION_PRIVATE_KEYS_8453=0xKa,0xKb`
  - 启动：同上（自动并发，每个执行器各发一笔）
- 特性：确认数固定 1；从 Predictor 周期拉取阈值/lag；从 Ponder 获取候选地址；仅在预计净利 ≥ $0.1 时执行。

## 4) 启动 Worker（预测型，窗口驱动）
- 部署硬门控合约（可选但推荐）：
  - 先编译（Foundry/Hardhat），再运行：`pnpm deploy:guarded`
  - 将所得地址写入 `.env` 的 `GUARD_ADDRESSES_8453`
- 需要：Predictor + Oracle Scheduler 均已运行：
  - Scheduler：`pnpm scheduler:start`（提供 `ws://localhost:48201/ws/schedule?...` 推送）
  - 启动：`pnpm worker:predictive:base:cbbtc_usdc`
- 特性：在心跳/偏差窗口内，用多私钥+多 Guard 并行尝试；内置硬门控（roundId/偏差/数据时效/最小利润）。

## 5) 常见问题
- WS 连接失败：用代理启动 Predictor（`.env` 设置代理，或 `PREDICTOR_WS_DIRECT=1`）。
- Ponder 提示 schema 冲突：切换 schema 或清空旧库后重试。
- 多执行器未生效：检查两组变量长度一致（地址数=私钥数）。
