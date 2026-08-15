/**
 * Panic Index Paper Trader — market fear/greed regime detection.
 *
 * Evaluates multi-component panic index, adjusts position sizing.
 * Usage: npx tsx scripts/paper_trade_panic_index.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { computePanicIndex } from '../src/domain/strategy/panic-index.js'
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

async function main() {
  const root = join(import.meta.dirname ?? '.', '..')
  const btc = loadCsv(join(root, 'data/market/live_5m/BTC_USDT_USDT_5m.csv'))
  if (btc.length < 100) { console.log('panic_index: insufficient BTC data'); return }

  const closes = btc.map(c => c.close)
  const volumes = btc.map(c => c.volume)
  const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i])
  const vol20 = Math.sqrt(returns.slice(-20).reduce((s, r) => s + r * r, 0) / 20) * Math.sqrt(365 * 24 * 12)
  const maxDrawdown = 1 - Math.min(...closes.slice(-48)) / Math.max(...closes.slice(-48))
  const btcVol = volumes.slice(-24).reduce((s, v) => s + v, 0) / 24
  const volSurge = volumes.slice(-48, -24).reduce((s, v) => s + v, 0) / 24
  const volumeRatio = btcVol / (volSurge || 1)

  const panicIndex = computePanicIndex({
    btcDrawdown: maxDrawdown,
    btcVolatility: vol20,
    volumeSpike: volumeRatio > 2,
    futuresBasis: 0,
    stablecoinFlow: 0,
    putCallRatio: 0.5,
  })

  const signal = {
    name: 'panic_index',
    role: 'conditioning_filter' as const,
    value: panicIndex.regime === 'extreme_fear' ? -0.8 : panicIndex.regime === 'fear' ? -0.3 : panicIndex.regime === 'greed' ? 0.3 : 0,
    confidence: 0.7,
    sourceTier: 2,
    decisionStrength: panicIndex.panicIndex > 80 ? 'D9' : panicIndex.panicIndex > 60 ? 'D7' : 'D3',
    metadata: { panicIndex: panicIndex.panicIndex, regime: panicIndex.regime },
  }

  console.log(`Panic Index: ${panicIndex.panicIndex.toFixed(1)} → ${panicIndex.regime}`)
  if (panicIndex.components) console.log(`  Components: btcDrawdown=${(panicIndex.components.btcDrawdown*100).toFixed(1)}% vol20=${(vol20*100).toFixed(2)}%`)

  await writeJsonAtomic('data/runtime/panic_index.latest.json', panicIndex)
  console.log('Saved: data/runtime/panic_index.latest.json')
}

main().catch(console.error)
