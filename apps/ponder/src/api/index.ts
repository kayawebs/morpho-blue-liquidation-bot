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
const CAND_BACKFILL_TOTAL = Number(process.env.PONDER_CANDIDATE_BACKFILL_TOTAL_BLOCKS ?? String(CAND_LOGS_LOOKBACK));

type BackfillState = {
  setMap: Map<Hex, Set<string>>;
  head: bigint;
  cursor: bigint;
  minBlock: bigint;
  step: bigint;
  running: boolean;
};

const backfillStates: Record<number, BackfillState | undefined> = {};

async function ensureBackfill(
  chainId: number,
  publicClient: any,
  marketIds: Hex[],
): Promise<void> {
  if (backfillStates[chainId]) return;
  const head: bigint = await publicClient.getBlockNumber();
  const minBlock = head > BigInt(CAND_BACKFILL_TOTAL) ? head - BigInt(CAND_BACKFILL_TOTAL) : 0n;
  backfillStates[chainId] = {
    setMap: new Map(),
    head,
    cursor: head,
    minBlock,
    step: BigInt(Math.max(1, CAND_LOGS_CHUNK)),
    running: false,
  };

  // Seed with initial LOOKBACK window immediately
  await scanWindow(chainId, publicClient, marketIds, head > BigInt(CAND_LOGS_LOOKBACK) ? head - BigInt(CAND_LOGS_LOOKBACK) : 0n, head);

  // Start background backfill toward older blocks
  void runBackfill(chainId, publicClient, marketIds);
}

async function scanWindow(
  chainId: number,
  publicClient: any,
  marketIds: Hex[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<void> {
  const st = backfillStates[chainId]!;
  const borrowEvent = getAbiItem({ abi: morphoBlueAbi, name: "Borrow" }) as any;
  const supplyColEvent = getAbiItem({ abi: morphoBlueAbi, name: "SupplyCollateral" }) as any;
  const cfg = chainConfig(chainId);
  for (const mid of marketIds) {
    let set = st.setMap.get(mid);
    if (!set) {
      set = new Set<string>();
      st.setMap.set(mid, set);
    }
    try {
      const [borrows, supplies] = await Promise.all([
        publicClient.getLogs({ address: cfg.morpho.address, event: borrowEvent, args: { id: mid }, fromBlock, toBlock } as any),
        publicClient.getLogs({ address: cfg.morpho.address, event: supplyColEvent, args: { id: mid }, fromBlock, toBlock } as any),
      ]);
      for (const l of borrows as any[]) set.add((l.args.onBehalf as string).toLowerCase());
      for (const l of supplies as any[]) set.add((l.args.onBehalf as string).toLowerCase());
    } catch {}
  }
}

async function runBackfill(chainId: number, publicClient: any, marketIds: Hex[]) {
  const st = backfillStates[chainId]!;
  if (st.running) return;
  st.running = true;
  try {
    while (st.cursor > st.minBlock) {
      const end = st.cursor;
      const start = end > st.step ? end - st.step : 0n;
      await scanWindow(chainId, publicClient, marketIds, start, end);
      st.cursor = start > 0n ? start - 1n : 0n;
      // Small pause to avoid hammering RPC
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    st.running = false;
  }
}

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

  // logs fallback: progressive backfill in background + cached candidates
  const publicClient = Object.values(publicClients).find((pc) => pc.chain?.id === chainId);
  if (!publicClient) return c.json({ error: `No client for chain ${chainId}` }, 400);
  await ensureBackfill(chainId, publicClient, marketIds);
  const st = backfillStates[chainId]!;
  for (const mid of marketIds) {
    out[mid] = [...(st.setMap.get(mid) ?? new Set<string>())];
  }
  return c.json(out);
});

export default app;
