/**
 * Download deep historical data from Binance (primary) + OKX (fallback).
 * Binance: 1000 bars/request, no hard history limit.
 * OKX: 300 bars/request, capped at ~1440 for 1H.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchBinanceExtendedCandles, fetchExtendedCandles, candlesToCSV } from '../src/domain/market-data/live-fetcher.js'
import { defaultPaperUniverseAssets } from './lib/paper_universe.js'

interface DownloadLiveAssetsArgs {
  outDir: string
  dryRun: boolean
}

export function parseDownloadLiveAssetsArgs(argv: string[]): DownloadLiveAssetsArgs {
  const raw = parseRawArgs(argv)
  return {
    outDir: raw.get('outDir') ?? join(import.meta.dirname ?? '.', '..', 'data', 'market', 'multi_assets'),
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

export function buildDownloadLiveAssetsPlan(args: DownloadLiveAssetsArgs) {
  return {
    mode: args.dryRun ? 'dry_run' : 'download',
    outDir: args.outDir,
    assets: defaultPaperUniverseAssets().map(asset => ({
      storageFile: asset.file,
      storageSymbol: asset.storageSymbol,
      binanceSymbol: asset.binanceSymbol,
      okxInstId: asset.okxInstId,
    })),
  }
}

async function main() {
  const args = parseDownloadLiveAssetsArgs(process.argv.slice(2))
  const outDir = args.outDir
  if (args.dryRun) {
    console.log(JSON.stringify(buildDownloadLiveAssetsPlan(args), null, 2))
    return
  }

  await mkdir(outDir, { recursive: true })

  for (const asset of defaultPaperUniverseAssets()) {
    console.log(`Downloading ${asset.binanceSymbol} from Binance...`)
    let candles: Awaited<ReturnType<typeof fetchBinanceExtendedCandles>> = []

    // Primary: Binance (deep history, up to 10k bars)
    try {
      candles = await fetchBinanceExtendedCandles(asset.binanceSymbol, '1H', 10000)
      if (candles.length > 0) {
        const csv = candlesToCSV(candles, asset.storageSymbol, 'binance_futures')
        await writeFile(join(outDir, asset.file), csv)
        const first = new Date(candles[0].timestamp).toISOString().slice(0, 10)
        const last = new Date(candles[candles.length - 1].timestamp).toISOString().slice(0, 10)
        console.log(`  Binance: ${candles.length} bars | ${first} -> ${last}`)
        continue
      }
    } catch (err) {
      console.log(`  Binance failed: ${err instanceof Error ? err.message : err}`)
    }

    // Fallback: OKX (limited to ~1440 bars for 1H)
    try {
      console.log(`  Falling back to OKX ${asset.okxInstId}...`)
      candles = await fetchExtendedCandles(asset.okxInstId, '1H', 7000)
      const csv = candlesToCSV(candles, asset.storageSymbol, 'okx')
      await writeFile(join(outDir, asset.file), csv)
      const first = candles.length > 0 ? new Date(candles[0].timestamp).toISOString().slice(0, 10) : 'N/A'
      const last = candles.length > 0 ? new Date(candles[candles.length - 1].timestamp).toISOString().slice(0, 10) : 'N/A'
      console.log(`  OKX: ${candles.length} bars | ${first} -> ${last}`)
    } catch (err) {
      console.log(`  OKX also failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  console.log(`\nDone. Files in ${outDir}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}
