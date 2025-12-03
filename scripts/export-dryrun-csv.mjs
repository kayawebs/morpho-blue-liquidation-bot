import fs from 'node:fs'
import path from 'node:path'

const IN_PATH = path.resolve('out/worker-dryrun.ndjson')
const OUT_PATH = path.resolve('data/worker-dryrun.csv')

function main() {
  if (!fs.existsSync(IN_PATH)) {
    console.error(`No dryrun log found at ${IN_PATH}`)
    process.exit(1)
  }
  const lines = fs.readFileSync(IN_PATH, 'utf8').split(/\r?\n/).filter(Boolean)
  const rows = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const header = [
    'ts','kind','chainId','marketId','aggregator','sprayReason','cadenceMs','executors','riskGate',
    'borrower','score','price','errBps','biasBps','bShares','collateral','borrowAssets','maxBorrow'
  ]
  const out = [header.join(',')]
  for (const r of rows) {
    out.push([
      r.ts ?? '', r.kind ?? '', r.chainId ?? '', r.marketId ?? '', r.aggregator ?? '', r.sprayReason ?? '', r.cadenceMs ?? '', r.executors ?? '', r.riskGate ?? '',
      r.borrower ?? '', r.score ?? '', r.price ?? '', r.errBps ?? '', r.biasBps ?? '', r.bShares ?? '', r.collateral ?? '', r.borrowAssets ?? '', r.maxBorrow ?? ''
    ].join(','))
  }
  if (!fs.existsSync(path.dirname(OUT_PATH))) fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, out.join('\n'))
  console.log(`Wrote ${OUT_PATH} (${rows.length} rows)`) 
}

main()

