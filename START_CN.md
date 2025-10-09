# 启动指南（Quick Start）

## 环境要求
- Node.js ≥ 20（最低 18.14），pnpm ≥ 9
- 具备 RPC 节点与私钥；若未部署执行合约，可用脚本一键部署

## 安装
- 克隆并安装依赖：
  - `pnpm install`

## 基础配置
- 复制 `.env.example` 到 `.env` 并按链 ID 填写：
  - `RPC_URL_8453=...`（Base）
  - 可选：`WS_RPC_URL_8453=wss://...`（推荐，WS 更快获取内存池）
  - `EXECUTOR_ADDRESS_8453=0x...`（已部署的执行合约地址）
  - `LIQUIDATION_PRIVATE_KEY_8453=0x...`
- 若尚未有执行合约，可先：
  - `pnpm deploy:executor`（部署后将地址写入 `.env` 对应 `EXECUTOR_ADDRESS_<CHAIN_ID>`）
- 如需自定义链与白名单，编辑 `apps/config/src/config.ts`，修改后执行 `pnpm build:config`

## 构建
- 先构建配置包：`pnpm build:config`

## 启动索引器（Ponder）
- 一条命令（开发态，同时跑索引器+机器人）：
  - `pnpm dev`
- 或手动分开：
  - 终端1：`pnpm ponder:dev`
  - 终端2：`pnpm cbbtc:start`
- 已有外部服务时：在 `.env` 配置 `PONDER_SERVICE_URL`（可跳过本地启动）

## 启动机器人
- 启动示例（cbBTC/USDT 机器人）：`pnpm cbbtc:start`
- 启动内存池监听并运行：`pnpm mempool:start`
- 一次性执行清算脚本：`pnpm liquidate`
- 其他辅助脚本：`pnpm fund:executor`、`pnpm skim`

## 生产部署（可选）
- 使用 PM2 一键启动：`pm2 start ecosystem.config.cjs`
- 日志位于 `./logs/`（PM2 配置已内置）

## 验证与排错
- 代码规范与类型检查：`pnpm lint`
- 关键测试集：`pnpm test:liquidity-venues`、`pnpm test:pricers`、`pnpm test:execution`
- 修改 `apps/config` 后，务必再次执行：`pnpm build:config`
