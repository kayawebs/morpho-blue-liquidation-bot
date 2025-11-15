import './env.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadSchedulerConfig } from './config.js';
import { createPublicClient, http, webSocket, getAbiItem } from 'viem';
import WebSocket, { WebSocketServer } from 'ws';
import { initSchedulerSchema, insertOutliers, insertWindows } from './db.js';

type RoundEvt = { roundId: number; ts: number; answer: number; block: bigint; txHash?: string };
type FeedKey = string; // `${chainId}:${aggregator.toLowerCase()}`

const state: Record<FeedKey, { events: RoundEvt[]; decimals: number; lastAnalyzedCount: number; profiles?: any }> = {};
const subs: Record<FeedKey, Set<WebSocket>> = {};
const lastNext: Record<FeedKey, string> = {};

const PREDICTOR_URL = process.env.PREDICTOR_URL ?? 'http://localhost:48080';
const BOOT_LOOKBACK_BLOCKS = BigInt(process.env.SCHED_BOOT_LOOKBACK_BLOCKS ?? '48000');
const BOOT_CHUNK_BLOCKS = BigInt(process.env.SCHED_BOOT_CHUNK_BLOCKS ?? '4000');
const REFRESH_INTERVAL_MS = Number(process.env.SCHED_REFRESH_INTERVAL ?? 3000);
const HEARTBEAT_SLACK = Number(process.env.SCHED_HEARTBEAT_SLACK ?? 90);

function makeFeedKey(chainId: number, agg: string): FeedKey {
  return `${chainId}:${agg.toLowerCase()}`;
}

async function getOracleMeta(chainId: number, agg: string): Promise<{ decimals: number; lagSeconds: number; offsetBps: number; heartbeatSeconds: number } | undefined> {
  try {
    const res = await fetch(new URL('/oracles', PREDICTOR_URL));
    if (!res.ok) return undefined;
    const rows = await res.json() as any[];
    const row = rows.find((r) => Number(r.chain_id) === chainId && String(r.oracle_addr).toLowerCase() === agg.toLowerCase());
    if (!row) return undefined;
    return { decimals: Number(row.decimals), lagSeconds: Number(row.lag_seconds ?? 0), offsetBps: Number(row.offset_bps), heartbeatSeconds: Number(row.heartbeat_seconds) };
  } catch {
    return undefined;
  }
}

async function getFitSummary(chainId: number, agg: string): Promise<{ p50AbsBps: number; p90AbsBps: number; biasBps: number } | undefined> {
  try {
    const url = new URL(`/oracles/${chainId}/${agg}/fitSummary`, PREDICTOR_URL);
    url.searchParams.set('limit', '120');
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const data = await res.json();
    return { p50AbsBps: Number(data?.p50AbsBps ?? 0), p90AbsBps: Number(data?.p90AbsBps ?? 0), biasBps: Number(data?.biasMedianBps ?? 0) };
  } catch { return undefined; }
}

async function fetchPredictedAt(chainId: number, agg: string, tsSec: number, lagSec: number): Promise<number | undefined> {
  try {
    const url = new URL(`/oracles/${chainId}/${agg}/predictionAt`, PREDICTOR_URL);
    url.searchParams.set('ts', String(tsSec));
    if (lagSec) url.searchParams.set('lag', String(lagSec));
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const data = await res.json();
    return Number(data?.answer);
  } catch {
    return undefined;
  }
}

async function fetchPredictedAtMs(chainId: number, agg: string, tsMs: number, lagMs: number): Promise<number | undefined> {
  try {
    const url = new URL(`/oracles/${chainId}/${agg}/predictionAt`, PREDICTOR_URL);
    url.searchParams.set('tsMs', String(Math.floor(tsMs)));
    if (Number.isFinite(lagMs) && lagMs > 0) url.searchParams.set('lagMs', String(Math.floor(lagMs)));
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const data = await res.json();
    return Number(data?.answer);
  } catch {
    return undefined;
  }
}

function quantiles(nums: number[], qs: number[]) {
  if (nums.length === 0) return Object.fromEntries(qs.map((q) => [q, undefined]));
  const arr = [...nums].sort((a, b) => a - b);
  const res: Record<number, number> = {} as any;
  for (const q of qs) {
    const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * q)));
    res[q] = arr[idx]!;
  }
  return res;
}

async function analyzeProfiles(chainId: number, agg: string, heartbeat: number, offsetBps: number, lagSeconds: number) {
  const key: FeedKey = `${chainId}:${agg.toLowerCase()}`;
  const st = state[key];
  if (!st) return;
  const evts = st.events;
  if (evts.length < 5) return;
  // Classify gaps into heartbeat vs deviation-triggered
  const hbGaps: number[] = [];
  const hbJitters: number[] = [];
  const devIndices: number[] = [];
  const outliers: {
    roundId: number;
    txHash?: string;
    ts: number;
    gap: number;
    deltaBps: number;
    reason: string;
    prevRoundId: number;
  }[] = [];
  const hbSlack = HEARTBEAT_SLACK;

  for (let i = 1; i < evts.length; i++) {
    const prev = evts[i - 1]!;
    const cur = evts[i]!;
    const gap = cur.ts - prev.ts;
    if (!(prev.answer > 0) || !(cur.answer > 0)) {
      outliers.push({
        roundId: cur.roundId,
        txHash: cur.txHash,
        ts: cur.ts,
        gap,
        deltaBps: 0,
        reason: 'invalid_answer',
        prevRoundId: prev.roundId,
      });
      continue;
    }
    const deltaBps = Math.abs(cur.answer - prev.answer) / prev.answer * 10_000;
    if (deltaBps >= offsetBps) {
      devIndices.push(i);
      continue;
    }
    if (gap < 0) {
      outliers.push({
        roundId: cur.roundId,
        txHash: cur.txHash,
        ts: cur.ts,
        gap,
        deltaBps,
        reason: 'negative_gap',
        prevRoundId: prev.roundId,
      });
      continue;
    }
    const withinHeartbeat = Math.abs(gap - heartbeat) <= hbSlack;
    if (withinHeartbeat) {
      hbGaps.push(gap);
      hbJitters.push(gap - heartbeat);
    } else {
      outliers.push({
        roundId: cur.roundId,
        txHash: cur.txHash,
        ts: cur.ts,
        gap,
        deltaBps,
        reason: 'ambiguous_gap',
        prevRoundId: prev.roundId,
      });
    }
  }

  const gapQ = quantiles(hbGaps, [0.1, 0.5, 0.9]);
  const jitQ = quantiles(hbJitters, [0.1, 0.5, 0.9]);

  if (outliers.length > 0) {
    try {
      await insertOutliers(
        outliers.map((o) => ({
          chainId,
          oracleAddr: agg,
          roundId: o.roundId,
          reason: o.reason,
          txHash: o.txHash,
          ts: o.ts,
          gapSeconds: o.gap,
          deltaBps: o.deltaBps,
          details: {
            prevRoundId: o.prevRoundId,
            heartbeat,
            slack: hbSlack,
          },
        })),
      );
    } catch (e) {
      console.warn(
        `outlier insert failed for ${chainId}:${agg.toLowerCase()}`,
        (e as any)?.message ?? e,
      );
    }
  }

  // Deviation lead stats (post-cross approximation) using deviation samples only
  const leads: number[] = [];
  const devSampleCount = devIndices.length;
  const indicesToCheck = devIndices.slice(-Math.min(30, devSampleCount));
  const lagMs = Number.isFinite(lagSeconds) ? Math.max(0, lagSeconds * 1000) : 0;
  for (const idx of indicesToCheck) {
    if (idx <= 0) continue;
    const cur = evts[idx]!;
    const prev = evts[idx - 1]!;
    const aPrev = prev.answer;
    if (!(aPrev > 0)) continue;
    const maxBackMs = 120_000;
    const curMs = cur.ts * 1000;
    let sInMs: number | undefined;
    for (let sMs = curMs; sMs >= curMs - maxBackMs; sMs -= 100) {
      const pred = await fetchPredictedAtMs(chainId, agg, sMs, lagMs);
      if (!(pred && pred > 0)) continue;
      const deltaBps = Math.abs(pred - aPrev) / aPrev * 10_000;
      if (deltaBps >= offsetBps) {
        const p1 = await fetchPredictedAtMs(chainId, agg, sMs + 100, lagMs);
        const p2 = await fetchPredictedAtMs(chainId, agg, sMs + 200, lagMs);
        const ok1 = p1 && Math.abs(p1 - aPrev) / aPrev * 10_000 >= offsetBps;
        const ok2 = p2 && Math.abs(p2 - aPrev) / aPrev * 10_000 >= offsetBps;
        if (ok1 && ok2) { sInMs = sMs; break; }
      }
    }
    if (sInMs !== undefined) leads.push((curMs - sInMs) / 1000);
  }
  const leadQ = quantiles(leads, [0.1, 0.5, 0.9]);
  st.profiles = {
    heartbeat: {
      samples: hbGaps.length,
      gap: { p10: gapQ[0.1], p50: gapQ[0.5], p90: gapQ[0.9] },
      jitter: { p10: jitQ[0.1], p50: jitQ[0.5], p90: jitQ[0.9] },
    },
    deviation: {
      samples: leads.length,
      leadSec: { p10: leadQ[0.1], p50: leadQ[0.5], p90: leadQ[0.9] },
    },
    outliers: {
      samples: outliers.length,
    },
    updatedAt: Math.floor(Date.now()/1000)
  };
}

async function fetchNextWindow(chainId: number, agg: string, heartbeat: number, offsetBps: number, lagSeconds: number) {
  const key = makeFeedKey(chainId, agg);
  const st = state[key];
  if (!st || !st.profiles || st.events.length === 0) return undefined;
  const last = st.events[st.events.length - 1]!;
  // Heartbeat window using jitter p10/p90
  const jit = st.profiles.heartbeat?.jitter ?? {};
  const hbJitterStart = typeof jit.p10 === 'number' && Number.isFinite(jit.p10) ? jit.p10 : -HEARTBEAT_SLACK;
  const hbJitterEnd = typeof jit.p90 === 'number' && Number.isFinite(jit.p90) ? jit.p90 : HEARTBEAT_SLACK;
  const hbStart = last.ts + heartbeat + hbJitterStart;
  const hbEnd = last.ts + heartbeat + hbJitterEnd;
  // Deviation window + aggressive shots plan
  const fit = await getFitSummary(chainId, agg);
  const p90 = Math.max(0, Math.min(offsetBps, Number(fit?.p90AbsBps ?? 5)));
  const p50 = Math.max(0, Math.min(offsetBps, Number(fit?.p50AbsBps ?? 3)));
  const T1 = Math.max(1, offsetBps - p90);
  const T2 = Math.max(1, offsetBps - p50);
  const T3 = Math.max(1, offsetBps - 1);

  const nowSec = Math.floor(Date.now()/1000);
  const predNow = await fetchPredictedAt(chainId, agg, nowSec, lagSeconds);
  const predPrev = await fetchPredictedAt(chainId, agg, nowSec - 1, lagSeconds);
  const aPrev = last.answer;
  let devWin: any = undefined;
  if (predNow && predPrev && aPrev > 0) {
    const dNow = Math.abs(predNow - aPrev)/aPrev*10_000;
    const dPrev = Math.abs(predPrev - aPrev)/aPrev*10_000;
    const v = Math.max(0, dNow - dPrev); // bps/s approx
    const vMin = 0.5;
    const tau = (rem: number) => rem / Math.max(v, vMin);
    const shotsMs: number[] = [];
    const nowMs = Date.now();
    if (dNow >= T3) {
      for (const dt of [-20, 20, 60]) { const t = nowMs + dt; if (t > nowMs) shotsMs.push(t); }
      devWin = { start: nowSec - 1, end: nowSec + 3, state: 'commit', deltaBps: dNow, shotsMs };
    } else if (dNow >= T2) {
      for (const dt of [20, 60, 100]) shotsMs.push(nowMs + dt);
      devWin = { start: nowSec, end: nowSec + 5, state: 'boost', deltaBps: dNow, shotsMs };
    } else if (dNow >= T1) {
      for (const dt of [60, 120]) shotsMs.push(nowMs + dt);
      devWin = { start: nowSec, end: nowSec + 10, state: 'prewarm', deltaBps: dNow, shotsMs };
    } else {
      const rem1 = Math.max(0, T1 - dNow);
      const rem2 = Math.max(0, T2 - dNow);
      const t1 = nowSec + Math.round(tau(rem1));
      const t2 = nowSec + Math.round(tau(rem2));
      const lead = st.profiles.deviation?.leadSec ?? {};
      devWin = { start: t1, end: t2 + (lead.p50 ?? 3), state: 'forecast', deltaBps: dNow, shotsMs };
    }
  }
  return { heartbeat: { start: hbStart, end: hbEnd }, deviation: devWin };
}

async function broadcastNextWindow(feed: { chainId: number; aggregator: string }, heartbeat: number, offsetBps: number, lagSeconds: number) {
  const next = await fetchNextWindow(feed.chainId, feed.aggregator, heartbeat, offsetBps, lagSeconds);
  if (!next) return;
  const key = makeFeedKey(feed.chainId, feed.aggregator);
  const payload = JSON.stringify({ type: 'update', feed: key, ts: Math.floor(Date.now() / 1000), data: next });
  if (lastNext[key] === payload) return;
  lastNext[key] = payload;
  // Persist windows snapshot for later evaluation
  try {
    const rows: any[] = [];
    if (next.heartbeat && Number.isFinite(next.heartbeat.start) && Number.isFinite(next.heartbeat.end)) {
      rows.push({
        chainId: feed.chainId,
        oracleAddr: feed.aggregator,
        kind: 'heartbeat',
        startTs: Math.floor(next.heartbeat.start),
        endTs: Math.floor(next.heartbeat.end),
        state: null,
        deltaBps: null,
        shotsMs: null,
        params: { heartbeatSeconds: heartbeat, offsetBps, lagSeconds },
      });
    }
    if (next.deviation && Number.isFinite(next.deviation.start) && Number.isFinite(next.deviation.end)) {
      rows.push({
        chainId: feed.chainId,
        oracleAddr: feed.aggregator,
        kind: 'deviation',
        startTs: Math.floor(next.deviation.start),
        endTs: Math.floor(next.deviation.end),
        state: next.deviation.state ?? null,
        deltaBps: Number.isFinite(next.deviation.deltaBps) ? Number(next.deviation.deltaBps) : null,
        shotsMs: Array.isArray(next.deviation.shotsMs) ? next.deviation.shotsMs : null,
        params: { heartbeatSeconds: heartbeat, offsetBps, lagSeconds },
      });
    }
    if (rows.length > 0) await insertWindows(rows);
  } catch (e) {
    console.warn('persist windows failed:', (e as any)?.message ?? e);
  }
  const listeners = subs[key];
  if (!listeners || listeners.size === 0) return;
  for (const ws of listeners) {
    try { ws.send(payload); } catch {}
  }
}

async function bootstrapFeed(client: ReturnType<typeof createPublicClient>, evt: any, feed: { chainId: number; aggregator: string }, decimals: number) {
  try {
    console.log(`⏳ bootstrap start for ${feed.chainId}:${feed.aggregator}`);
    const head = await client.getBlockNumber();
    const from = head > BOOT_LOOKBACK_BLOCKS ? head - BOOT_LOOKBACK_BLOCKS : 0n;
    const chunk = BOOT_CHUNK_BLOCKS > 0n ? BOOT_CHUNK_BLOCKS : 4000n;
    const evts: RoundEvt[] = [];
    let cursor = from;
    let fetched = 0;
    while (cursor <= head) {
      const to = cursor + chunk - 1n > head ? head : cursor + chunk - 1n;
      const logs = await client.getLogs({ address: feed.aggregator as `0x${string}`, event: evt, fromBlock: cursor, toBlock: to } as any);
      fetched += logs.length;
      if (logs.length > 0) {
        for (const l of logs as any[]) {
          const blk = await client.getBlock({ blockNumber: l.blockNumber });
          const tsSec = Number(blk.timestamp);
          const roundId = Number(l.args.aggregatorRoundId);
          const answer = Number(l.args.answer) / 10 ** decimals;
          const txHash = l.transactionHash ? String(l.transactionHash) : undefined;
          evts.push({ roundId, ts: tsSec, answer, block: l.blockNumber, txHash });
        }
      }
      console.log(`  ↳ chunk ${cursor.toString()}-${to.toString()} logs=${logs.length}`);
      cursor = to + 1n;
    }
    if (evts.length === 0) {
      console.warn(`⚠️ bootstrap found no transmissions for ${feed.chainId}:${feed.aggregator}`);
      return undefined;
    }
    evts.sort((a, b) => a.ts - b.ts);
    const key = makeFeedKey(feed.chainId, feed.aggregator);
    if (evts.length > 2048) evts.splice(0, evts.length - 2048);
    state[key].events = evts;
    console.log(`✅ bootstrap done for ${feed.chainId}:${feed.aggregator} events=${evts.length} fetched=${fetched} from=${from.toString()} head=${head.toString()}`);
    return evts.length > 0 ? evts[evts.length - 1]!.block : undefined;
  } catch (e) {
    console.warn(`bootstrap failed for ${feed.chainId}:${feed.aggregator}`, (e as any)?.message ?? e);
    return undefined;
  }
}

async function main() {
  await initSchedulerSchema();
  const cfg = loadSchedulerConfig();
  const app = new Hono();
  app.get('/health', (c) => c.text('ok'));
  app.get('/feeds', (c) => c.json(cfg.feeds));
  app.get('/timing/profile/:chainId/:oracle', (c) => {
    const chainId = Number(c.req.param('chainId'));
    const oracle = c.req.param('oracle');
    const key = `${chainId}:${oracle.toLowerCase()}`;
    const st = state[key];
    if (!st?.profiles) return c.json({ error: 'no profile' }, 404);
    return c.json(st.profiles);
  });
  app.get('/timing/next/:chainId/:oracle', async (c) => {
    const chainId = Number(c.req.param('chainId'));
    const oracle = c.req.param('oracle');
    const meta = await getOracleMeta(chainId, oracle);
    if (!meta) return c.json({ error: 'no oracle meta' }, 404);
    const next = await fetchNextWindow(chainId, oracle, meta.heartbeatSeconds, meta.offsetBps, meta.lagSeconds);
    if (!next) return c.json({ error: 'no data' }, 404);
    return c.json(next);
  });
  const port = 48200;
  serve({ fetch: app.fetch, port });
  console.log(`🔔 Oracle Scheduler stub listening on :${port}`);
  console.log(`Feeds loaded: ${cfg.feeds.length}`);

  // WebSocket push server (separate port)
  const WS_PORT = 48201;
  const wss = new WebSocketServer({ port: WS_PORT });
  wss.on('connection', (ws, req) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws/schedule') { ws.close(); return; }
      const chainId = Number(url.searchParams.get('chainId'));
      const oracle = String(url.searchParams.get('oracle') ?? '').toLowerCase();
      if (!Number.isFinite(chainId) || !oracle) { ws.close(); return; }
      const key = makeFeedKey(chainId, oracle);
      if (!subs[key]) subs[key] = new Set();
      subs[key]!.add(ws);
      ws.on('close', () => { subs[key]!.delete(ws); });
      ws.on('error', () => { try { ws.close(); } catch {} });
      // Send immediate snapshot if available
      (async () => {
        const meta = await getOracleMeta(chainId, oracle);
        if (!meta) return;
        const next = await fetchNextWindow(chainId, oracle, meta.heartbeatSeconds, meta.offsetBps, meta.lagSeconds);
        if (next) {
          ws.send(JSON.stringify({ type: 'snapshot', feed: key, ts: Math.floor(Date.now()/1000), data: next }));
        }
      })();
    } catch {
      try { ws.close(); } catch {}
    }
  });
  console.log(`📡 WS push on :${WS_PORT} at path /ws/schedule?chainId=&oracle=`);

  // Start watchers per feed
  for (const f of cfg.feeds) {
    const key = makeFeedKey(f.chainId, f.aggregator);
    const meta = await getOracleMeta(f.chainId, f.aggregator);
    const decimals = meta?.decimals ?? 8;
    state[key] = { events: [], decimals, lastAnalyzedCount: 0 };
    const httpRpc = process.env[`RPC_URL_${f.chainId}`];
    const wsRpc = process.env[`WS_RPC_URL_${f.chainId}`];
    if (!httpRpc && !wsRpc) {
      console.warn(`No RPC_URL_${f.chainId} or WS_RPC_URL_${f.chainId} in env; feed ${key} watcher disabled`);
      continue;
    }
    if (wsRpc) console.log(`🔌 feed ${key}: using WS ${wsRpc}`);
    else console.log(`🔌 feed ${key}: using HTTP ${httpRpc}`);
    const transport = wsRpc
      ? webSocket(wsRpc as any, { retryDelay: 1000, retryCount: Infinity })
      : http(httpRpc as any);
    const client = createPublicClient({ transport });
    const evt = getAbiItem({
      abi: [
        { type: 'event', name: 'NewTransmission', inputs: [
          { indexed: true, name: 'aggregatorRoundId', type: 'uint32' },
          { indexed: false, name: 'answer', type: 'int192' },
          { indexed: false, name: 'transmitter', type: 'address' },
          { indexed: false, name: 'observations', type: 'int192[]' },
          { indexed: false, name: 'observers', type: 'bytes' },
          { indexed: false, name: 'rawReportContext', type: 'bytes32' }
        ]}
      ],
      name: 'NewTransmission'
    }) as any;
    let lastBlock: bigint | undefined;

    const bootBlock = await bootstrapFeed(client, evt, f, decimals);
    if (bootBlock) lastBlock = bootBlock;
    const initHb = meta?.heartbeatSeconds ?? f.heartbeatSeconds;
    const initOffset = meta?.offsetBps ?? f.deviationBps;
    const initLag = meta?.lagSeconds ?? 0;
    if (state[key].events.length > 0) {
      await analyzeProfiles(f.chainId, f.aggregator, initHb, initOffset, initLag);
      state[key].lastAnalyzedCount = state[key].events.length;
      await broadcastNextWindow(f, initHb, initOffset, initLag);
    }
    const poll = async () => {
      try {
        const head = await client.getBlockNumber();
        const from = lastBlock ? (lastBlock + 1n) : (head > 2000n ? head - 2000n : 0n);
        const logs = await client.getLogs({ address: f.aggregator as `0x${string}`, event: evt, fromBlock: from, toBlock: head } as any);
        for (const l of logs as any[]) {
          lastBlock = l.blockNumber as bigint;
          const blk = await client.getBlock({ blockNumber: l.blockNumber });
          const tsSec = Number(blk.timestamp);
          const roundId = Number(l.args.aggregatorRoundId);
          const answer = Number(l.args.answer) / 10 ** decimals;
          const txHash = l.transactionHash ? String(l.transactionHash) : undefined;
          const arr = state[key].events;
          if (!arr.some((e) => e.block === l.blockNumber && e.roundId === roundId)) {
            arr.push({ roundId, ts: tsSec, answer, block: l.blockNumber, txHash });
            if (arr.length > 2048) arr.splice(0, arr.length - 2048);
          }
        }
        // Analyze if new events arrived
        const stt = state[key];
        const meta2 = await getOracleMeta(f.chainId, f.aggregator);
        const hb = meta2?.heartbeatSeconds ?? f.heartbeatSeconds;
        const offset = meta2?.offsetBps ?? f.deviationBps;
        const lag = meta2?.lagSeconds ?? 0;
        if (stt.events.length > stt.lastAnalyzedCount) {
          console.log(`📈 analyze ${key}: newEvents=${stt.events.length - stt.lastAnalyzedCount}`);
          await analyzeProfiles(f.chainId, f.aggregator, hb, offset, lag);
          stt.lastAnalyzedCount = stt.events.length;
          await broadcastNextWindow(f, hb, offset, lag);
        }
      } catch (e) {
        console.warn(`Watcher error for ${key}:`, (e as any)?.message ?? e);
      }
      setTimeout(poll, 15_000);
    };
    void poll();
    console.log(`⏱ Started watcher for ${key}`);

    setInterval(() => {
      (async () => {
        const metaCur = await getOracleMeta(f.chainId, f.aggregator);
        const hb = metaCur?.heartbeatSeconds ?? f.heartbeatSeconds;
        const offset = metaCur?.offsetBps ?? f.deviationBps;
        const lag = metaCur?.lagSeconds ?? 0;
        await broadcastNextWindow(f, hb, offset, lag);
      })().catch((e) => {
        console.warn(`refresh error for ${key}:`, (e as any)?.message ?? e);
      });
    }, REFRESH_INTERVAL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
