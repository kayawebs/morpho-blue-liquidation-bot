import { ponder } from "ponder:registry";
import { oracleTransmission } from "ponder:schema";

// Handle Chainlink OCR2 NewTransmission and persist to DB
ponder.on("ChainlinkAggregator:NewTransmission", async ({ event, context }) => {
  try {
    await context.db
      .insert(oracleTransmission)
      .values({
        chainId: context.chain.id,
        oracleAddr: event.log.address,
        roundId: Number(event.args.aggregatorRoundId),
        answerRaw: BigInt(event.args.answer as unknown as bigint),
        blockNumber: event.block.number,
        txHash: event.transaction.hash,
        ts: event.block.timestamp,
      })
      .onConflictDoNothing();
  } catch {
    // ignore duplicates or transient db errors
  }
});

