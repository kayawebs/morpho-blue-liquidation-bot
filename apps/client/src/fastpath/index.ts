import {
  AccrualPosition,
  Market,
  MarketParams as BlueMarketParams,
  type IAccrualPosition,
  type IMarket,
} from "@morpho-org/blue-sdk";
import {
  type Account,
  type Address,
  type Chain,
  type Client,
  type Transport,
  decodeFunctionData,
} from "viem";
import { readContract } from "viem/actions";

import { morphoBlueAbi } from "../../../ponder/abis/MorphoBlue.js";
import { oracleAbi } from "../../../ponder/abis/Oracle.js";

type PendingTx = {
  to?: Address;
  input?: string;
};

export interface AnalyzeResult {
  market?: IMarket;
  position?: IAccrualPosition & { seizableCollateral: bigint };
}

export async function analyzeMorphoPendingTx(
  client: Client<Transport, Chain, Account>,
  morphoAddress: Address,
  tx: PendingTx,
): Promise<AnalyzeResult | undefined> {
  if (!tx.input) return;

  let decoded: ReturnType<typeof decodeFunctionData> | undefined;
  try {
    decoded = decodeFunctionData({ abi: morphoBlueAbi, data: tx.input as Address });
  } catch {
    return; // not a recognized Morpho call
  }

  if (!decoded) return;

  const { functionName, args } = decoded as { functionName: string; args: any[] };

  // Only handle risk-increasing calls for fast-path
  const riskIncreasing = ["borrow", "withdrawCollateral"];
  if (!riskIncreasing.includes(functionName)) return;

  // Extract market params and user
  const mp = args[0] as {
    loanToken: Address;
    collateralToken: Address;
    oracle: Address;
    irm: Address;
    lltv: bigint;
  };

  let user: Address | undefined;
  if (functionName === "borrow") {
    // borrow(marketParams, assets, shares, onBehalf, receiver)
    user = args[3] as Address;
  } else if (functionName === "withdrawCollateral") {
    // withdrawCollateral(marketParams, assets, onBehalf, receiver)
    user = args[2] as Address;
  }
  if (!user) return;

  // Build marketId via Blue SDK
  const blueParams = new BlueMarketParams(mp);

  // Fetch onchain market aggregates and price
  const marketId = blueParams.id;
  const [marketView, price] = await Promise.all([
    readContract(client, {
      address: morphoAddress,
      abi: morphoBlueAbi,
      functionName: "market",
      args: [marketId],
    }) as Promise<{
      totalSupplyAssets: bigint;
      totalSupplyShares: bigint;
      totalBorrowAssets: bigint;
      totalBorrowShares: bigint;
      lastUpdate: bigint;
      fee: bigint;
    }>,
    readContract(client, {
      address: mp.oracle,
      abi: oracleAbi,
      functionName: "price",
    }) as Promise<bigint>,
  ]);

  const now = Math.floor(Date.now() / 1000).toString();
  const market: IMarket = new Market({
    chainId: client.chain.id,
    id: marketId as any,
    params: blueParams,
    price,
    totalSupplyAssets: marketView.totalSupplyAssets,
    totalSupplyShares: marketView.totalSupplyShares,
    totalBorrowAssets: marketView.totalBorrowAssets,
    totalBorrowShares: marketView.totalBorrowShares,
    lastUpdate: marketView.lastUpdate,
    fee: marketView.fee,
  }).accrueInterest(now);

  // Fetch current position
  const positionView = (await readContract(client, {
    address: morphoAddress,
    abi: morphoBlueAbi,
    functionName: "position",
    args: [marketId, user],
  })) as {
    supplyShares: bigint;
    borrowShares: bigint;
    collateral: bigint;
  };

  // Predict post-tx changes
  let predictedBorrowShares = positionView.borrowShares;
  let predictedCollateral = positionView.collateral;

  if (functionName === "borrow") {
    const assets = args[1] as bigint; // requested assets
    const shares = args[2] as bigint; // shares bound (min/max)
    if (shares && shares > 0n) {
      predictedBorrowShares += shares;
    } else if (assets && assets > 0n) {
      predictedBorrowShares += assetsToBorrowShares(market, assets);
    }
  } else if (functionName === "withdrawCollateral") {
    const assets = args[1] as bigint;
    predictedCollateral = predictedCollateral > assets ? predictedCollateral - assets : 0n;
  }

  const candidate: IAccrualPosition = {
    chainId: client.chain.id,
    marketId: market.id as any,
    user,
    supplyShares: positionView.supplyShares,
    borrowShares: predictedBorrowShares,
    collateral: predictedCollateral,
  };

  const seizableCollateral = new AccrualPosition(candidate, market).seizableCollateral ?? 0n;

  return { market, position: { ...candidate, seizableCollateral } };
}

function assetsToBorrowShares(market: IMarket, assets: bigint): bigint {
  const { totalBorrowAssets, totalBorrowShares } = market;
  if (totalBorrowShares === 0n || totalBorrowAssets === 0n) return assets; // fallback
  // shares = assets * totalBorrowShares / totalBorrowAssets
  return (assets * totalBorrowShares) / totalBorrowAssets;
}

