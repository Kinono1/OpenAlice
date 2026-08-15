/**
 * Range Scalper — trades when price is at extremes of recent range.
 * More frequent trades than breakout strategy.
 * Usage: npx tsx scripts/paper_trade_range_scalper.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from '../src/runtime/atomic_write.js'
import { defaultPaperUniverseSymbols } from './lib/paper_universe.js'

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

const SYMBOLS = defaultPaperUniverseSymbols()

async function main() {
  const root = join(import.meta.dirname ?? '.', '..')
  const dataDir = join(root, 'data/market/live_5m')
  const signals: any[] = []

  for (const sym of SYMBOLS) {
    const fn = sym.replace(/-/g, '_') + '_USDT_5m.csv'
    const candles = loadCsv(join(dataDir, fn))
    if (candles.length < 20) continue

    const close = candles[candles.length - 1].close
    const lookback = 8  // 40 min range
    const recent = candles.slice(-lookback)
    const high = Math.max(...recent.map(c => c.high))
    const low = Math.min(...recent.map(c => c.low))
    const mid = (high + low) / 2
    const range = high - low
    if (range <= 0) continue
    
    const pos = (close - low) / range  // 0=bottom, 1=top
    const vol = candles[candles.length - 1].volume
    const avgVol = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20
    const volRatio = vol / avgVol

    // Buy near bottom, sell near top
    if (pos < 0.15 && volRatio > 0.5) {
      signals.push({ symbol: sym, signal: 1, reason: `range_low pos=${pos.toFixed(2)}`, confidence: (1 - pos) * 0.5 })
      console.log(`${sym}: LONG  at range bottom (pos=${(pos*100).toFixed(0)}%)`)
    } else if (pos > 0.85 && volRatio > 0.5) {
      signals.push({ symbol: sym, signal: -1, reason: `range_high pos=${pos.toFixed(2)}`, confidence: pos * 0.5 })
      console.log(`${sym}: SHORT at range top (pos=${(pos*100).toFixed(0)}%)`)
    }
  }

  console.log(`\nRange scalper: ${signals.length}/${SYMBOLS.length} signals`)
  await writeJsonAtomic('data/runtime/range_scalper.latest.json', {
    generatedAt: new Date().toISOString(), signalCount: signals.length, signals,
  })
}

main().catch(console.error)
