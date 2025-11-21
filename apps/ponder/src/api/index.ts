import { Hono } from "hono";
import { and, client, eq, inArray, graphql, gt, gte, desc, replaceBigInts as replaceBigIntsBase } from "ponder";
import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import type { Address, Hex } from "viem";

import { getLiquidatablePositions } from "./liquidatable-positions";
// Note: paths are resolved relative to apps/ponder/src/api
// - config lives at apps/config/dist
// - ABIs live at apps/ponder/abis
import { chainConfig } from "../../../config/dist/index.js";
import { morphoBlueAbi } from "../../abis/MorphoBlue.ts";

const ERC20_DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

function replaceBigInts<T>(value: T) {
  return replaceBigIntsBase(value, (x) => `${String(x)}n`);
}

const app = new Hono();

// Mount GraphQL only under /graphql to avoid intercepting custom routes.
app.use("/graphql", graphql({ db, schema }));
app.use("/sql/*", client({ db, schema }));

// Avoid reserved route name "/health" used internally by Ponder.
app.get('/status', (c) => c.json({ ok: true }));

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

/**
 * Read market view & params from chain via the same viem client that Ponder uses.
 * Body: { marketId: Hex }
 * Returns: { loanToken, collateralToken, lltv, totalBorrowAssets, totalBorrowShares, loanDec, collDec }
 */
app.post("/chain/:chainId/marketView", async (c) => {
  const { chainId: chainIdRaw } = c.req.param();
  const { marketId } = (await c.req.json()) as unknown as { marketId: Hex };
  if (!marketId || typeof marketId !== 'string') {
    return c.json({ error: "Request body must include `marketId` (Hex)" }, 400);
  }
  const chainId = Number.parseInt(chainIdRaw, 10);
  const publicClient = Object.values(publicClients).find((pc) => pc.chain?.id === chainId);
  if (!publicClient) return c.json({ error: `Unsupported chain ${chainId}` }, 400);
  const cfg = chainConfig(chainId);
  const morphoAddr = cfg.morpho.address as Address;

  const TIMEOUT_MS = Number(process.env.PONDER_API_RPC_TIMEOUT ?? '7000');
  const withTimeout = async <T>(p: Promise<T>): Promise<T> =>
    await Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
    ]);

  let params: any, view: any;
  try {
    [params, view] = await Promise.all([
      withTimeout(publicClient.readContract({ address: morphoAddr, abi: morphoBlueAbi as any, functionName: 'idToMarketParams', args: [marketId as any] } as any)),
      withTimeout(publicClient.readContract({ address: morphoAddr, abi: morphoBlueAbi as any, functionName: 'market', args: [marketId as any] } as any)),
    ]);
  } catch (e: any) {
    return c.json({ error: 'rpc_error', message: e?.message ?? String(e) }, 502);
  }
  const loanToken = (params as any)?.loanToken as Address | undefined;
  const collateralToken = (params as any)?.collateralToken as Address | undefined;
  const lltv = (params as any).lltv as bigint;
  const totalBorrowAssets = (view as any).totalBorrowAssets as bigint;
  const totalBorrowShares = (view as any).totalBorrowShares as bigint;
  let loanDec = 18, collDec = 18;
  const isAddr = (a?: string) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  if (isAddr(loanToken) && isAddr(collateralToken)) {
    try {
      [loanDec, collDec] = await Promise.all([
        withTimeout(publicClient.readContract({ address: loanToken as Address, abi: ERC20_DECIMALS_ABI as any, functionName: 'decimals' }) as Promise<number>),
        withTimeout(publicClient.readContract({ address: collateralToken as Address, abi: ERC20_DECIMALS_ABI as any, functionName: 'decimals' }) as Promise<number>),
      ]);
    } catch (e: any) {
      // Best-effort decimals; keep defaults
    }
  }

  return c.json(replaceBigInts({ loanToken, collateralToken, lltv, totalBorrowAssets, totalBorrowShares, loanDec, collDec }));
});

// Last transmission for an oracle aggregator
app.get("/oracles/:chainId/:oracle/lastTransmission", async (c) => {
  const { chainId: chainIdRaw, oracle } = c.req.param();
  const chainId = Number.parseInt(chainIdRaw, 10);
  const rows = await db
    .select({
      oracleAddr: schema.oracleTransmission.oracleAddr,
      roundId: schema.oracleTransmission.roundId,
      answerRaw: schema.oracleTransmission.answerRaw,
      ts: schema.oracleTransmission.ts,
      blockNumber: schema.oracleTransmission.blockNumber,
      txHash: schema.oracleTransmission.txHash,
    })
    .from(schema.oracleTransmission)
    .where(and(eq(schema.oracleTransmission.chainId, chainId), eq(schema.oracleTransmission.oracleAddr, oracle as Address)))
    .orderBy(desc(schema.oracleTransmission.blockNumber))
    .limit(1);
  if (rows.length === 0) return c.json({ found: false });
  return c.json(replaceBigInts({ found: true, ...rows[0] }));
});

// Recent liquidations for a chain (optional window & limit)
app.get("/chain/:chainId/liquidations/recent", async (c) => {
  const { chainId: chainIdRaw } = c.req.param();
  const url = new URL(c.req.url);
  const hours = Number(url.searchParams.get("hours") ?? "24");
  const limit = Number(url.searchParams.get("limit") ?? "200");
  const chainId = Number.parseInt(chainIdRaw, 10);

  const since = BigInt(Math.floor(Date.now() / 1000) - Math.max(1, hours) * 3600);
  const rows = await db
    .select({
      marketId: schema.liquidation.marketId,
      borrower: schema.liquidation.borrower,
      liquidator: schema.liquidation.liquidator,
      repaidAssets: schema.liquidation.repaidAssets,
      repaidShares: schema.liquidation.repaidShares,
      seizedAssets: schema.liquidation.seizedAssets,
      badDebtAssets: schema.liquidation.badDebtAssets,
      badDebtShares: schema.liquidation.badDebtShares,
      txHash: schema.liquidation.txHash,
      ts: schema.liquidation.ts,
      blockNumber: schema.liquidation.blockNumber,
    })
    .from(schema.liquidation)
    .where(and(eq(schema.liquidation.chainId, chainId), gte(schema.liquidation.ts, since)))
    .orderBy(desc(schema.liquidation.ts))
    .limit(Math.max(1, Math.min(1000, isNaN(limit) ? 200 : limit)));

  return c.json(replaceBigInts({ items: rows }));
});

// Liquidation summary: total / ours / missed in window
app.get("/chain/:chainId/liquidations/summary", async (c) => {
  const { chainId: chainIdRaw } = c.req.param();
  const url = new URL(c.req.url);
  const hours = Number(url.searchParams.get("hours") ?? "24");
  const chainId = Number.parseInt(chainIdRaw, 10);

  // Collect our liquidator addresses from env
  const ours = new Set<string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (/(FLASH_LIQUIDATOR_ADDRESS|LIQUIDATOR_ADDRESS|LIQUIDATOR_ADDRESSES|EXECUTOR_ADDRESS)/.test(k)) {
      if (k.endsWith(`_${chainId}`) || !/_\d+$/.test(k)) {
        v.split(',').forEach((a) => {
          const addr = a.trim();
          if (addr) ours.add(addr.toLowerCase());
        });
      }
    }
  }

  const since = BigInt(Math.floor(Date.now() / 1000) - Math.max(1, hours) * 3600);
  const rows = await db
    .select({
      marketId: schema.liquidation.marketId,
      borrower: schema.liquidation.borrower,
      liquidator: schema.liquidation.liquidator,
      ts: schema.liquidation.ts,
    })
    .from(schema.liquidation)
    .where(and(eq(schema.liquidation.chainId, chainId), gte(schema.liquidation.ts, since)));

  const total = rows.length;
  const oursCount = rows.filter((r) => ours.has((r.liquidator as string).toLowerCase())).length;
  const missed = total - oursCount;
  const uniqueBorrowers = new Set(rows.map((r) => (r.borrower as string).toLowerCase())).size;
  const uniqueMarkets = new Set(rows.map((r) => (r.marketId as string).toLowerCase())).size;

  return c.json({
    chainId,
    hours,
    total,
    ours: oursCount,
    missed,
    uniqueBorrowers,
    uniqueMarkets,
    ourLiquidators: Array.from(ours),
  });
});

export default app;
