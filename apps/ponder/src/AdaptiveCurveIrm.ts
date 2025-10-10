import { ponder } from "ponder:registry";
import { market } from "ponder:schema";

const FAST_ONLY_MARKETS = (process.env.FAST_ONLY_MARKETS ?? "")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
const fastCheck = (id: `0x${string}`) =>
  FAST_ONLY_MARKETS.length === 0 || FAST_ONLY_MARKETS.includes(id.toLowerCase());

ponder.on("AdaptiveCurveIRM:BorrowRateUpdate", async ({ event, context }) => {
  if (!fastCheck(event.args.id)) return;
  // Row must exist because `BorrowRateUpdate` cannot preceed `CreateMarket`.
  await context.db
    .update(market, {
      // primary key
      chainId: context.chain.id,
      id: event.args.id,
    })
    .set({
      rateAtTarget: event.args.rateAtTarget,
    });
});
