/**
 * Quick OKX-only download of 1h klines for additional research assets.
 * Usage: npx tsx scripts/download_multi_assets.ts
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { candlesToCSV, fetchExtendedCandles } from '../src/domain/market-data/live-fetcher.js'

const ASSETS = [
  { symbol: 'SOL/USDT:USDT', instId: 'SOL-USDT-SWAP', storageSymbol: 'SOL_USDT_USDT' },
  { symbol: 'BNB/USDT:USDT', instId: 'BNB-USDT-SWAP', storageSymbol: 'BNB_USDT_USDT' },
  { symbol: 'XRP/USDT:USDT', instId: 'XRP-USDT-SWAP', storageSymbol: 'XRP_USDT_USDT' },
  { symbol: 'DOGE/USDT:USDT', instId: 'DOGE-USDT-SWAP', storageSymbol: 'DOGE_USDT_USDT' },
  { symbol: 'ADA/USDT:USDT', instId: 'ADA-USDT-SWAP', storageSymbol: 'ADA_USDT_USDT' },
  { symbol: 'AVAX/USDT:USDT', instId: 'AVAX-USDT-SWAP', storageSymbol: 'AVAX_USDT_USDT' },
]
const TIMEFRAME = '1h'
const SINCE_MS = new Date('2025-07-01').getTime()
const MAX_CANDLES = 7000

interface DownloadMultiAssetsArgs {
  outDir: string
  dryRun: boolean
}

export function parseDownloadMultiAssetsArgs(argv: string[]): DownloadMultiAssetsArgs {
  const raw = parseRawArgs(argv)
  return {
    outDir: raw.get('outDir') ?? join(import.meta.dirname, '..', 'data', 'market', 'multi_assets'),
    dryRun: parseBoolArg(raw.get('dryRun'), true),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
  }
  return out
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

export function buildDownloadMultiAssetsPlan(args: DownloadMultiAssetsArgs) {
  return {
    mode: args.dryRun ? 'dry_run' : 'download',
    outDir: args.outDir,
    exchange: 'okx',
    timeframe: TIMEFRAME,
    sinceMs: SINCE_MS,
    maxCandles: MAX_CANDLES,
    symbols: ASSETS.map(asset => asset.symbol),
    instrumentIds: ASSETS.map(asset => asset.instId),
  }
}

async function main() {
  const args = parseDownloadMultiAssetsArgs(process.argv.slice(2))
  const outDir = args.outDir
  if (args.dryRun) {
    console.log(JSON.stringify(buildDownloadMultiAssetsPlan(args), null, 2))
    return
  }

  await mkdir(outDir, { recursive: true })

  for (const asset of ASSETS) {
    console.log(`Downloading ${asset.instId} from OKX...`)
    const candles = (await fetchExtendedCandles(asset.instId, '1H', MAX_CANDLES))
      .filter(candle => candle.timestamp >= SINCE_MS)
    const fileName = `${asset.storageSymbol}_1h.csv`
    await writeFile(join(outDir, fileName), candlesToCSV(candles, asset.storageSymbol, 'okx'))
    console.log(`  ${asset.instId}: ${candles.length} candles -> ${fileName}`)
  }

  console.log(`\nDone. Files saved to ${outDir}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}
