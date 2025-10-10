export const OCR2_AGGREGATOR_ABI = [
  {
    type: "function",
    name: "transmit",
    inputs: [
      { name: "report", type: "bytes" },
      { name: "rawRs", type: "bytes32[]" },
      { name: "rawSs", type: "bytes32[]" },
      { name: "rawVs", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const ACOA_AGGREGATOR_ABI = [
  // AccessControlledOffchainAggregator variants (older OCR)
  {
    type: "function",
    name: "transmit",
    inputs: [
      { name: "reportContext", type: "bytes32[3]" },
      { name: "report", type: "bytes" },
      { name: "rawRs", type: "bytes32[]" },
      { name: "rawSs", type: "bytes32[]" },
      { name: "rawVs", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
