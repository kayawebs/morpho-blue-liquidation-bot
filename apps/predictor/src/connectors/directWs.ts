import WebSocket from 'ws';
import { loadConfig } from '../config.js';
import { buildWsProxyAgent, describeSelectedProxy } from '../utils/proxy.js';

type Handler = (p: { ts: number; price: number; source: string; symbol: string }) => void;

export class DirectWsConnector {
  private onTick: Handler;
  private sockets: WebSocket[] = [];

  constructor(onTick: Handler) {
    this.onTick = onTick;
  }

  async start() {
    const cfg = loadConfig();
    for (const p of cfg.pairs) {
      const norm = p.symbol;
      if (p.binance) this.startBinance(norm, p.binance);
      if (p.okx) this.startOkx(norm, p.okx);
      if (p.coinbase) this.startCoinbase(norm, p.coinbase);
    }
  }

  stop() {
    for (const s of this.sockets) {
      try { s.close(); } catch {}
    }
    this.sockets = [];
  }

  private startBinance(normSymbol: string, exSymbol: string) {
    const url = `wss://stream.binance.com:9443/ws/${exSymbol.toLowerCase()}@trade`;
    const agent = buildWsProxyAgent(url);
    if (agent) console.log(`🌐 [binance] WS proxy: ${describeSelectedProxy(url)}`);
    const ws = new WebSocket(url, { agent: agent as any });
    this.sockets.push(ws);
    ws.on('open', () => console.log(`🔌 [binance] connected: ${exSymbol}`));
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const price = Number(msg?.p);
        const ts = Number(msg?.E ?? Date.now());
        if (Number.isFinite(price)) this.onTick({ ts, price, source: 'binance', symbol: normSymbol });
      } catch {}
    });
    ws.on('error', (e) => console.warn(`⚠️ [binance] error: ${String((e as any)?.message ?? e)}`));
    ws.on('close', () => console.warn(`⚠️ [binance] disconnected: ${exSymbol}`));
  }

  private startOkx(normSymbol: string, exSymbol: string) {
    // OKX v5 public trades channel
    const url = 'wss://ws.okx.com:8443/ws/v5/public';
    const agent = buildWsProxyAgent(url);
    if (agent) console.log(`🌐 [okx] WS proxy: ${describeSelectedProxy(url)}`);
    const ws = new WebSocket(url, { agent: agent as any });
    this.sockets.push(ws);
    ws.on('open', () => {
      console.log(`🔌 [okx] connected: ${exSymbol}`);
      const sub = { op: 'subscribe', args: [{ channel: 'trades', instId: exSymbol }] };
      ws.send(JSON.stringify(sub));
    });
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const d = Array.isArray(msg?.data) && msg.data[0];
        const price = Number(d?.px ?? d?.p ?? d?.last ?? d?.price);
        const ts = Number(d?.ts ?? Date.now());
        if (Number.isFinite(price)) this.onTick({ ts, price, source: 'okx', symbol: normSymbol });
      } catch {}
    });
    ws.on('error', (e) => console.warn(`⚠️ [okx] error: ${String((e as any)?.message ?? e)}`));
    ws.on('close', () => console.warn(`⚠️ [okx] disconnected: ${exSymbol}`));
  }

  private startCoinbase(normSymbol: string, exSymbol: string) {
    // Coinbase Advanced/Pro legacy feed
    const url = 'wss://ws-feed.exchange.coinbase.com';
    const agent = buildWsProxyAgent(url);
    if (agent) console.log(`🌐 [coinbase] WS proxy: ${describeSelectedProxy(url)}`);
    const ws = new WebSocket(url, { agent: agent as any });
    this.sockets.push(ws);
    ws.on('open', () => {
      console.log(`🔌 [coinbase] connected: ${exSymbol}`);
      const sub = { type: 'subscribe', channels: [{ name: 'ticker', product_ids: [exSymbol] }] };
      ws.send(JSON.stringify(sub));
    });
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (msg?.type !== 'ticker') return;
        const price = Number(msg?.price ?? msg?.last_trade_price ?? msg?.best_ask);
        const ts = msg?.time ? Date.parse(msg.time) : Date.now();
        if (Number.isFinite(price)) this.onTick({ ts, price, source: 'coinbase', symbol: normSymbol });
      } catch {}
    });
    ws.on('error', (e) => console.warn(`⚠️ [coinbase] error: ${String((e as any)?.message ?? e)}`));
    ws.on('close', () => console.warn(`⚠️ [coinbase] disconnected: ${exSymbol}`));
  }
}

