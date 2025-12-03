import fs from 'node:fs'
import path from 'node:path'

const EXECUTOR_CSV = path.resolve('data/executor.csv')

// Consider a new spray session if gap > this (seconds)
const SESSION_GAP_SEC = 5

function splitCsvLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQ = false }
      } else cur += ch
    } else {
      if (ch === ',') { out.push(cur); cur = '' }
      else if (ch === '"') { inQ = true }
      else cur += ch
    }
  }
  out.push(cur)
  return out
}

function parseCsv(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (!lines.length) return []
  const header = splitCsvLine(lines[0])
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    const cols = splitCsvLine(line)
    const row = {}
    for (let j = 0; j < header.length; j++) row[header[j]] = cols[j] ?? ''
    rows.push(row)
  }
  return rows
}

function toInt(v) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : undefined }

function quantiles(arr, qs = [0.5, 0.9]) {
  if (!arr.length) return qs.map(() => NaN)
  const a = [...arr].sort((x, y) => x - y)
  return qs.map(q => {
    const idx = Math.max(0, Math.min(a.length - 1, Math.floor(q * (a.length - 1))))
    return a[idx]
  })
}

function histogram(arr, bins) {
  const res = bins.map(() => 0)
  for (const v of arr) {
    let placed = false
    for (let i = 0; i < bins.length; i++) {
      if (v <= bins[i]) { res[i]++; placed = true; break }
    }
    if (!placed) res[res.length - 1]++
  }
  return res
}

function main() {
  if (!fs.existsSync(EXECUTOR_CSV)) {
    console.error(`Missing ${EXECUTOR_CSV}`)
    process.exit(1)
  }
  const rows = parseCsv(fs.readFileSync(EXECUTOR_CSV, 'utf8'))
  if (!rows.length) { console.log('No rows.'); return }

  // Extract minimal fields
  const entries = rows.map(r => ({
    hash: r['Transaction Hash'] || r['Txn Hash'] || r['hash'] || '',
    from: r['From'] || r['from'] || '',
    block: toInt(r['Blockno'] || r['Block Number'] || r['blockNumber'] || ''),
    ts: toInt(r['UnixTimestamp'] || r['Unix Timestamp'] || r['timeStamp'] || ''),
  })).filter(r => r.hash && r.ts !== undefined)

  // If multiple senders, pick the dominant one (our executor EOA)
  const byFrom = new Map()
  for (const e of entries) byFrom.set(e.from, (byFrom.get(e.from) || 0) + 1)
  const dominant = [...byFrom.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const txs = entries.filter(e => e.from === dominant).sort((a, b) => (a.ts - b.ts) || (a.block - b.block))

  // Build sessions by time gap
  const sessions = []
  let cur = []
  for (let i = 0; i < txs.length; i++) {
    const t = txs[i]
    if (cur.length === 0) { cur.push(t); continue }
    const gap = t.ts - cur[cur.length - 1].ts
    if (gap > SESSION_GAP_SEC) { sessions.push(cur); cur = [t] } else { cur.push(t) }
  }
  if (cur.length) sessions.push(cur)

  // Inter-tx deltas (seconds) across all sessions
  const deltasSec = []
  for (const s of sessions) for (let i = 1; i < s.length; i++) deltasSec.push(s[i].ts - s[i - 1].ts)

  // Per-session cadence (ms): duration/(n-1)
  const cadencesMs = []
  for (const s of sessions) {
    if (s.length <= 1) continue
    const durSec = s[s.length - 1].ts - s[0].ts
    const cadenceMs = (durSec * 1000) / (s.length - 1)
    cadencesMs.push(cadenceMs)
  }

  const [p50ms, p90ms] = quantiles(deltasSec.map(x => x * 1000), [0.5, 0.9])
  const bins = [50, 100, 150, 200, 300, 500, 1000]
  const hist = histogram(deltasSec.map(x => x * 1000), bins)

  const totalTx = txs.length
  const sessCnt = sessions.length
  const multiCnt = sessions.filter(s => s.length > 1).length
  const avgDeltaMs = deltasSec.length ? (deltasSec.reduce((a, b) => a + b, 0) * 1000 / deltasSec.length) : NaN
  const avgCadenceMs = cadencesMs.length ? (cadencesMs.reduce((a, b) => a + b, 0) / cadencesMs.length) : NaN

  console.log('Executor spray frequency (derived from data/executor.csv)')
  console.log(`- Sender analyzed: ${dominant}`)
  console.log(`- Total tx: ${totalTx}`)
  console.log(`- Sessions: ${sessCnt} (multi-tx: ${multiCnt})  SESSION_GAP_SEC=${SESSION_GAP_SEC}`)
  console.log(`- Inter-tx delta ms  avg=${fmt(avgDeltaMs)}  p50=${fmt(p50ms)}  p90=${fmt(p90ms)}`)
  if (cadencesMs.length) console.log(`- Per-session cadence ms  avg=${fmt(avgCadenceMs)}  p50=${fmt(quantiles(cadencesMs, [0.5])[0])}  p90=${fmt(quantiles(cadencesMs, [0.9])[0])}`)
  console.log('- Inter-tx delta histogram (ms):')
  for (let i = 0; i < bins.length; i++) {
    const label = i === 0 ? `<=${bins[i]}` : `<=${bins[i]}`
    console.log(`  ${label.padEnd(6)} : ${hist[i]}`)
  }
  console.log(`  >${bins[bins.length - 1]} : ${deltasSec.length - hist.reduce((a, b) => a + b, 0)}`)

  // Print a few example sessions
  const show = sessions.slice(0, 5)
  console.log('- Example sessions (first 5):')
  for (const s of show) {
    const first = s[0]
    const last = s[s.length - 1]
    const dur = last.ts - first.ts
    const deltas = []
    for (let i = 1; i < s.length; i++) deltas.push(s[i].ts - s[i - 1].ts)
    console.log(`  count=${s.length}  start=${first.ts}  durSec=${dur}  deltasSec=[${deltas.join(',')}]`)
  }
}

function fmt(x) { return Number.isFinite(x) ? x.toFixed(1) : 'NaN' }

main()

