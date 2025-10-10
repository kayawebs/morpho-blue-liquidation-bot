import { ponder } from "ponder:registry";
import { market, position, authorization } from "ponder:schema";

import { zeroFloorSub } from "./utils";
import { readContract } from "viem/actions";
import { morphoBlueAbi } from "../abis/MorphoBlue";

const FAST_ONLY_MARKETS = (process.env.FAST_ONLY_MARKETS ?? "")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
const fastCheck = (id: `0x${string}`) =>
  FAST_ONLY_MARKETS.length === 0 || FAST_ONLY_MARKETS.includes(id.toLowerCase());

ponder.on("Morpho:CreateMarket", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  // `CreateMarket` can only fire once for a given `{ chainId, id }`,
  // so we can insert without any `onConflict` handling.
  await context.db.insert(market).values({
    // primary key
    chainId: context.chain.id,
    id: event.args.id,
    // `MarketParams` struct
    loanToken: event.args.marketParams.loanToken,
    collateralToken: event.args.marketParams.collateralToken,
    oracle: event.args.marketParams.oracle,
    irm: event.args.marketParams.irm,
    lltv: event.args.marketParams.lltv,
    // `Market` struct (unspecified fields default to 0n)
    lastUpdate: event.block.timestamp,
  });
});

ponder.on("Morpho:SetFee", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  try {
    await context.db
      .update(market, { chainId: context.chain.id, id: event.args.id })
      .set({ fee: event.args.newFee });
  } catch {
    try {
      const [params, mview] = await Promise.all([
        readContract(context.client as any, {
          address: event.log.address,
          abi: morphoBlueAbi,
          functionName: "idToMarketParams",
          args: [event.args.id],
          blockNumber: event.block.number,
        }),
        readContract(context.client as any, {
          address: event.log.address,
          abi: morphoBlueAbi,
          functionName: "market",
          args: [event.args.id],
          blockNumber: event.block.number,
        }),
      ]);
      await context.db
        .insert(market)
        .values({
          chainId: context.chain.id,
          id: event.args.id,
          loanToken: params.loanToken,
          collateralToken: params.collateralToken,
          oracle: params.oracle,
          irm: params.irm,
          lltv: params.lltv,
          totalSupplyAssets: mview.totalSupplyAssets,
          totalSupplyShares: mview.totalSupplyShares,
          totalBorrowAssets: mview.totalBorrowAssets,
          totalBorrowShares: mview.totalBorrowShares,
          lastUpdate: event.block.timestamp,
          fee: event.args.newFee,
        })
        .onConflictDoUpdate({ fee: event.args.newFee });
    } catch {}
  }
});

ponder.on("Morpho:AccrueInterest", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  // Row must exist because `AccrueInterest` cannot preceed `CreateMarket`.
  try {
    await context.db
      .update(market, {
        chainId: context.chain.id,
        id: event.args.id,
      })
      .set((row) => ({
        totalSupplyAssets: row.totalSupplyAssets + event.args.interest,
        totalSupplyShares: row.totalSupplyShares + event.args.feeShares,
        totalBorrowAssets: row.totalBorrowAssets + event.args.interest,
        lastUpdate: event.block.timestamp,
      }));
  } catch {
    // Hydrate missing market row on demand using on-chain view at this block
    try {
      const [params, mview] = await Promise.all([
        readContract(context.client as any, {
          address: event.log.address,
          abi: morphoBlueAbi,
          functionName: "idToMarketParams",
          args: [event.args.id],
          blockNumber: event.block.number,
        }),
        readContract(context.client as any, {
          address: event.log.address,
          abi: morphoBlueAbi,
          functionName: "market",
          args: [event.args.id],
          blockNumber: event.block.number,
        }),
      ]);
      await context.db
        .insert(market)
        .values({
          chainId: context.chain.id,
          id: event.args.id,
          loanToken: params.loanToken,
          collateralToken: params.collateralToken,
          oracle: params.oracle,
          irm: params.irm,
          lltv: params.lltv,
          totalSupplyAssets: mview.totalSupplyAssets,
          totalSupplyShares: mview.totalSupplyShares,
          totalBorrowAssets: mview.totalBorrowAssets,
          totalBorrowShares: mview.totalBorrowShares,
          lastUpdate: event.block.timestamp,
          fee: mview.fee,
        })
        .onConflictDoUpdate((row) => ({
          totalSupplyAssets: mview.totalSupplyAssets,
          totalSupplyShares: mview.totalSupplyShares,
          totalBorrowAssets: mview.totalBorrowAssets,
          totalBorrowShares: mview.totalBorrowShares,
          lastUpdate: event.block.timestamp,
          fee: mview.fee,
        }));
    } catch {}
  }
});

ponder.on("Morpho:Supply", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  await Promise.all([
    // Row must exist because `Supply` cannot preceed `CreateMarket`.
    context.db.update(market, { chainId: context.chain.id, id: event.args.id }).set((row) => ({
      totalSupplyAssets: row.totalSupplyAssets + event.args.assets,
      totalSupplyShares: row.totalSupplyShares + event.args.shares,
    })),
    // Row may or may not exist because `Supply` could be `user`'s first action.
    context.db
      .insert(position)
      .values({
        // primary key
        chainId: context.chain.id,
        marketId: event.args.id,
        user: event.args.onBehalf,
        // `Position` struct (unspecified fields default to 0n)
        supplyShares: event.args.shares,
      })
      .onConflictDoUpdate((row) => ({
        supplyShares: row.supplyShares + event.args.shares,
      })),
  ]);
});

ponder.on("Morpho:Withdraw", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  await Promise.all([
    // Row must exist because `Withdraw` cannot preceed `CreateMarket`.
    context.db.update(market, { chainId: context.chain.id, id: event.args.id }).set((row) => ({
      totalSupplyAssets: row.totalSupplyAssets - event.args.assets,
      totalSupplyShares: row.totalSupplyShares - event.args.shares,
    })),
    // Row must exist because `Withdraw` cannot preceed `Supply`.
    (async () => {
      try {
        await context.db
          .update(position, {
            chainId: context.chain.id,
            marketId: event.args.id,
            user: event.args.onBehalf,
          })
          .set((row) => ({ supplyShares: row.supplyShares - event.args.shares }));
      } catch {
        try {
          const p = (await readContract(context.client as any, {
            address: event.log.address,
            abi: morphoBlueAbi,
            functionName: "position",
            args: [event.args.id, event.args.onBehalf],
            blockNumber: event.block.number,
          })) as { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
          await context.db
            .insert(position)
            .values({
              chainId: context.chain.id,
              marketId: event.args.id,
              user: event.args.onBehalf,
              supplyShares: p.supplyShares,
              borrowShares: p.borrowShares,
              collateral: p.collateral,
            })
            .onConflictDoUpdate((row) => ({
              supplyShares: p.supplyShares,
              borrowShares: p.borrowShares,
              collateral: p.collateral,
            }));
        } catch {}
      }
    })(),
  ]);
});

ponder.on("Morpho:SupplyCollateral", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  // Row may or may not exist because `SupplyCollateral` could be `user`'s first action.
  await context.db
    .insert(position)
    .values({
      // primary key
      chainId: context.chain.id,
      marketId: event.args.id,
      user: event.args.onBehalf,
      // `Position` struct (unspecified fields default to 0n)
      collateral: event.args.assets,
    })
    .onConflictDoUpdate((row) => ({
      collateral: row.collateral + event.args.assets,
    }));
});

ponder.on("Morpho:WithdrawCollateral", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  try {
    await context.db
      .update(position, {
        chainId: context.chain.id,
        marketId: event.args.id,
        user: event.args.onBehalf,
      })
      .set((row) => ({ collateral: row.collateral - event.args.assets }));
  } catch {
    try {
      const p = (await readContract(context.client as any, {
        address: event.log.address,
        abi: morphoBlueAbi,
        functionName: "position",
        args: [event.args.id, event.args.onBehalf],
        blockNumber: event.block.number,
      })) as { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
      await context.db
        .insert(position)
        .values({
          chainId: context.chain.id,
          marketId: event.args.id,
          user: event.args.onBehalf,
          supplyShares: p.supplyShares,
          borrowShares: p.borrowShares,
          collateral: p.collateral,
        })
        .onConflictDoUpdate((row) => ({
          supplyShares: p.supplyShares,
          borrowShares: p.borrowShares,
          collateral: p.collateral,
        }));
    } catch {}
  }
});

ponder.on("Morpho:Borrow", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  await Promise.all([
    context.db.update(market, { chainId: context.chain.id, id: event.args.id }).set((row) => ({
      totalBorrowAssets: row.totalBorrowAssets + event.args.assets,
      totalBorrowShares: row.totalBorrowShares + event.args.shares,
    })),
    context.db
      .insert(position)
      .values({
        chainId: context.chain.id,
        marketId: event.args.id,
        user: event.args.onBehalf,
        borrowShares: event.args.shares,
      })
      .onConflictDoUpdate((row) => ({ borrowShares: row.borrowShares + event.args.shares })),
  ]);
});

ponder.on("Morpho:Repay", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  await Promise.all([
    // Row must exist because `Repay` cannot preceed `CreateMarket`.
    context.db.update(market, { chainId: context.chain.id, id: event.args.id }).set((row) => ({
      totalBorrowAssets: row.totalBorrowAssets - event.args.assets,
      totalBorrowShares: row.totalBorrowShares - event.args.shares,
    })),
    // Row must exist because `Repay` cannot preceed `SupplyCollateral`.
    (async () => {
      try {
        await context.db
          .update(position, {
            chainId: context.chain.id,
            marketId: event.args.id,
            user: event.args.onBehalf,
          })
          .set((row) => ({ borrowShares: row.borrowShares - event.args.shares }));
      } catch {
        try {
          const p = (await readContract(context.client as any, {
            address: event.log.address,
            abi: morphoBlueAbi,
            functionName: "position",
            args: [event.args.id, event.args.onBehalf],
            blockNumber: event.block.number,
          })) as { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
          await context.db
            .insert(position)
            .values({
              chainId: context.chain.id,
              marketId: event.args.id,
              user: event.args.onBehalf,
              supplyShares: p.supplyShares,
              borrowShares: p.borrowShares,
              collateral: p.collateral,
            })
            .onConflictDoUpdate((row) => ({
              supplyShares: p.supplyShares,
              borrowShares: p.borrowShares,
              collateral: p.collateral,
            }));
        } catch {}
      }
    })(),
  ]);
});

ponder.on("Morpho:Liquidate", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  await Promise.all([
    // Row must exist because `Liquidate` cannot preceed `CreateMarket`.
    context.db.update(market, { chainId: context.chain.id, id: event.args.id }).set((row) => ({
      totalSupplyAssets: row.totalSupplyAssets - event.args.badDebtAssets,
      totalSupplyShares: row.totalSupplyShares - event.args.badDebtShares,
      totalBorrowAssets: zeroFloorSub(
        row.totalBorrowAssets,
        event.args.repaidAssets + event.args.badDebtAssets,
      ),
      totalBorrowShares: row.totalBorrowShares - event.args.repaidShares - event.args.badDebtShares,
    })),
    (async () => {
      try {
        await context.db
          .update(position, {
            chainId: context.chain.id,
            marketId: event.args.id,
            user: event.args.borrower,
          })
          .set((row) => ({
            collateral: row.collateral - event.args.seizedAssets,
            borrowShares: row.borrowShares - event.args.repaidShares - event.args.badDebtShares,
          }));
      } catch {
        try {
          const p = (await readContract(context.client as any, {
            address: event.log.address,
            abi: morphoBlueAbi,
            functionName: "position",
            args: [event.args.id, event.args.borrower],
            blockNumber: event.block.number,
          })) as { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
          await context.db
            .insert(position)
            .values({
              chainId: context.chain.id,
              marketId: event.args.id,
              user: event.args.borrower,
              supplyShares: p.supplyShares,
              borrowShares: p.borrowShares,
              collateral: p.collateral,
            })
            .onConflictDoUpdate((row) => ({
              supplyShares: p.supplyShares,
              borrowShares: p.borrowShares,
              collateral: p.collateral,
            }));
        } catch {}
      }
    })(),
  ]);
});

ponder.on("Morpho:SetAuthorization", async ({ event, context }) => {
  await context.db
    .insert(authorization)
    .values({
      chainId: context.chain.id,
      authorizer: event.args.authorizer,
      authorizee: event.args.authorized,
      isAuthorized: event.args.newIsAuthorized,
    })
    .onConflictDoUpdate(() => ({
      isAuthorized: event.args.newIsAuthorized,
    }));
});
