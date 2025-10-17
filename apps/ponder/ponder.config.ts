import { chainConfig, chainConfigs } from "@morpho-blue-liquidation-bot/config";
import { createConfig, factory } from "ponder";
import { type AbiEvent, getAbiItem, createPublicClient, http } from "viem";

import { adaptiveCurveIrmAbi } from "./abis/AdaptiveCurveIrm";
import { metaMorphoAbi } from "./abis/MetaMorpho";
import { metaMorphoFactoryAbi } from "./abis/MetaMorphoFactory";
import { morphoBlueAbi } from "./abis/MorphoBlue";
import { preLiquidationFactoryAbi } from "./abis/PreLiquidationFactory";

const configs = Object.values(chainConfigs).map((config) => chainConfig(config.chain.id));

// Optional fast-lookback override to reduce initial history scanned.
const LOOKBACK = Number(process.env.FAST_LOOKBACK_BLOCKS ?? "0");
const latestByChain: Record<string, number> = {};
if (LOOKBACK > 0) {
  for (const cfg of configs) {
    const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
    const latest = await client.getBlockNumber();
    latestByChain[cfg.chain.name] = Number(latest);
  }
}
const sb = (chainName: string, orig: number) =>
  LOOKBACK > 0 ? Math.max(orig, (latestByChain[chainName] ?? orig) - LOOKBACK) : orig;

const chains = Object.fromEntries(
  configs.map((config) => [
    config.chain.name,
    {
      id: config.chain.id,
      rpc: config.rpcUrl,
    },
  ]),
);

export default createConfig({
  ordering: "multichain",
  chains,
  database: {
    kind: "postgres",
    connectionString:
      process.env.POSTGRES_DATABASE_URL ?? "postgres://ponder:ponder@localhost:5432/ponder",
    schema: process.env.PONDER_DB_SCHEMA ?? process.env.DATABASE_SCHEMA ?? "mblb_ponder",
  },
  contracts: {
    Morpho: {
      abi: morphoBlueAbi,
      chain: Object.fromEntries(
        configs.map((config) => [
          config.chain.name,
          {
            address: config.morpho.address,
            startBlock: sb(config.chain.name, config.morpho.startBlock),
          },
        ]),
      ) as Record<
        keyof typeof chains,
        {
          readonly address: `0x${string}`;
          readonly startBlock: number;
        }
      >,
    },
    MetaMorpho: {
      abi: metaMorphoAbi,
      chain: Object.fromEntries(
        configs.map((config) => [
          config.chain.name,
          {
            address: factory({
              address: config.metaMorphoFactories.addresses,
              event: getAbiItem({ abi: metaMorphoFactoryAbi, name: "CreateMetaMorpho" }),
              parameter: "metaMorpho",
            }),
            startBlock: sb(config.chain.name, config.metaMorphoFactories.startBlock),
          },
        ]),
      ) as Record<
        keyof typeof chains,
        {
          readonly address: Factory<
            Extract<
              (typeof metaMorphoFactoryAbi)[number],
              { type: "event"; name: "CreateMetaMorpho" }
            >
          >;
          readonly startBlock: number;
        }
      >,
    },
    AdaptiveCurveIRM: {
      abi: adaptiveCurveIrmAbi,
      chain: Object.fromEntries(
        configs.map((config) => [
          config.chain.name,
          {
            address: config.adaptiveCurveIrm.address,
            startBlock: sb(config.chain.name, config.adaptiveCurveIrm.startBlock),
          },
        ]),
      ) as Record<
        keyof typeof chains,
        {
          readonly address: `0x${string}`;
          readonly startBlock: number;
        }
      >,
    },
    PreLiquidationFactory: {
      abi: preLiquidationFactoryAbi,
      chain: Object.fromEntries(
        configs.map((config) => [
          config.chain.name,
          {
            address: config.preLiquidationFactory.address,
            startBlock: sb(config.chain.name, config.preLiquidationFactory.startBlock),
          },
        ]),
      ) as Record<
        keyof typeof chains,
        {
          readonly address: `0x${string}`;
          readonly startBlock: number;
        }
      >,
    },
  },
});

interface Factory<event extends AbiEvent = AbiEvent> {
  address: `0x${string}` | readonly `0x${string}`[];
  event: event;
  parameter: Exclude<event["inputs"][number]["name"], undefined>;
}
