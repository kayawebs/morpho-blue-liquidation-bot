import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployContract, waitForTransactionReceipt } from "viem/actions";

dotenv.config();

const CONTRACT_NAME = "FlashLiquidatorV3";
const SOURCE_REL_PATH = path.join("contracts", `${CONTRACT_NAME}.sol`);

type Artifact = { abi: any[]; bytecode: Hex };

const DEFAULTS = {
  chainId: 8453,
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
  oracle: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
  pool: "0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef",
  loanToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  collateralToken: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
};

async function compileViaSolc(): Promise<Artifact> {
  const sourcePath = path.join(process.cwd(), SOURCE_REL_PATH);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Cannot find ${SOURCE_REL_PATH}`);
  }
  console.log(`ℹ️ Compiling ${CONTRACT_NAME} via solc...`);
  const source = fs.readFileSync(sourcePath, "utf8");

  const solcMod = await import("solc");
  const solcInstance = (solcMod as any).default ?? solcMod;
  const input = {
    language: "Solidity",
    sources: { [`${CONTRACT_NAME}.sol`]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };
  const output = JSON.parse(solcInstance.compile(JSON.stringify(input)));
  if (output.errors?.length) {
    const err = output.errors.find((e: any) => e.severity === "error");
    if (err) {
      throw new Error(err.formattedMessage ?? err.message);
    }
    for (const warn of output.errors) {
      console.warn(warn.formattedMessage ?? warn.message);
    }
  }
  const contract = output.contracts?.[`${CONTRACT_NAME}.sol`]?.[CONTRACT_NAME];
  if (!contract?.abi || !contract?.evm?.bytecode?.object) {
    throw new Error("solc output missing abi/bytecode");
  }
  const bytecodeString = contract.evm.bytecode.object as string;
  const bytecode = (bytecodeString.startsWith("0x") ? bytecodeString : `0x${bytecodeString}`) as Hex;

  const outDir = path.join(process.cwd(), "out", `${CONTRACT_NAME}.sol`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, `${CONTRACT_NAME}.json`),
      JSON.stringify({ abi: contract.abi, bytecode }, null, 2),
    );
  } catch {}
  return { abi: contract.abi as any[], bytecode };
}

async function loadArtifact(): Promise<Artifact> {
  const outPath = path.join(process.cwd(), "out", `${CONTRACT_NAME}.sol`, `${CONTRACT_NAME}.json`);
  if (fs.existsSync(outPath)) {
    return JSON.parse(fs.readFileSync(outPath, "utf8"));
  }
  const hhPath = path.join(process.cwd(), "artifacts", "contracts", `${CONTRACT_NAME}.sol`, `${CONTRACT_NAME}.json`);
  if (fs.existsSync(hhPath)) {
    const raw = JSON.parse(fs.readFileSync(hhPath, "utf8"));
    const abi = raw.abi;
    const bytecode = (raw.bytecode ?? raw.evmbitecode ?? raw.deployedBytecode ?? raw.bytecode?.object) as Hex;
    if (!abi || !bytecode) throw new Error("hardhat artifact missing abi/bytecode");
    return { abi, bytecode };
  }
  return compileViaSolc();
}

function readRequired(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.trim() !== "") return v.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env ${name}`);
}

function toBytes32(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`marketId must be 32-byte hex (got ${value})`);
  return value as Hex;
}

async function main() {
  const chainId = Number(process.env.DEPLOY_CHAIN_ID ?? DEFAULTS.chainId);
  const rpcUrl = readRequired(`RPC_URL_${chainId}`);
  const priv = readRequired(`LIQUIDATION_PRIVATE_KEY_${chainId}`);

  const morpho = readRequired("FLASH_MORPHO_ADDRESS", DEFAULTS.morpho) as Address;
  const marketId = toBytes32(readRequired("FLASH_MARKET_ID", DEFAULTS.marketId));
  const oracle = readRequired("FLASH_ORACLE_ADDRESS", DEFAULTS.oracle) as Address;
  const pool = readRequired("FLASH_UNISWAP_POOL_ADDRESS", DEFAULTS.pool) as Address;
  const loanToken = readRequired("FLASH_LOAN_TOKEN_ADDRESS", DEFAULTS.loanToken) as Address;
  const collateralToken = readRequired("FLASH_COLLATERAL_TOKEN_ADDRESS", DEFAULTS.collateralToken) as Address;

  const account = privateKeyToAccount(priv as Hex);
  const chain = {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const client = createWalletClient({
    chain,
    transport: http(rpcUrl),
    account,
  });

  const authorized =
    (process.env.FLASH_AUTHORIZED_CALLER ?? account.address) as Address;

  const artifact = await loadArtifact();
  console.log("Deploy params:");
  console.log("  owner:", account.address);
  console.log("  morpho:", morpho);
  console.log("  marketId:", marketId);
  console.log("  oracle:", oracle);
  console.log("  pool:", pool);
  console.log("  loanToken:", loanToken);
  console.log("  collateralToken:", collateralToken);
  console.log("  authorizedCaller:", authorized);

  const hash = await deployContract(client, {
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account,
    args: [morpho, marketId, oracle, pool, loanToken, collateralToken, authorized],
  });
  console.log("tx hash:", hash);
  const receipt = await waitForTransactionReceipt(client, { hash });
  console.log("FlashLiquidator deployed at:", receipt.contractAddress);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
