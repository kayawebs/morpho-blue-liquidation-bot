# Worker 风险评估与 Dry Run 字段说明

本文记录预测型 Worker 在评估与干跑（Dry Run）时产生的关键字段，便于调试与对比分析。

## assessCandidate 返回字段

- score: 风险评分（0–1+）。按保守价格（考虑误差与偏差）计算的超额风险比例。越大表示越危险。
- ok: 是否认为存在风险（score > 0）。仅作快速筛选使用。
- price: 评估时的预测价格（来自 predictor 的 predictionAt）。单位与喂价一致（按喂价 decimals 解释）。
- errBps: 预测误差带（基于历史回测的 p90AbsBps），用于保守下调价格，单位 bps（1/100%）。
- biasBps: 预测偏差（历史中位偏差），用于抵消系统性误差，单位 bps。
- bShares: 借款份额（Morpho position.borrowShares）。
- collateral: 抵押数量（Morpho position.collateral），单位为抵押代币的最小单位。
- borrowAssets: 估算的借款资产数量（从 shares 换算为资产），单位为贷款代币的最小单位。
- maxBorrow: 在当前保守价格和 LLTV 下的最大可借额度（抵押估值×LLTV），单位为贷款代币的最小单位。

说明：评估中使用了“保守价格”策略：priceAdjusted = price × (1 − errBps − |biasBps|)。由此得到 collValueLoan 和 maxBorrow，并据此计算 score。

## worker-dryrun.csv 字段

- ts: 时间戳（ms）。
- kind: 记录类型（dryrun 或 dryrun-skip）。
- chainId: 链 ID（如 8453）。
- marketId: Morpho 市场 ID（bytes32）。
- aggregator: 预言机 aggregator 地址。
- sprayReason: 本次喷射会话原因（如 deviation）。
- cadenceMs: 基础喷射节奏（ms）。
- executors: 本次可用执行器数量（EOA 数量）。
- riskGate: 当前风险门槛（WORKER_RISK_GATE，0–1）。
- borrower: 目标地址（借款人）。
- score: 风险评分（见上）。
- price: 评估使用的预测价格。
- errBps / biasBps: 误差带与偏差（bps）。
- bShares: 借款份额（字符串表示的整数）。
- collateral: 抵押数量（字符串表示的整数）。
- borrowAssets: 估算借款资产数量（字符串表示的整数）。
- maxBorrow: 最大可借额度（字符串表示的整数）。

备注：
- dryrun 记录在 `out/worker-dryrun.ndjson`，使用 `pnpm export:dryrun` 导出为 `data/worker-dryrun.csv`。
- 当 `WORKER_DRY_RUN=1` 且未达到 `WORKER_RISK_GATE` 时，会写入 `dryrun-skip` 记录，便于观察门槛对喷射的影响。

