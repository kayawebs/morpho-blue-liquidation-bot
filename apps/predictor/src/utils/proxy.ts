import HttpsProxyAgent from 'https-proxy-agent';

function env(key: string): string | undefined {
  return process.env[key] || process.env[key.toLowerCase()];
}

function pickProxyForProtocol(protocol: 'http:' | 'https:' | 'ws:' | 'wss:'): string | undefined {
  if (protocol === 'https:' || protocol === 'wss:') {
    return env('HTTPS_PROXY') || env('ALL_PROXY') || env('HTTP_PROXY');
  }
  return env('HTTP_PROXY') || env('ALL_PROXY');
}

export async function ensureGlobalHttpProxy(): Promise<void> {
  // Configure global fetch (undici) to use proxy if provided.
  const proxyUrl = pickProxyForProtocol('https:');
  if (!proxyUrl) return;
  try {
    const u: any = await import('undici');
    const agent = new u.ProxyAgent(proxyUrl);
    u.setGlobalDispatcher(agent);
    console.log(`🌐 Using proxy for HTTP(S) fetch: ${describeProxyUrl(proxyUrl)}`);
  } catch (err: any) {
    console.warn(`⚠️ Undici not available to set HTTP proxy: ${err?.message ?? err}`);
  }
}

export async function makeFetchWithProxy(): Promise<typeof fetch> {
  const proxyUrl = pickProxyForProtocol('https:');
  if (!proxyUrl) return globalThis.fetch.bind(globalThis);
  try {
    const u: any = await import('undici');
    const dispatcher = new u.ProxyAgent(proxyUrl);
    const f = (input: any, init: any = {}) => u.fetch(input, { ...init, dispatcher });
    return f as unknown as typeof fetch;
  } catch {
    return globalThis.fetch.bind(globalThis);
  }
}

export function buildWsProxyAgent(targetUrl: string): any | undefined {
  try {
    const u = new URL(targetUrl);
    const proxyUrl = pickProxyForProtocol(u.protocol as any);
    if (!proxyUrl) return undefined;
    // For wss://, use HTTPS proxy agent. Most exchange endpoints use wss.
    if (u.protocol === 'wss:' || u.protocol === 'https:') {
      return new HttpsProxyAgent(proxyUrl);
    }
    // If a ws:// endpoint appears, prefer adding http-proxy-agent to support it.
    console.warn('⚠️ WS proxy for ws:// not configured (https-proxy-agent is used for wss://).');
    return undefined;
  } catch {
    return undefined;
  }
}

export function describeSelectedProxy(targetUrl: string): string {
  try {
    const u = new URL(targetUrl);
    const p = pickProxyForProtocol(u.protocol as any);
    return p ? describeProxyUrl(p) : 'none';
  } catch {
    return 'none';
  }
}

function describeProxyUrl(p: string): string {
  // Hide auth if provided
  try {
    const u = new URL(p);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    return p;
  }
}
