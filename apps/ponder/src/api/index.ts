import { Hono } from "hono";
import { and, client, eq, inArray, graphql, gt, replaceBigInts as replaceBigIntsBase } from "ponder";
import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import type { Address, Hex } from "viem";

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

app.post("/chain/:chainId/candidates", async (c) => {
  const { chainId: chainIdRaw } = c.req.param();
  const { marketIds: marketIdsRaw } = (await c.req.json()) as unknown as { marketIds: Hex[] };

  if (!Array.isArray(marketIdsRaw) || marketIdsRaw.length === 0) {
    return c.json({ error: "Request body must include a non-empty `marketIds` array." }, 400);
  }
  const chainId = Number.parseInt(chainIdRaw, 10);
  const marketIds = [...new Set(marketIdsRaw)];

  const rows = await db
    .select({ user: schema.position.user, marketId: schema.position.marketId })
    .from(schema.position)
    .where(
      and(
        eq(schema.position.chainId, chainId),
        inArray(schema.position.marketId, marketIds),
        gt(schema.position.borrowShares, 0n),
      ),
    )
    .groupBy(schema.position.user, schema.position.marketId);

  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const k = r.marketId as string;
    if (!out[k]) out[k] = [];
    out[k]!.push(r.user as string);
  }
  return c.json(out);
});

/**
 * Fetch positions for given markets, optionally filtering to those with pre-liquidation authorization
 * and optionally including the related pre-liquidation contract addresses (and count).
 * Body: { marketIds: Hex[], onlyPreLiq?: boolean, includeContracts?: boolean }
 */
app.post("/chain/:chainId/positions", async (c) => {
  const { chainId: chainIdRaw } = c.req.param();
  const { marketIds: marketIdsRaw, onlyPreLiq, includeContracts } = (await c.req.json()) as unknown as {
    marketIds: Hex[];
    onlyPreLiq?: boolean;
    includeContracts?: boolean;
  };

  if (!Array.isArray(marketIdsRaw) || marketIdsRaw.length === 0) {
    return c.json({ error: "Request body must include a non-empty `marketIds` array." }, 400);
  }
  const chainId = Number.parseInt(chainIdRaw, 10);
  const marketIds = [...new Set(marketIdsRaw)];

  // All borrower positions for the requested markets
  const posRows = await db.query.position.findMany({
    where: (row) => and(eq(row.chainId, chainId), inArray(row.marketId, marketIds), gt(row.borrowShares, 0n)),
  });

  // Authorized pre-liquidation contracts mapped by (marketId,user)
  const preRows = await db
    .select({
      position: schema.position,
      pre: schema.preLiquidationContract,
      status: schema.preLiquidationPosition,
    })
    .from(schema.preLiquidationPosition)
    .innerJoin(
      schema.preLiquidationContract,
      and(
        eq(schema.preLiquidationContract.chainId, schema.preLiquidationPosition.chainId),
        eq(schema.preLiquidationContract.address, schema.preLiquidationPosition.preLiquidation),
      ),
    )
    .innerJoin(
      schema.position,
      and(
        eq(schema.position.chainId, schema.preLiquidationPosition.chainId),
        eq(schema.position.marketId, schema.preLiquidationPosition.marketId),
        eq(schema.position.user, schema.preLiquidationPosition.user),
        gt(schema.position.borrowShares, 0n),
      ),
    )
    .where(
      and(
        eq(schema.preLiquidationPosition.chainId, chainId),
        inArray(schema.preLiquidationPosition.marketId, marketIds),
        eq(schema.preLiquidationPosition.isAuthorized, true),
      ),
    );

  const preMap = new Map<string, (typeof preRows)[number]["pre"][]>();
  for (const r of preRows) {
    const key = `${r.position.marketId}:${r.position.user.toLowerCase()}`;
    const arr = preMap.get(key) ?? [];
    arr.push(r.pre);
    preMap.set(key, arr);
  }

  // Group positions by market
  const byMarket = new Map<string, typeof posRows>();
  for (const p of posRows) {
    const k = p.marketId as string;
    if (!byMarket.has(k)) byMarket.set(k, []);
    byMarket.get(k)!.push(p);
  }

  const results = [] as any[];
  for (const mid of marketIds) {
    const list = (byMarket.get(mid as string) ?? []).filter((p) => {
      if (!onlyPreLiq) return true;
      const key = `${p.marketId}:${p.user.toLowerCase()}`;
      return preMap.has(key);
    });
    const items = list.map((p) => {
      const key = `${p.marketId}:${p.user.toLowerCase()}`;
      const contracts = preMap.get(key) ?? [];
      return {
        user: p.user,
        supplyShares: p.supplyShares,
        borrowShares: p.borrowShares,
        collateral: p.collateral,
        preLiqAuthorized: contracts.length > 0,
        preLiqCount: contracts.length,
        preLiqContracts: includeContracts ? contracts.map((x) => x.address) : undefined,
      };
    });
    results.push({ marketId: mid, positions: items });
  }

  return c.json(replaceBigInts({ results }));
});

export default app;
