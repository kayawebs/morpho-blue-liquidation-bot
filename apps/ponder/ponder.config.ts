import { chainConfig, chainConfigs } from "@morpho-blue-liquidation-bot/config";
import { createConfig, factory } from "ponder";
import { type AbiEvent, getAbiItem, createPublicClient, http, webSocket } from "viem";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { adaptiveCurveIrmAbi } from "./abis/AdaptiveCurveIrm";
import { metaMorphoAbi } from "./abis/MetaMorpho";
import { metaMorphoFactoryAbi } from "./abis/MetaMorphoFactory";
import { morphoBlueAbi } from "./abis/MorphoBlue";
import { preLiquidationFactoryAbi } from "./abis/PreLiquidationFactory";
import { chainlinkOcr2Abi } from "./abis/ChainlinkOCR2";

const configs = Object.values(chainConfigs).map((config) => chainConfig(config.chain.id));

// Optional fast-lookback override to reduce initial history scanned.
const LOOKBACK = Number(process.env.FAST_LOOKBACK_BLOCKS ?? "0");
const latestByChain: Record<string, number> = {};

async function computeLatestHeads() {
  for (const cfg of configs) {
    const transport = cfg.wsRpcUrl
      ? webSocket(cfg.wsRpcUrl)
      : http(cfg.rpcUrl, { batch: true, retryCount: 5 });
    const client = createPublicClient({ chain: cfg.chain, transport });
    const latest = await client.getBlockNumber();
    latestByChain[cfg.chain.name] = Number(latest);
  }
}

const FREEZE = process.env.PONDER_FREEZE_HEAD === '1';
const headPath = resolve(process.cwd(), '.ponder-head.json');
if (LOOKBACK > 0) {
  if (FREEZE && existsSync(headPath)) {
    try {
      const saved = JSON.parse(readFileSync(headPath, 'utf8')) as Record<string, number>;
      Object.assign(latestByChain, saved);
      console.log(`Using frozen heads from .ponder-head.json`);
    } catch {
      await computeLatestHeads();
      try { writeFileSync(headPath, JSON.stringify(latestByChain, null, 2)); } catch {}
    }
  } else {
    await computeLatestHeads();
    if (FREEZE) {
      try { writeFileSync(headPath, JSON.stringify(latestByChain, null, 2)); } catch {}
    }
  }
}
const sb = (chainName: string, orig: number) =>
  LOOKBACK > 0 ? Math.max(orig, (latestByChain[chainName] ?? orig) - LOOKBACK) : orig;

const chains = Object.fromEntries(
  configs.map((config) => [
    config.chain.name,
    {
      id: config.chain.id,
      // Prefer WS endpoint if provided to improve near-head sync responsiveness.
      rpc: config.wsRpcUrl ?? config.rpcUrl,
    },
  ]),
);

// Helpful log to confirm which RPC each chain uses (and whether WS is preferred)
for (const cfg of configs) {
  const chosen = cfg.wsRpcUrl ?? cfg.rpcUrl;
  const mode = cfg.wsRpcUrl ? 'ws' : 'http';
  console.log(`Ponder RPC for ${cfg.chain.name} (${cfg.chain.id}) [${mode}]: ${chosen}`);
}

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
    ChainlinkAggregator: {
      abi: chainlinkOcr2Abi,
      chain: Object.fromEntries(
        configs
          .map((config) => {
            const addr =
              (process.env[`AGGREGATOR_ADDRESS_${config.chain.id}`] as `0x${string}` | undefined) ??
              (config.chain.id === 8453 ? ("0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8" as `0x${string}`) : undefined);
            if (!addr) return undefined as unknown as [keyof typeof chains, { address: `0x${string}`; startBlock: number }];
            return [
              config.chain.name as keyof typeof chains,
              { address: addr, startBlock: sb(config.chain.name, 1) },
            ];
          })
          .filter(Boolean) as any,
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
