import fs from 'node:fs'
import path from 'node:path'

const ORACLE_CSV = path.resolve('data/oraclefeed.csv')
const EXECUTOR_CSV = path.resolve('data/executor.csv')
const OUT_CSV = path.resolve('data/oracle_exec_compare.csv')
const GATE_PASS_FEE_ETH = 0.0000009

function splitCsvLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQ = false
        }
      } else {
        cur += ch
      }
    } else {
      if (ch === ',') { out.push(cur); cur = '' }
      else if (ch === '"') { inQ = true }
      else { cur += ch }
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

function toInt(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}
function toFloat(v) {
  if (!v) return undefined
  const n = Number(String(v).replace(/[^0-9eE+\-.]/g, ''))
  return Number.isFinite(n) ? n : undefined
}
function computeFeeEth(row) {
  const feeEth = toFloat(row['TxnFee(ETH)'] || row['TxnFee (ETH)'])
  if (feeEth !== undefined) return feeEth
  const gasUsed = toFloat(row['gasUsed'] || row['GasUsed'] || row['Gas Used'])
  const egpWei = toFloat(row['effectiveGasPrice'] || row['EffectiveGasPrice'] || row['Effective Gas Price (Wei)'])
  if (gasUsed !== undefined && egpWei !== undefined) return (gasUsed * egpWei) / 1e18
  return undefined
}

function main() {
  if (!fs.existsSync(ORACLE_CSV)) { console.error(`Missing ${ORACLE_CSV}`); process.exit(1) }
  if (!fs.existsSync(EXECUTOR_CSV)) { console.error(`Missing ${EXECUTOR_CSV}`); process.exit(1) }

  const oracleRows = parseCsv(fs.readFileSync(ORACLE_CSV, 'utf8'))
  const execRows = parseCsv(fs.readFileSync(EXECUTOR_CSV, 'utf8'))

  const oracles = oracleRows.map(r => ({
    tx: r['Transaction Hash'] || r['Txn Hash'] || r['hash'] || '',
    block: toInt(r['Blockno'] || r['Block Number'] || r['blockNumber'] || '')
  })).filter(r => r.tx && r.block !== undefined)

  const execs = execRows.map(r => ({
    tx: r['Transaction Hash'] || r['Txn Hash'] || r['hash'] || '',
    block: toInt(r['Blockno'] || r['Block Number'] || r['blockNumber'] || ''),
    feeEth: computeFeeEth(r)
  })).filter(r => r.tx && r.block !== undefined && r.feeEth !== undefined)

  const execByBlock = new Map()
  for (const e of execs) {
    const arr = execByBlock.get(e.block) || []
    arr.push({ tx: e.tx, feeEth: e.feeEth })
    execByBlock.set(e.block, arr)
  }

  const out = []
  out.push([
    'transmit_tx',
    'transmit_block',
    'sprayed_in_block',
    'sprayed_in_block_count',
    'exec_b0_count',
    'exec_b1_count',
    'exec_b2_count',
    'has_gatepass_within_2blocks',
    'gatepass_block',
    'gatepass_tx',
    'gatepass_fee_eth',
    'total_exec_b0_b2'
  ].join(','))

  for (const o of oracles) {
    const b0 = execByBlock.get(o.block) || []
    const b1 = execByBlock.get(o.block + 1) || []
    const b2 = execByBlock.get(o.block + 2) || []
    const sprayedInBlock = b0.length > 0
    const all = [...b0, ...b1, ...b2]
    const gate = all.find(e => e.feeEth > GATE_PASS_FEE_ETH)
    let gateBlock = ''
    let gateTx = ''
    let gateFee = ''
    let hasGate = '0'
    if (gate) {
      hasGate = '1'
      const block = [o.block, o.block + 1, o.block + 2].find(bn => (execByBlock.get(bn) || []).some(x => x.tx === gate.tx))
      gateBlock = block !== undefined ? String(block) : ''
      gateTx = gate.tx
      gateFee = String(gate.feeEth)
    }
    out.push([
      o.tx,
      String(o.block),
      sprayedInBlock ? '1' : '0',
      String(b0.length),
      String(b0.length),
      String(b1.length),
      String(b2.length),
      hasGate,
      gateBlock,
      gateTx,
      gateFee,
      String(b0.length + b1.length + b2.length)
    ].join(','))
  }

  fs.writeFileSync(OUT_CSV, out.join('\n'))
  console.log(`Wrote ${OUT_CSV} (${out.length - 1} rows)`) 
}

main()

