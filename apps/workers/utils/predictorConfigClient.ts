export interface OracleThresholds {
  heartbeatSeconds: number;
  offsetBps: number;
}

export async function fetchOracleConfig(predictorUrl: string, chainId: number, oracleAddr: string): Promise<OracleThresholds | undefined> {
  try {
    const res = await fetch(new URL('/oracles', predictorUrl));
    if (!res.ok) return undefined;
    const data = (await res.json()) as { chain_id: number; oracle_addr: string; heartbeat_seconds: number; offset_bps: number }[];
    const row = data.find((r) => Number(r.chain_id) === Number(chainId) && r.oracle_addr.toLowerCase() === oracleAddr.toLowerCase());
    if (!row) return undefined;
    return { heartbeatSeconds: Number(row.heartbeat_seconds), offsetBps: Number(row.offset_bps) };
  } catch {
    return undefined;
  }
}

