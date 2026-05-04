/**
 * Quick download of 1h klines for additional crypto assets.
 * Usage: npx tsx scripts/download_multi_assets.ts
 */

import ccxt from 'ccxt'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const SYMBOLS = ['SOL/USDT:USDT', 'BNB/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT', 'ADA/USDT:USDT', 'AVAX/USDT:USDT']
const TIMEFRAME = '1h'
const SINCE_MS = new Date('2025-07-01').getTime()
const LIMIT = 1000

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
    exchange: 'binance_futures',
    timeframe: TIMEFRAME,
    sinceMs: SINCE_MS,
    limit: LIMIT,
    symbols: SYMBOLS,
  }
}

async function main() {
  const args = parseDownloadMultiAssetsArgs(process.argv.slice(2))
  const outDir = args.outDir
  if (args.dryRun) {
    console.log(JSON.stringify(buildDownloadMultiAssetsPlan(args), null, 2))
    return
  }

  const exchange = new ccxt.binance({ enableRateLimit: true })
  await mkdir(outDir, { recursive: true })

  for (const symbol of SYMBOLS) {
    console.log(`Downloading ${symbol}...`)
    const allCandles: any[] = []
    let since = SINCE_MS

    while (true) {
      const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, LIMIT)
      if (candles.length === 0) break
      allCandles.push(...candles)
      since = candles[candles.length - 1][0] + 1
      if (candles.length < LIMIT) break
    }

    const csvLines = ['timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange']
    for (const c of allCandles) {
      csvLines.push([
        c[0],
        new Date(c[0]).toISOString(),
        c[1], c[2], c[3], c[4], c[5],
        symbol, TIMEFRAME, 'binance_futures',
      ].join(','))
    }

    const fileName = symbol.replace('/', '_').replace(':', '_') + '_1h.csv'
    await writeFile(join(outDir, fileName), csvLines.join('\n'))
    console.log(`  ${symbol}: ${allCandles.length} candles -> ${fileName}`)
  }

  console.log(`\nDone. Files saved to ${outDir}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}
