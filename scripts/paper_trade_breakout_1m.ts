/**
 * Volume Breakout — 1-minute bars.
 * Faster signal detection than 5m version.
 * Usage: npx tsx scripts/paper_trade_breakout_1m.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateVolumeBreakout, DEFAULT_VB_CONFIG } from '../src/domain/strategy/volume-breakout.js'
import { defaultPaperUniverseSymbols } from './lib/paper_universe.js'
import { writeJsonAtomic } from '../src/runtime/atomic_write.js'

interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

function loadCsv(path: string): Candle[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8').trim().split('\n')
  if (raw.length < 2) return []
  const h = raw[0].split(',')
  return raw.slice(1).map(l => {
    const c = l.split(',')
    return { timestamp: +c[h.indexOf('timestamp')], open: +c[h.indexOf('open')], high: +c[h.indexOf('high')], low: +c[h.indexOf('low')], close: +c[h.indexOf('close')], volume: +c[h.indexOf('volume')] }
  }).filter(x => x.timestamp > 0)
}

const SYMBOLS = defaultPaperUniverseSymbols().slice(0, 10)

async function main() {
  const root = join(import.meta.dirname ?? '.', '..')
  const dataDir = join(root, 'data/market/live_accumulated')
  const signals: any[] = []

  for (const sym of SYMBOLS) {
    const fn = sym.replace(/-/g, '_') + '_USDT_1m.csv'
    const candles = loadCsv(join(dataDir, fn))
    if (candles.length < 30) continue
    const r = evaluateVolumeBreakout(sym, candles, { volumeMultiplier: 1.2, rangeLookbackBars: 6, minBreakQuality: 0.05 })
    if (r.signal !== 0) {
      signals.push(r)
      console.log(`1m ${sym}: ${r.signal > 0 ? 'LONG' : 'SHORT'} vol=${r.volumeRatio.toFixed(1)}x break=${r.rangeBreakoutPct.toFixed(1)}% conf=${r.confidence.toFixed(3)}`)
    }
  }

  console.log(`\n1m breakouts: ${signals.length}/${SYMBOLS.length} symbols`)
  await writeJsonAtomic('data/runtime/breakout_1m.latest.json', {
    generatedAt: new Date().toISOString(),
    signalCount: signals.length,
    totalSymbols: SYMBOLS.length,
    signals: signals.map(s => ({ symbol: s.symbol, signal: s.signal, confidence: s.confidence, volumeRatio: s.volumeRatio, rangeBreakoutPct: s.rangeBreakoutPct })),
  })
}

main().catch(console.error)
