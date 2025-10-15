import { loadConfig } from "../config.js";

async function testRest() {
  const cfg = loadConfig();
  const headers = { accept: "application/json", "user-agent": "Mozilla/5.0" } as const;
  const results: any[] = [];

  for (const p of cfg.pairs) {
    const norm = p.symbol;
    // Binance
    if (p.binance) {
      const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(p.binance)}`;
      const r = await fetch(url, { headers }).catch((e) => ({ ok: false, statusText: String(e) } as any));
      let price: number | undefined = undefined;
      let status = "ERR";
      if ((r as any)?.ok) {
        const data = await (r as any).json();
        price = Number(data?.price);
        status = `${(r as any).status}`;
      }
      results.push({ exchange: "binance", symbol: norm, url, status, price });
    }
    // OKX
    if (p.okx) {
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(p.okx)}`;
      const r = await fetch(url, { headers }).catch((e) => ({ ok: false, statusText: String(e) } as any));
      let price: number | undefined = undefined;
      let status = "ERR";
      if ((r as any)?.ok) {
        const data = await (r as any).json();
        price = Number(data?.data?.[0]?.last);
        status = `${(r as any).status}`;
      }
      results.push({ exchange: "okx", symbol: norm, url, status, price });
    }
    // Coinbase
    if (p.coinbase) {
      const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(p.coinbase)}/ticker`;
      const r = await fetch(url, { headers }).catch((e) => ({ ok: false, statusText: String(e) } as any));
      let price: number | undefined = undefined;
      let status = "ERR";
      if ((r as any)?.ok) {
        const data = await (r as any).json();
        const p1 = Number(data?.price);
        const p2 = Number(data?.last);
        price = Number.isFinite(p1) ? p1 : Number.isFinite(p2) ? p2 : undefined;
        status = `${(r as any).status}`;
      }
      results.push({ exchange: "coinbase", symbol: norm, url, status, price });
    }
  }

  console.table(results);
}

async function main() {
  console.log("🔍 Testing REST connectivity to exchanges defined in config.json ...");
  await testRest();
  console.log("✅ Done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

