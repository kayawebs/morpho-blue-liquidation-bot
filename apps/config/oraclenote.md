- chains.<chainId>.oracles.<key>

      - address: 预言机合约地址（必填）

      - variant: 解析类型

          - chainlink_ocr2（OCR2Aggregator）

          - chainlink_acoa（AccessControlledOffchainAggregator）

          - v2v3（仅读 latestRoundData，不走 transmit 解析）

          - custom（自定义，需提供 transmitMethod）

      - typeAndVersion: 合约返回的字符串（typeAndVersion()），用于确定解析分支

      - answerDecimals: 报价的小数位（整数）

      - transmitMethod: 写价函数签名（OCR2 默认 transmit(bytes,bytes32[],bytes32[],bytes)；ACOA 为

        transmit(bytes32[3],bytes,bytes32[],bytes32[],bytes)；custom 必填）

      - sampleTransmitTx: 一笔真实 transmit 交易的 tx hash（用于校验解析）

      - description: 备注

  - chains.<chainId>.markets[]

    - marketId: Morpho Blue 市场 ID（bytes32）

    - loanToken/collateralToken: 代币地址

    - priceOracleKey: 主预言机（引用上面的 oracles key）

    - fallbackOracles: 备用预言机 keys（可空）

    - monitor: 是否纳入监听

  - watchAggregators: 需要监听的 aggregator keys（可由 markets 推导，但显示指定更直观）
