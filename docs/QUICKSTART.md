# Quick Start

> 基本顺序：**环境 → 数据服务（Predictor / Ponder / Scheduler）→ Guard 合约 → 两类 Worker**。  
> 全程依赖同一套 Postgres（Predictor & Ponder）与 Base RPC（可使用自建 reth）。

## 0. 环境与 `.env`

1. 要求：Node ≥ 18.14（推荐 20）、pnpm ≥ 9、Postgres、Base RPC/WS。  
2. `pnpm install && pnpm build:config`。  
3. 根目录 `.env` 需包含：
   ```ini
   RPC_URL_8453=http://127.0.0.1:8545
   WS_RPC_URL_8453=ws://127.0.0.1:8546

   # Predictor / Scheduler（可与上面复用）
   PREDICTOR_DB_URL=postgres://user:pass@localhost:5432/predictor
   # 可选：代理
   HTTPS_PROXY=http://127.0.0.1:6152
   ALL_PROXY=socks5://127.0.0.1:6153

   # 确认型 Worker（多私钥逗号分隔）
   EXECUTOR_ADDRESSES_8453=0xExec1,0xExec2
   LIQUIDATION_PRIVATE_KEYS_8453=0xKey1,0xKey2
   CONFIRM_TRIGGER_MODE=flashblock   # 自动回退 nextblock；与 RPC 端口复用

   # 预测型 Worker（硬门控）
   GUARD_ADDRESSES_8453=0xGuard1,0xGuard2
   LIQUIDATION_PRIVATE_KEYS_8453=0xKey1,0xKey2
   ```
   > 若暂未部署 Guard，可先留空，预测型会降级但无法发送交易。

## 1. Predictor（行情聚合 + 回测校准）

```bash
pnpm predictor:start
```
- 自动回填 100 ms CEX 数据 → lag/权重拟合 → 监听链上 transmit 写入样本。
- 健康检查：`GET http://localhost:48080/health`；`/oracles`（阈值/Lag）；`/metrics/backtest`。  
- 手动校准：`pnpm predictor:calibrate`（需要样本≥120）。  
- 服务依赖 Postgres；若用代理，保持 `.env` 中的 `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY`。

## 2. Ponder（候选索引）

```bash
pnpm ponder:start
```
- 自适应 schema，自动回溯。  
- 常见 API：
  - `POST /chain/8453/candidates` → 候选地址。
  - `POST /chain/8453/liquidatable-positions` → 清算/预清算仓位。
  - `POST /chain/8453/positions` → 全量仓位，可加 `onlyPreLiq` & `includeContracts`。

## 3. Oracle Scheduler（窗口对齐 + Shots 推送）

```bash
pnpm scheduler:start
```
- 依赖 Predictor DB（同一 Postgres）。  
- 读取 transmit → 根据偏差/心跳（±90 s）分类，异常写入 `oracle_timing_outliers`。  
- 提供 REST：`GET /feeds`、`GET /timing/profile/:chain/:oracle`、`GET /timing/next/...`。  
- 推送：WS `ws://localhost:48201/ws/schedule?chainId=8453&oracle=<aggregator>`。

## 4. GuardedLiquidator（硬门控执行器）

1. 先用 Foundry/Hardhat 编译 `contracts/GuardedLiquidator.sol`。  
2. 部署（使用 `.env` 的 `RPC_URL_8453` 与执行私钥）：
   ```bash
   pnpm deploy:guarded
   ```
3. 输出的地址写入 `.env` 的 `GUARD_ADDRESSES_8453`。  
4. 合约门控：deadline、最大偏差（bps）、数据最大年龄、最小利润（可传 0x0 表示 ETH），并缓存 aggregator decimals。

## 5. Worker 运行

### 5.1 确认型（Confirmed）

```bash
pnpm worker:confirmed:base:cbbtc_usdc
```
- 依赖 Predictor（拉阈值/lag）、Ponder（候选地址）。  
- `CONFIRM_TRIGGER_MODE=flashblock` 时默认重用 `WS_RPC_URL_8453`/`RPC_URL_8453` 作为 Flashblock 触发源；如需独立端点，可额外配置 `FLASHBLOCK_WS_URL_8453`。  
- 多执行器：`EXECUTOR_ADDRESSES_8453` 与 `LIQUIDATION_PRIVATE_KEYS_8453` 数量一致即可。  
- 监控：`GET http://localhost:48101/metrics`。

### 5.2 预测型（Predictive）

```bash
pnpm worker:predictive:base:cbbtc_usdc
```
- 依赖 Predictor + Scheduler + Ponder + Guard 合约。  
- 通过 Scheduler 的 shots 队列触发，使用 GuardedLiquidator `execEncoded`，默认 profitToken=借款资产、minProfit=0.1 USDC。  
- 多 Guard/私钥并发：`GUARD_ADDRESSES_8453`、`LIQUIDATION_PRIVATE_KEYS_8453`。  
- 若 Guard 未部署，会打印警告并降级为单私钥（不可发 tx）。务必在投入使用前完成 Guard 配置。

## 6. 运行顺序与验证清单

1. `pg_isready` → Postgres OK。  
2. `pnpm predictor:start`（确认 `/oracles` 返回偏移/lag）。  
3. `pnpm ponder:start`（`/chain/8453/candidates` 有返回）。  
4. `pnpm scheduler:start`（`/timing/profile/...` 不再 `no profile`）。  
5. 部署 Guard 并填入 `.env`。  
6. 启动 Confirmed & Predictive worker，观察日志/metrics：  
   - Confirmed：`Trigger mode` 行、`handled transmit`。  
   - Predictive：`shots触发`、Guard 发送成功日志。  
7. 可选：`curl http://localhost:48080/priceAt/BTCUSDC?tsMs=<ms>` 获取预测价；`curl http://localhost:48200/timing/next/...` 查看窗口。  

若任意组件中断，先检查 `.env`/Postgres/RPC，必要时重启单组件即可（数据持久于数据库）。*** End Patch
