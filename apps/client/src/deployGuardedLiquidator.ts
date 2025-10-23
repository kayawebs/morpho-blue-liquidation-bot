import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt, deployContract } from "viem/actions";

dotenv.config();

function loadArtifact() {
  // Try Foundry first
  const foundry = path.join(process.cwd(), "out", "GuardedLiquidator.sol", "GuardedLiquidator.json");
  if (fs.existsSync(foundry)) return JSON.parse(fs.readFileSync(foundry, "utf8"));
  // Try Hardhat default
  const hh = path.join(process.cwd(), "artifacts", "contracts", "GuardedLiquidator.sol", "GuardedLiquidator.json");
  if (fs.existsSync(hh)) return JSON.parse(fs.readFileSync(hh, "utf8"));
  throw new Error(
    "Cannot find GuardedLiquidator artifact. Please compile with Foundry (forge build) or Hardhat before running this script.",
  );
}

async function main() {
  const chainId = 8453;
  const rpcUrl = process.env[`RPC_URL_${chainId}`];
  const priv = process.env[`LIQUIDATION_PRIVATE_KEY_${chainId}`];
  if (!rpcUrl) throw new Error(`RPC_URL_${chainId} is missing in .env`);
  if (!priv) throw new Error(`LIQUIDATION_PRIVATE_KEY_${chainId} is missing in .env`);

  const defaultAggregator = (process.env[`AGGREGATOR_ADDRESS_${chainId}`] ??
    "0x852aE0B1Af1aAeDB0fC4428B4B24420780976ca8") as Address;
  const defaultDevBps = Number(process.env.GUARD_MAX_DEV_BPS ?? 10); // 0.10%
  const defaultMaxAgeSec = Number(process.env.GUARD_MAX_AGE_SEC ?? 120);

  const client = createWalletClient({
    transport: http(rpcUrl),
    account: privateKeyToAccount(priv as Hex),
  });

  const artifact = loadArtifact();
  const abi = artifact.abi as any[];
  const bytecode = (artifact.bytecode ?? artifact.byteCode ?? artifact.deployedBytecode ?? artifact.bytecode?.object) as Hex;
  if (!abi || !bytecode) throw new Error("Invalid artifact (missing abi/bytecode)");

  console.log("Deploying GuardedLiquidator with params:");
  console.log("  owner:", client.account!.address);
  console.log("  aggregator:", defaultAggregator);
  console.log("  maxDevBps:", defaultDevBps);
  console.log("  maxAgeSec:", defaultMaxAgeSec);

  const hash = await deployContract(client, {
    abi,
    bytecode,
    account: client.account!,
    args: [client.account!.address, defaultAggregator, defaultDevBps, defaultMaxAgeSec],
  });
  const receipt = await waitForTransactionReceipt(client, { hash });
  console.log("GuardedLiquidator deployed at:", receipt.contractAddress);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
