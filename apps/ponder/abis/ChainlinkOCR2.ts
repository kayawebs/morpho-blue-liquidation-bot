export const chainlinkOcr2Abi = [
  {
    type: 'event',
    name: 'NewTransmission',
    inputs: [
      { indexed: true, name: 'aggregatorRoundId', type: 'uint32' },
      { indexed: false, name: 'answer', type: 'int192' },
      { indexed: false, name: 'transmitter', type: 'address' },
      { indexed: false, name: 'observations', type: 'int192[]' },
      { indexed: false, name: 'observers', type: 'bytes' },
      { indexed: false, name: 'rawReportContext', type: 'bytes32' },
    ],
  },
] as const;

