/**
 * Download bounded public historical data from OKX for manual research use.
 *
 * Binance Futures REST is intentionally not a fallback here: that online source
 * is retired after repeated HTTP 451 responses. Binance Data Vision remains a
 * separate, explicit offline backfill workflow.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchExtendedCandles, candlesToCSV } from '../src/domain/market-data/live-fetcher.js'
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
    exchange: 'okx',
    timeframe: '1h',
    maxCandles: 7000,
    assets: defaultPaperUniverseAssets().map(asset => ({
      storageFile: asset.file,
      storageSymbol: asset.storageSymbol,
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
    try {
      console.log(`Downloading ${asset.okxInstId} from OKX...`)
      const candles = await fetchExtendedCandles(asset.okxInstId, '1H', 7000)
      const csv = candlesToCSV(candles, asset.storageSymbol, 'okx')
      await writeFile(join(outDir, asset.file), csv)
      const first = candles.length > 0 ? new Date(candles[0].timestamp).toISOString().slice(0, 10) : 'N/A'
      const last = candles.length > 0 ? new Date(candles[candles.length - 1].timestamp).toISOString().slice(0, 10) : 'N/A'
      console.log(`  OKX: ${candles.length} bars | ${first} -> ${last}`)
    } catch (err) {
      console.log(`  OKX failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  console.log(`\nDone. Files in ${outDir}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}
