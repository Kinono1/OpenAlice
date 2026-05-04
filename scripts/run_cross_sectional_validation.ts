/**
 * Cross-Sectional Reversal — full validation with improved algorithm.
 * Compares baseline vs improved ranking and reports win rate delta.
 *
 * Usage: npx tsx scripts/run_cross_sectional_validation.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateCrossSectionalMomentum } from '../src/domain/strategy/cross-sectional-momentum.js'
import type { CrossSectionalAsset } from '../src/domain/strategy/cross-sectional-momentum.js'

interface CliArgs {
  dryRun: boolean
}

async function loadCandles(csvPath: string): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
  const raw = await readFile(csvPath, 'utf-8')
  const lines = raw.trim().split('\n')
  const header = lines[0].split(',')
  const ti = header.indexOf('timestamp'); const oi = header.indexOf('open')
  const hi = header.indexOf('high'); const li = header.indexOf('low')
  const ci = header.indexOf('close'); const vi = header.indexOf('volume')
  return lines.slice(1).map(l => {
    const c = l.split(',')
    return { time: Number(c[ti]), open: Number(c[oi]), high: Number(c[hi]), low: Number(c[li]), close: Number(c[ci]), volume: Number(c[vi]) }
  })
    .filter(c => c.time > 0 && [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite))
    .sort((a, b) => a.time - b.time)
}

function computeVol(candles: Array<{ close: number }>, index: number, lookback: number): number {
  const start = Math.max(0, index - lookback)
  const returns: number[] = []
  for (let i = start + 1; i <= index; i++) {
    if (candles[i - 1].close > 0) returns.push(candles[i].close / candles[i - 1].close - 1)
  }
  if (returns.length < 2) return 50
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance * 365 * 24) * 100
}

interface SignalRecord {
  date: string
  topSymbol: string
  bottomSymbol: string
  topReturn: number
  bottomReturn: number
  spread: number
  correct: boolean
}

async function runBacktest(
  assets: CrossSectionalAsset[],
  lookbackHours: number,
  secondaryLookback: number,
  forwardHours: number,
  name: string,
): Promise<{ signals: number; winRate: number; spreadCumulative: number; records: SignalRecord[] }> {
  let signals = 0; let wins = 0; let spreadCum = 0
  const records: SignalRecord[] = []

  const ranks = evaluateCrossSectionalMomentum(assets, {
    lookbackHours,
    secondaryLookbackHours: secondaryLookback,
    topN: 1,
    bottomN: 1,
    minUniverseSize: 2,
    maxVolPercentile: 0.99,
    minSpreadPct: 0,
    requireVolumeConfirmation: false,
    mtfWeight: name === 'improved' ? 0.35 : 0,
  })

  const topAsset = ranks.find(r => r.signal !== 0)
  const bottomAsset = ranks.find(r => r.signal !== 0 && r.symbol !== topAsset?.symbol)

  if (topAsset && bottomAsset) {
    const top = assets.find(a => a.symbol === topAsset.symbol)!
    const bottom = assets.find(a => a.symbol === bottomAsset.symbol)!

    const fwdKey = `${forwardHours}h`
    const topFwd = top.returns[fwdKey] ?? 0
    const bottomFwd = bottom.returns[fwdKey] ?? 0
    const signalSpread = topFwd - bottomFwd

    signals++
    spreadCum += signalSpread
    if (signalSpread > 0) wins++

    records.push({
      date: new Date().toISOString().slice(0, 10),
      topSymbol: top.symbol,
      bottomSymbol: bottom.symbol,
      topReturn: topFwd,
      bottomReturn: bottomFwd,
      spread: signalSpread,
      correct: signalSpread > 0,
    })
  }

  return {
    signals,
    winRate: signals > 0 ? wins / signals * 100 : 0,
    spreadCumulative: spreadCum,
    records,
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: 'cross_sectional_validation',
      command: 'run_cross_sectional_validation',
      executionMode: {
        dryRun: true,
        writesResearchArtifacts: false,
        promotionEligible: false,
      },
      optIn: {
        runValidation: '--dryRun false',
      },
    }, null, 2))
    return
  }

  const dataDir = join(import.meta.dirname, '..', 'data', 'market', 'gate')
  const multiDir = join(import.meta.dirname, '..', 'data', 'market', 'multi_assets')

  console.log('Loading data...')
  const btc = await loadCandles(join(dataDir, 'BTC_USDT_USDT_1h.csv'))
  const eth = await loadCandles(join(dataDir, 'ETH_USDT_USDT_1h.csv'))

  // Try to load additional symbols
  const extraSymbols: Array<{ symbol: string; candles: typeof btc }> = []
  const extraFiles = ['SOL_USDT_USDT_1h.csv', 'BNB_USDT_USDT_1h.csv', 'XRP_USDT_USDT_1h.csv', 'DOGE_USDT_USDT_1h.csv']
  for (const f of extraFiles) {
    try {
      const candles = await loadCandles(join(multiDir, f))
      const symbol = f.replace('_USDT_USDT_1h.csv', '')
      extraSymbols.push({ symbol: `${symbol}-USDT`, candles })
      console.log(`  Loaded ${symbol}: ${candles.length} bars`)
    } catch {
      // File not available yet
    }
  }

  const allCandles = [
    { symbol: 'BTC-USDT', candles: btc },
    { symbol: 'ETH-USDT', candles: eth },
    ...extraSymbols,
  ]
  console.log(`Total assets: ${allCandles.length}\n`)

  // Parameters
  const lookbacks = [168, 336, 504] // 7d, 14d, 21d
  const forwardHours = 24
  const secondaryLookback = 720 // 30d for multi-timeframe

  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║   Cross-Sectional Reversal — Algorithm Comparison    ║')
  console.log('╚══════════════════════════════════════════════════════╝\n')

  for (const lookback of lookbacks) {
    console.log(`=== Lookback: ${lookback}h (${lookback/24}d) | Forward: ${forwardHours}h ===\n`)

    const minBars = Math.max(lookback, secondaryLookback, forwardHours) + 2
    const maxIndex = Math.min(...allCandles.map(a => a.candles.length)) - forwardHours

    let baselineSignals = 0; let baselineWins = 0; let baselineSpread = 0
    let improvedSignals = 0; let improvedWins = 0; let improvedSpread = 0
    let filteredCount = 0

    for (let i = minBars; i < maxIndex; i++) {
      const fwdIdx = i + forwardHours

      const csAssets: CrossSectionalAsset[] = allCandles.map(({ symbol, candles }) => ({
        symbol,
        currentPrice: candles[i].close,
        returns: {
          [`${lookback}h`]: (candles[i].close / candles[i - lookback].close - 1) * 100,
          [`${secondaryLookback}h`]: i >= secondaryLookback
            ? (candles[i].close / candles[i - secondaryLookback].close - 1) * 100
            : (candles[i].close / candles[0].close - 1) * 100,
          [`${forwardHours}h`]: (candles[fwdIdx].close / candles[i].close - 1) * 100,
        },
        realizedVolPct: computeVol(candles, i, 24),
        avgVolume24h: candles[i].volume,
      }))

      // Baseline: raw return ranking, no filters
      const baseRanks = evaluateCrossSectionalMomentum(csAssets, {
        lookbackHours: lookback,
        secondaryLookbackHours: secondaryLookback,
        topN: 1,
        bottomN: 1,
        minUniverseSize: 2,
        maxVolPercentile: 0.99,
        minSpreadPct: 0,
        requireVolumeConfirmation: false,
        mtfWeight: 0,
      })

      const baseTop = baseRanks.find(r => r.signal !== 0)
      const baseBottom = baseRanks.find(r => r.signal !== 0 && r.symbol !== baseTop?.symbol)
      if (baseTop && baseBottom) {
        baselineSignals++
        const topFwd = csAssets.find(a => a.symbol === baseTop.symbol)!.returns[`${forwardHours}h`]
        const bottomFwd = csAssets.find(a => a.symbol === baseBottom.symbol)!.returns[`${forwardHours}h`]
        const s = topFwd - bottomFwd
        baselineSpread += s
        if (s > 0) baselineWins++
      }

      // Improved: risk-adjusted + multi-timeframe + spread filter
      const impRanks = evaluateCrossSectionalMomentum(csAssets, {
        lookbackHours: lookback,
        secondaryLookbackHours: secondaryLookback,
        topN: 1,
        bottomN: 1,
        minUniverseSize: 2,
        maxVolPercentile: 0.90,
        minSpreadPct: allCandles.length >= 4 ? 3 : 0,
        requireVolumeConfirmation: true,
        mtfWeight: 0.35,
      })

      const impTop = impRanks.find(r => r.signal !== 0)
      const impBottom = impRanks.find(r => r.signal !== 0 && r.symbol !== impTop?.symbol)
      if (impTop && impBottom) {
        improvedSignals++
        const topFwd = csAssets.find(a => a.symbol === impTop.symbol)!.returns[`${forwardHours}h`]
        const bottomFwd = csAssets.find(a => a.symbol === impBottom.symbol)!.returns[`${forwardHours}h`]
        const s = topFwd - bottomFwd
        improvedSpread += s
        if (s > 0) improvedWins++
      } else if (allCandles.length >= 4) {
        filteredCount++
      }
    }

    const baseWR = baselineSignals > 0 ? baselineWins / baselineSignals * 100 : 0
    const impWR = improvedSignals > 0 ? improvedWins / improvedSignals * 100 : 0
    const delta = impWR - baseWR

    const emoji = delta > 0 ? '📈' : delta < 0 ? '📉' : '➡️'
    console.log(`  Baseline  (raw return):     ${baselineSignals} signals, ${baseWR.toFixed(1)}% WR, spread ${baselineSpread.toFixed(1)}%`)
    console.log(`  Improved  (risk-adj + MTF): ${improvedSignals} signals, ${impWR.toFixed(1)}% WR, spread ${improvedSpread.toFixed(1)}%`)
    console.log(`  ${emoji} Win Rate Delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% | Filtered: ${filteredCount} | Assets: ${allCandles.length}`)
    console.log()
  }

  // Also show per-asset statistics
  console.log('=== Per-Asset Return Distribution ===')
  for (const { symbol, candles } of allCandles) {
    const ret168: number[] = []
    for (let i = 168; i < candles.length; i++) {
      ret168.push((candles[i].close / candles[i - 168].close - 1) * 100)
    }
    ret168.sort((a, b) => a - b)
    const p05 = ret168[Math.floor(ret168.length * 0.05)]
    const p50 = ret168[Math.floor(ret168.length * 0.50)]
    const p95 = ret168[Math.floor(ret168.length * 0.95)]
    console.log(`  ${symbol}: median=${p50?.toFixed(1)}%, 5th=${p05?.toFixed(1)}%, 95th=${p95?.toFixed(1)}%`)
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    dryRun: parseBoolArg(raw.get('dryRun'), true),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const withoutPrefix = token.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(withoutPrefix, next)
      index += 1
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${raw}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch(console.error)
}

export {
  main,
  parseArgs,
}
