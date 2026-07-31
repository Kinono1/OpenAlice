import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface FundingPoint { symbol: string; fundingRate: number; timestamp: number }

export async function exportOkxFundingHistory(input: {
  normalizedPath: string
  symbol: string
  outputPath: string
}): Promise<{ outputPath: string; rows: number }> {
  const raw = await readFile(resolve(input.normalizedPath), 'utf-8')
  const symbol = input.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const byTimestamp = new Map<number, FundingPoint>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line) as Record<string, unknown>
    if (row.exchange !== 'okx' || row.market !== 'swap' || row.endpointId !== 'fundingRate' || row.symbol !== symbol) continue
    const fields = row.fields && typeof row.fields === 'object' ? row.fields as Record<string, unknown> : {}
    const timestamp = numberValue(fields.fundingTime) ?? numberValue(fields.timestamp) ?? numberValue(row.eventTimeMs)
    const fundingRate = numberValue(fields.fundingRate)
    if (timestamp == null || fundingRate == null) continue
    byTimestamp.set(timestamp, { symbol: `${symbol.replace(/USDT$/, '')}/USDT:USDT`, fundingRate, timestamp })
  }
  const rows = [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp)
  if (rows.length === 0) throw new Error(`no OKX funding rows for ${symbol}`)
  const outputPath = resolve(input.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.${process.pid}.tmp`
  await writeFile(tempPath, `${JSON.stringify(rows, null, 2)}\n`)
  await rename(tempPath, outputPath)
  return { outputPath, rows: rows.length }
}

function numberValue(value: unknown): number | null { const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(parsed) ? parsed : null }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const raw = new Map<string, string>()
  for (let i = 2; i < process.argv.length; i += 1) { const token = process.argv[i]; const next = process.argv[i + 1]; if (token?.startsWith('--') && next && !next.startsWith('--')) { raw.set(token.slice(2), next); i += 1 } }
  exportOkxFundingHistory({
    normalizedPath: raw.get('normalizedPath') ?? 'data/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl',
    symbol: raw.get('symbol') ?? 'ETHUSDT',
    outputPath: raw.get('outputPath') ?? 'data/research/derivatives_history/okx_ETH_USDT_USDT_funding_history.json',
  }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1 })
}
