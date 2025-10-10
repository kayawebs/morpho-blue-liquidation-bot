import { ponder } from "ponder:registry";
import { market } from "ponder:schema";
import { readContract } from "viem/actions";
import { morphoBlueAbi } from "../abis/MorphoBlue";

const FAST_ONLY_MARKETS = (process.env.FAST_ONLY_MARKETS ?? "")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
const fastCheck = (id: `0x${string}`) =>
  FAST_ONLY_MARKETS.length === 0 || FAST_ONLY_MARKETS.includes(id.toLowerCase());

ponder.on("AdaptiveCurveIRM:BorrowRateUpdate", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  // Row must exist because `BorrowRateUpdate` cannot preceed `CreateMarket`.
  try {
    await context.db
      .update(market, {
        // primary key
        chainId: context.chain.id,
        id: event.args.id,
      })
      .set({
        rateAtTarget: event.args.rateAtTarget,
      });
  } catch {
    // Hydrate missing market row on-demand (fast lookback mode):
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
          rateAtTarget: event.args.rateAtTarget,
        })
        .onConflictDoUpdate({ rateAtTarget: event.args.rateAtTarget });
    } catch {}
  }
});
