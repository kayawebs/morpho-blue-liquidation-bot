import { createPublicClient, getAbiItem, http } from 'viem';
import { pool } from './db.js';
import { loadConfig } from './config.js';
import { buildAdapter } from './oracleAdapters.js';

type Sample = { ts: number; block: bigint; tx: string; onchain: number };

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function priceAt100ms(symbol: string, tsMs: number): Promise<number | undefined> {
  const { rows } = await pool.query(
    `SELECT price FROM cex_agg_100ms WHERE symbol=$1 AND ts_ms <= $2 ORDER BY ts_ms DESC LIMIT 1`,
    [symbol, Math.floor(tsMs)],
  );
  if (rows.length > 0) return Number(rows[0].price);
  const { rows: rows2 } = await pool.query(
    `SELECT price FROM cex_agg_100ms WHERE symbol=$1 AND ts_ms BETWEEN $2 AND $3 ORDER BY ABS(ts_ms - $2) ASC LIMIT 1`,
    [symbol, Math.floor(tsMs), Math.floor(tsMs + 300)],
  );
  if (rows2.length > 0) return Number(rows2[0].price);
  return undefined;
}

function percentiles(nums: number[], qs: number[]) {
  if (nums.length === 0) return Object.fromEntries(qs.map((q) => [q, undefined]));
  const arr = [...nums].sort((a, b) => a - b);
  const res: Record<number, number> = {} as any;
  for (const q of qs) {
    const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * q)));
    res[q] = arr[idx]!;
  }
  return res;
}

function genLagsMs(maxMs = 3000, stepMs = 100) {
  const out: number[] = [];
  for (let ms = 0; ms <= maxMs; ms += stepMs) out.push(ms);
  return out;
}

function genWeightGrids(keys: string[], step = 0.1) {
  if (keys.length === 1) return [{ [keys[0]!]: 1 } as Record<string, number>];
  const out: Record<string, number>[] = [];
  const recurse = (i: number, remain: number, cur: number[]) => {
    if (i === keys.length - 1) {
      const obj: Record<string, number> = {};
      for (let k = 0; k < keys.length; k++) obj[keys[k]!] = k === keys.length - 1 ? remain : cur[k]!;
      out.push(obj);
      return;
    }
    for (let w = 0; w <= remain + 1e-9; w = +(w + step).toFixed(10)) {
      cur[i] = w;
      recurse(i + 1, +(remain - w).toFixed(10), cur);
    }
  };
  recurse(0, 1, Array(keys.length).fill(0));
  return out.filter((w) => Object.values(w).some((x) => x > 0));
}

export async function runStartupFit() {
  const cfg = loadConfig();
  const oracles: any[] = (cfg as any).oracles ?? [];
  if (oracles.length === 0) return;
  // fit each oracle sequentially to avoid excessive RPC/DB load
  for (const o of oracles) {
    try {
      const chainId = Number(o.chainId);
      const rpcUrl = cfg.rpc[String(chainId)];
      if (!rpcUrl) continue;
      const addr = String(o.address);
      const decimals = Number(o.decimals ?? 8);
      const symbol = String(o.symbol ?? 'BTCUSDC');
      const client = createPublicClient({ transport: http(rpcUrl) });
      // Fetch recent events (bounded)
      const evt = getAbiItem({
        abi: [{ type: 'event', name: 'NewTransmission', inputs: [
          { indexed: true, name: 'aggregatorRoundId', type: 'uint32' },
          { indexed: false, name: 'answer', type: 'int192' },
          { indexed: false, name: 'transmitter', type: 'address' },
          { indexed: false, name: 'observations', type: 'int192[]' },
          { indexed: false, name: 'observers', type: 'bytes' },
          { indexed: false, name: 'rawReportContext', type: 'bytes32' },
        ]}], name: 'NewTransmission',
      }) as any;
      const head = await client.getBlockNumber();
      const fromBlock = head > 10_000n ? head - 10_000n : 0n;
      const logs = await client.getLogs({ address: addr as `0x${string}`, event: evt, fromBlock, toBlock: head } as any);
      // downsample to last 60 events to limit DB queries
      const sel = (logs as any[]).slice(-60);
      const samples: Sample[] = [];
      for (const l of sel) {
        const blk = await client.getBlock({ blockNumber: l.blockNumber });
        const ts = Number(blk.timestamp);
        const onchain = Number(l.args.answer) / 10 ** decimals;
        samples.push({ ts, block: l.blockNumber as bigint, tx: l.transactionHash as string, onchain });
        await sleep(25); // mild pacing to avoid tight RPC loops
      }
      if (samples.length < 10) continue;
      // Sources and initial weights from config (or default)
      const defaultWeights = (cfg.aggregator as any).weights ?? { binance: 1, okx: 1, coinbase: 1 };
      const sources = Object.keys(defaultWeights).map((s) => s.toLowerCase());
      const lagMsList = genLagsMs(3000, 100);
      let best: { lagMs: number; p50: number; p90: number; used: number } | undefined;
      for (const lagMs of lagMsList) {
        const errs: number[] = [];
        let used = 0;
        for (const s of samples) {
          const tMs = s.ts * 1000 - lagMs;
          const pred = await priceAt100ms(symbol, tMs);
          if (!(pred > 0)) continue;
          const ratio = s.onchain / (pred as number);
          if (!Number.isFinite(ratio)) continue;
          const ebps = Math.round((ratio - 1) * 10_000);
          errs.push(Math.abs(ebps));
          used++;
          if (used % 10 === 0) await sleep(5);
        }
        if (errs.length < Math.max(10, Math.floor(samples.length * 0.4)))) continue;
        const q = percentiles(errs, [0.5, 0.9]);
        const cand = { lagMs, p50: q[0.5]!, p90: q[0.9]!, used };
        if (!best || cand.p90 < best.p90 || (cand.p90 === best.p90 && cand.p50 < best.p50)) best = cand;
      }
      if (!best) continue;
      // Persist: lag_seconds and default weights (normalized)
      const lagSeconds = Math.round(best.lagMs / 1000);
      await pool.query(
        `UPDATE oracle_pred_config SET lag_seconds=$3, updated_at=now()
         WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)`,
        [chainId, addr, lagSeconds],
      );
      // Clear previous weights, then insert
      await pool.query('DELETE FROM oracle_cex_weights WHERE chain_id=$1 AND lower(oracle_addr)=lower($2)', [chainId, addr]);
      const norm = sources.length > 0 ? 1 / sources.length : 0;
      for (const src of sources) {
        await pool.query(
          `INSERT INTO oracle_cex_weights(chain_id, oracle_addr, source, weight)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (chain_id, oracle_addr, source) DO UPDATE SET weight=EXCLUDED.weight, updated_at=now()`,
          [chainId, addr, src, norm],
        );
      }
      console.log(`🧮 Startup fit for ${addr} on ${chainId}: lagMs=${best.lagMs}, p90=${best.p90}bps, used=${best.used}/${samples.length}`);
      // gentle pause between oracles
      await sleep(200);
    } catch (e) {
      console.warn('startupFit error:', (e as any)?.message ?? e);
    }
  }
}
