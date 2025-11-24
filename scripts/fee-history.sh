#!/usr/bin/env bash
set -euo pipefail

# Simple fee history percentile sampler (gwei averages)
# Usage:
#   scripts/fee-history.sh [blocks=20] [rpc_url]
# Defaults:
#   blocks = 20
#   rpc_url = $RPC_URL_8453 || $RPC_URL || http://127.0.0.1:8545

blocks="${1:-20}"
rpc="${2:-${RPC_URL_8453:-${RPC_URL:-http://127.0.0.1:8545}}}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required (sudo apt-get install jq)" >&2
  exit 1
fi

# Fetch feeHistory with fixed percentiles: [10,25,50,75,90]
resp=$(curl -sS -H 'content-type: application/json' \
  --data "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"eth_feeHistory\",\"params\":[${blocks},\"latest\",[10,25,50,75,90]]}" \
  "$rpc")

if [ -z "${resp}" ]; then
  echo "error: empty response from RPC ($rpc)" >&2
  exit 1
fi

# jq program: convert hex wei to decimal, average each percentile across blocks, output gwei
jq -r '
  def hx:
    if type=="string" and startswith("0x") then
      (.[2:] | explode | reduce .[] as $c (0;
        . * 16 +
        (if   $c>=97 then $c-87   # a-f
         elif $c>=65 then $c-55   # A-F
         else $c-48               # 0-9
         end)))
    else tonumber end;
  if has("error") then { error: .error } else
  .result.reward
  | transpose
  | { p10: (.[0] | map(hx) | add/length/1e9),
      p25: (.[1] | map(hx) | add/length/1e9),
      p50: (.[2] | map(hx) | add/length/1e9),
      p75: (.[3] | map(hx) | add/length/1e9),
      p90: (.[4] | map(hx) | add/length/1e9) }
  end' <<< "$resp"
