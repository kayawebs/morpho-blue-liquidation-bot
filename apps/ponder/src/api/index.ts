import { Hono } from "hono";
import { and, client, eq, inArray, graphql, replaceBigInts as replaceBigIntsBase } from "ponder";
import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import type { Address, Hex } from "viem";
import { getAbiItem } from "viem";
import { morphoBlueAbi } from "../../ponder/abis/MorphoBlue";
import { chainConfig } from "@morpho-blue-liquidation-bot/config";

import { getLiquidatablePositions } from "./liquidatable-positions";

function replaceBigInts<T>(value: T) {
  return replaceBigIntsBase(value, (x) => `${String(x)}n`);
}

const app = new Hono();

app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));
app.use("/sql/*", client({ db, schema }));

app.post("/chain/:id/withdraw-queue/:address", async (c) => {
  const { id: chainId, address } = c.req.param();

  const vault = await db.query.vault.findFirst({
    where: (row) => and(eq(row.chainId, Number(chainId)), eq(row.address, address as Address)),
  });

  return c.json(vault?.withdrawQueue ?? []);
});

/**
 * Fetch all liquidatable (and pre-liquidatable) positions for a given set of markets.
 */
app.post("/chain/:chainId/liquidatable-positions", async (c) => {
  const { chainId: chainIdRaw } = c.req.param();
  const { marketIds: marketIdsRaw } = (await c.req.json()) as unknown as { marketIds: Hex[] };

  if (!Array.isArray(marketIdsRaw)) {
    return c.json({ error: "Request body must include a `marketIds` array." }, 400);
  }

  const chainId = Number.parseInt(chainIdRaw, 10);
  const marketIds = [...new Set(marketIdsRaw)];

  const publicClient = Object.values(publicClients).find(
    (publicClient) => publicClient.chain?.id === chainId,
  );

  if (!publicClient) {
    return c.json(
      {
        error: `${chainIdRaw} is not one of the supported chains: [${Object.keys(publicClients).join(", ")}]`,
      },
      400,
    );
  }

  const response = await getLiquidatablePositions({ db, chainId, publicClient, marketIds });
  return c.json(replaceBigInts(response));
});

// Return candidate users for provided markets (unique borrowers with borrowShares > 0)
const CAND_SRC = (process.env.PONDER_CANDIDATE_SOURCE ?? "ponder").toLowerCase();
const CAND_LOGS_LOOKBACK = Number(process.env.PONDER_CANDIDATE_LOGS_LOOKBACK_BLOCKS ?? "10000");
const CAND_LOGS_CHUNK = Number(process.env.PONDER_CANDIDATE_LOGS_CHUNK ?? "2000");

app.post("/chain/:chainId/candidates", async (c) => {
  const { chainId: chainIdRaw } = c.req.param();
  const { marketIds: marketIdsRaw } = (await c.req.json()) as unknown as { marketIds: Hex[] };

  if (!Array.isArray(marketIdsRaw) || marketIdsRaw.length === 0) {
    return c.json({ error: "Request body must include a non-empty `marketIds` array." }, 400);
  }
  const chainId = Number.parseInt(chainIdRaw, 10);
  const marketIds = [...new Set(marketIdsRaw)];

  const out: Record<string, string[]> = {};

  if (CAND_SRC === "ponder") {
    const rows = await db
      .select({ user: schema.position.user, marketId: schema.position.marketId })
      .from(schema.position)
      .where(and(eq(schema.position.chainId, chainId), inArray(schema.position.marketId, marketIds)))
      .groupBy(schema.position.user, schema.position.marketId);
    for (const r of rows) {
      const k = r.marketId as string;
      if (!out[k]) out[k] = [];
      out[k]!.push(r.user as string);
    }
    return c.json(out);
  }

  // logs fallback: scan last N blocks for Borrow & SupplyCollateral, return unique onBehalf
  const publicClient = Object.values(publicClients).find((pc) => pc.chain?.id === chainId);
  if (!publicClient) return c.json({ error: `No client for chain ${chainId}` }, 400);
  const cfg = chainConfig(chainId);
  const borrowEvent = getAbiItem({ abi: morphoBlueAbi, name: "Borrow" }) as any;
  const supplyColEvent = getAbiItem({ abi: morphoBlueAbi, name: "SupplyCollateral" }) as any;
  const head = await publicClient.getBlockNumber();
  const fromBlock = head > BigInt(CAND_LOGS_LOOKBACK) ? head - BigInt(CAND_LOGS_LOOKBACK) : 0n;
  const step = BigInt(CAND_LOGS_CHUNK);

  for (const mid of marketIds) {
    const set = new Set<string>();
    for (let start = fromBlock; start <= head; start += step) {
      const end = start + step - 1n > head ? head : start + step - 1n;
      try {
        const [borrows, supplies] = await Promise.all([
          publicClient.getLogs({
            address: cfg.morpho.address,
            event: borrowEvent,
            args: { id: mid },
            fromBlock: start,
            toBlock: end,
          } as any),
          publicClient.getLogs({
            address: cfg.morpho.address,
            event: supplyColEvent,
            args: { id: mid },
            fromBlock: start,
            toBlock: end,
          } as any),
        ]);
        for (const l of borrows as any[]) set.add((l.args.onBehalf as string).toLowerCase());
        for (const l of supplies as any[]) set.add((l.args.onBehalf as string).toLowerCase());
      } catch {}
    }
    out[mid] = [...set];
  }
  return c.json(out);
});

export default app;
