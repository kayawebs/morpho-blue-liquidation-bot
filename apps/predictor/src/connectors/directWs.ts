import WebSocket from 'ws';
import { loadConfig } from '../config.js';
import { buildWsProxyAgent, describeSelectedProxy } from '../utils/proxy.js';

type Handler = (p: { ts: number; price: number; source: string; symbol: string }) => void;

export class DirectWsConnector {
  private onTick: Handler;
  private isStopped = false;

  constructor(onTick: Handler) {
    this.onTick = onTick;
  }

  async start() {
    this.isStopped = false;
    const cfg = loadConfig();
    for (const p of cfg.pairs) {
      const norm = p.symbol;
      if (p.binance) this.startBinance(norm, p.binance);
      if (p.okx) this.startOkx(norm, p.okx);
      if (p.coinbase) this.startCoinbase(norm, p.coinbase);
    }
  }

  stop() {
    this.isStopped = true;
  }

  private connectWithRetry(
    label: 'binance' | 'okx' | 'coinbase',
    url: string,
    onOpen: (ws: WebSocket) => void,
    onMessage: (buf: Buffer) => void,
    sendPing?: (ws: WebSocket) => void,
  ) {
    const agent = buildWsProxyAgent(url);
    if (agent) console.log(`🌐 [${label}] WS proxy: ${describeSelectedProxy(url)}`);
    let attempt = 0;
    const connect = () => {
      if (this.isStopped) return;
      const ws = new WebSocket(url, { agent: agent as any, perMessageDeflate: false });
      let pingTimer: NodeJS.Timeout | undefined;
      ws.on('open', () => {
        attempt = 0;
        console.log(`🔌 [${label}] connected`);
        if (sendPing) {
          clearInterval(pingTimer!);
          pingTimer = setInterval(() => {
            try { sendPing(ws); } catch {}
          }, 15000);
        }
        onOpen(ws);
      });
      ws.on('message', onMessage);
      ws.on('error', (e) => {
        const msg = String((e as any)?.message ?? e);
        console.warn(`⚠️ [${label}] error: ${msg}`);
      });
      const scheduleReconnect = () => {
        clearInterval(pingTimer!);
        if (this.isStopped) return;
        attempt += 1;
        const backoff = Math.min(60_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        console.warn(`🔁 [${label}] reconnecting in ${backoff}ms (attempt ${attempt})`);
        setTimeout(connect, backoff);
      };
      ws.on('close', scheduleReconnect);
    };
    connect();
  }

  private startBinance(normSymbol: string, exSymbol: string) {
    const url = `wss://stream.binance.com:9443/ws/${exSymbol.toLowerCase()}@trade`;
    this.connectWithRetry(
      'binance',
      url,
      () => { /* no-op on open */ },
      (buf) => {
        try {
          const msg = JSON.parse(buf.toString());
          const price = Number(msg?.p);
          const ts = Number(msg?.E ?? Date.now());
          if (Number.isFinite(price)) this.onTick({ ts, price, source: 'binance', symbol: normSymbol });
        } catch {}
      },
      (ws) => { try { ws.ping(); } catch {} },
    );
  }

  private startOkx(normSymbol: string, exSymbol: string) {
    const url = 'wss://ws.okx.com:8443/ws/v5/public';
    this.connectWithRetry(
      'okx',
      url,
      (ws) => {
        const sub = { op: 'subscribe', args: [{ channel: 'trades', instId: exSymbol }] };
        ws.send(JSON.stringify(sub));
      },
      (buf) => {
        try {
          const msg = JSON.parse(buf.toString());
          const d = Array.isArray(msg?.data) && msg.data[0];
          const price = Number(d?.px ?? d?.p ?? d?.last ?? d?.price);
          const ts = Number(d?.ts ?? Date.now());
          if (Number.isFinite(price)) this.onTick({ ts, price, source: 'okx', symbol: normSymbol });
        } catch {}
      },
      (ws) => { try { ws.send('ping'); } catch {} },
    );
  }

  private startCoinbase(normSymbol: string, exSymbol: string) {
    const url = 'wss://ws-feed.exchange.coinbase.com';
    this.connectWithRetry(
      'coinbase',
      url,
      (ws) => {
        const sub = { type: 'subscribe', channels: [{ name: 'ticker', product_ids: [exSymbol] }] };
        ws.send(JSON.stringify(sub));
      },
      (buf) => {
        try {
          const msg = JSON.parse(buf.toString());
          if (msg?.type !== 'ticker') return;
          const price = Number(msg?.price ?? msg?.last_trade_price ?? msg?.best_ask);
          const ts = msg?.time ? Date.parse(msg.time) : Date.now();
          if (Number.isFinite(price)) this.onTick({ ts, price, source: 'coinbase', symbol: normSymbol });
        } catch {}
      },
      (ws) => { try { ws.ping(); } catch {} },
    );
  }
}
