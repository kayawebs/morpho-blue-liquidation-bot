import './env.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadSchedulerConfig } from './config.js';
import { createPublicClient, http, getAbiItem } from 'viem';
import WebSocket, { WebSocketServer } from 'ws';

type RoundEvt = { roundId: number; ts: number; answer: number; block: bigint };
type FeedKey = string; // `${chainId}:${aggregator.toLowerCase()}`

const state: Record<FeedKey, { events: RoundEvt[]; decimals: number; lastAnalyzedCount: number; profiles?: any }> = {};
const subs: Record<FeedKey, Set<WebSocket>> = {};
const lastNext: Record<FeedKey, string> = {};

const PREDICTOR_URL = process.env.PREDICTOR_URL ?? 'http://localhost:48080';

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
  // Heartbeat stats
  const gaps: number[] = [];
  const jitters: number[] = [];
  for (let i = 1; i < evts.length; i++) {
    const g = evts[i]!.ts - evts[i - 1]!.ts;
    gaps.push(g);
    jitters.push(g - heartbeat);
  }
  const gapQ = quantiles(gaps, [0.1, 0.5, 0.9]);
  const jitQ = quantiles(jitters, [0.1, 0.5, 0.9]);

  // Deviation lead stats (post-cross approximation)
  // For last M events, search backward from t_k to find earliest s where |pred(s)-a_prev|/a_prev >= offset
  const leads: number[] = [];
  const M = Math.min(30, evts.length - 1);
  for (let idx = evts.length - M; idx < evts.length; idx++) {
    if (idx <= 0) continue;
    const cur = evts[idx]!;
    const prev = evts[idx - 1]!;
    const aPrev = prev.answer;
    if (!(aPrev > 0)) continue;
    const maxBack = 120; // seconds
    let sIn: number | undefined;
    // backward search with 1s step
    for (let s = cur.ts; s >= cur.ts - maxBack; s -= 1) {
      const pred = await fetchPredictedAt(chainId, agg, s, lagSeconds);
      if (!(pred && pred > 0)) continue;
      const deltaBps = Math.abs(pred - aPrev) / aPrev * 10_000;
      if (deltaBps >= offsetBps) {
        // Optional consecutive confirmation: check s+1,s+2 also >= offset
        const p1 = await fetchPredictedAt(chainId, agg, s + 1, lagSeconds);
        const p2 = await fetchPredictedAt(chainId, agg, s + 2, lagSeconds);
        const ok1 = p1 && Math.abs(p1 - aPrev) / aPrev * 10_000 >= offsetBps;
        const ok2 = p2 && Math.abs(p2 - aPrev) / aPrev * 10_000 >= offsetBps;
        if (ok1 && ok2) { sIn = s; break; }
      }
    }
    if (sIn !== undefined) leads.push(cur.ts - sIn);
  }
  const leadQ = quantiles(leads, [0.1, 0.5, 0.9]);
  st.profiles = {
    heartbeat: { gap: { p10: gapQ[0.1], p50: gapQ[0.5], p90: gapQ[0.9] }, jitter: { p10: jitQ[0.1], p50: jitQ[0.5], p90: jitQ[0.9] } },
    deviation: { leadSec: { p10: leadQ[0.1], p50: leadQ[0.5], p90: leadQ[0.9] } },
    updatedAt: Math.floor(Date.now()/1000)
  };
}

async function fetchNextWindow(chainId: number, agg: string, heartbeat: number, offsetBps: number, lagSeconds: number) {
  const key: FeedKey = `${chainId}:${agg.toLowerCase()}`;
  const st = state[key];
  if (!st || !st.profiles || st.events.length === 0) return undefined;
  const last = st.events[st.events.length - 1]!;
  // Heartbeat window using jitter p10/p90
  const jit = st.profiles.heartbeat.jitter;
  const hbStart = last.ts + heartbeat + (jit.p10 ?? 0);
  const hbEnd = last.ts + heartbeat + (jit.p90 ?? 0);
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
      const lead = st.profiles.deviation.leadSec;
      devWin = { start: t1, end: t2 + (lead.p50 ?? 3), state: 'forecast', deltaBps: dNow, shotsMs };
    }
  }
  return { heartbeat: { start: hbStart, end: hbEnd }, deviation: devWin };
}

async function main() {
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
      const key: FeedKey = `${chainId}:${oracle}`;
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
    const key: FeedKey = `${f.chainId}:${f.aggregator.toLowerCase()}`;
    const meta = await getOracleMeta(f.chainId, f.aggregator);
    const decimals = meta?.decimals ?? 8;
    state[key] = { events: [], decimals, lastAnalyzedCount: 0 };
    const rpc = process.env[`RPC_URL_${f.chainId}`];
    if (!rpc) {
      console.warn(`No RPC_URL_${f.chainId} in env; feed ${key} watcher disabled`);
      continue;
    }
    const client = createPublicClient({ transport: http(rpc as any) });
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
          const arr = state[key].events;
          if (!arr.some((e) => e.block === l.blockNumber)) {
            arr.push({ roundId, ts: tsSec, answer, block: l.blockNumber });
            if (arr.length > 2048) arr.splice(0, arr.length - 2048);
          }
        }
        // Analyze if new events arrived
        const stt = state[key];
        const meta2 = await getOracleMeta(f.chainId, f.aggregator);
        if (stt.events.length > stt.lastAnalyzedCount && meta2) {
          await analyzeProfiles(f.chainId, f.aggregator, meta2.heartbeatSeconds, meta2.offsetBps, meta2.lagSeconds);
          // After analysis, compute next window & broadcast if changed
          const next = await fetchNextWindow(f.chainId, f.aggregator, meta2.heartbeatSeconds, meta2.offsetBps, meta2.lagSeconds);
          if (next) {
            const key = `${f.chainId}:${f.aggregator.toLowerCase()}`;
            const payload = JSON.stringify({ type: 'update', feed: key, ts: Math.floor(Date.now()/1000), data: next });
            if (lastNext[key] !== payload) {
              lastNext[key] = payload;
              const set = subs[key];
              if (set && set.size > 0) {
                for (const sock of set) {
                  try { sock.send(payload); } catch {}
                }
              }
            }
          }
          stt.lastAnalyzedCount = stt.events.length;
        }
      } catch (e) {
        console.warn(`Watcher error for ${key}:`, (e as any)?.message ?? e);
      }
      setTimeout(poll, 15_000);
    };
    void poll();
    console.log(`⏱ Started watcher for ${key}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
