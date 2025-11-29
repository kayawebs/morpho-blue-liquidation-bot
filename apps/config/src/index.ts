import dotenv from "dotenv";
import type { Address, Chain, Hex } from "viem";

import { chainConfigs } from "./config.js";
import type { ChainConfig } from "./types";

dotenv.config();

export function chainConfig(chainId: number): ChainConfig {
  const config = chainConfigs[chainId];
  if (!config) {
    throw new Error(`No config found for chainId ${chainId}`);
  }

  const { vaultWhitelist, additionalMarketsWhitelist } = config.options;
  if (vaultWhitelist.length === 0 && additionalMarketsWhitelist.length === 0) {
    throw new Error(
      `Vault whitelist and additional markets whitelist both empty for chainId ${chainId}`,
    );
  }

  const { rpcUrl, wsRpcUrl, executorAddress, liquidationPrivateKey } = getSecrets(
    chainId,
    config.chain,
  );
  return {
    // Hoist all parameters from `options` up 1 level, i.e. flatten the config as much as possible.
    ...(({ options, ...c }) => ({ ...options, ...c }))(config),
    chainId,
    rpcUrl,
    executorAddress,
    wsRpcUrl,
    liquidationPrivateKey,
  };
}

export function getSecrets(chainId: number, chain?: Chain) {
  const defaultRpcUrl = chain?.rpcUrls.default.http[0];

  const rpcUrl = process.env[`RPC_URL_${chainId}`] ?? defaultRpcUrl;
  const wsRpcUrl = process.env[`WS_RPC_URL_${chainId}`];
  // Unify to one address: prefer FLASH_LIQUIDATOR_ADDRESS_<chainId>,
  // but keep backward compatibility with EXECUTOR_ADDRESS_<chainId>.
  const executorAddress =
    process.env[`FLASH_LIQUIDATOR_ADDRESS_${chainId}`] ||
    process.env[`EXECUTOR_ADDRESS_${chainId}`];
  const liquidationPrivateKey = process.env[`LIQUIDATION_PRIVATE_KEY_${chainId}`];

  if (!rpcUrl) {
    throw new Error(`No RPC URL found for chainId ${chainId}`);
  }
  if (!executorAddress) {
    throw new Error(`No liquidator/executor address found for chainId ${chainId}. Set FLASH_LIQUIDATOR_ADDRESS_${chainId}`);
  }
  if (!liquidationPrivateKey) {
    throw new Error(`No liquidation private key found for chainId ${chainId}`);
  }
  return {
    rpcUrl,
    wsRpcUrl,
    executorAddress: executorAddress as Address,
    liquidationPrivateKey: liquidationPrivateKey as Hex,
  };
}

export { chainConfigs, type ChainConfig };
export * from "./liquidityVenues/index.js";
export * from "./pricers/index.js";
