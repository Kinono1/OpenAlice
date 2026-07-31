/**
 * Pairs Trading / Cointegration Paper Trader.
 *
 * Pairs correlated symbols, tests cointegration, trades spread mean-reversion.
 * Usage: npx tsx scripts/paper_trade_pairs.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { testCointegration } from '../src/domain/strategy/arbitrage/cointegration.js'
import { evaluatePairsTrade } from '../src/domain/strategy/arbitrage/pairs-trading.js'
import { writeJsonAtomic } from '../src/runtime/atomic_write.js'

interface Candle { timestamp: number; close: number }
function loadCloses(path: string): number[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8').trim().split('\n')
  if (raw.length < 2) return []
  const h = raw[0].split(',')
  return raw.slice(1).map(l => +l.split(',')[h.indexOf('close')]).filter(v => v > 0)
}

const SYMBOLS = ['BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT','XRP-USDT','DOGE-USDT','ADA-USDT','AVAX-USDT','LINK-USDT','DOT-USDT']

async function main() {
  const root = join(import.meta.dirname ?? '.', '..')
  const dataDir = join(root, 'data/market/live_5m')
  const closes: Record<string, number[]> = {}
  for (const sym of SYMBOLS) {
    const f = join(dataDir, `${sym.replace(/-/g, '_')}_USDT_5m.csv`)
    const c = loadCloses(f)
    if (c.length > 100) closes[sym] = c.slice(-200)
  }
  console.log(`Loaded ${Object.keys(closes).length} symbols\n`)

  let tradeCount = 0
  const pairs: any[] = []
  const symbols = Object.keys(closes)

  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i], b = symbols[j]
      const len = Math.min(closes[a].length, closes[b].length)
      const pa = closes[a].slice(-len), pb = closes[b].slice(-len)

      const coint = testCointegration(pa, pb)
      if (!coint.isCointegrated) continue

      const trade = evaluatePairsTrade(a, b, pa, pb)
      tradeCount++

      const action = trade.signal > 0 ? `LONG ${b}/SHORT ${a}` : trade.signal < 0 ? `LONG ${a}/SHORT ${b}` : 'HOLD'
      console.log(`${a}/${b}: pval=${coint.pValue.toFixed(4)} hl=${coint.halfLife.toFixed(0)} z=${trade.spreadZScore.toFixed(2)} → ${action}`)
      pairs.push({ pair: `${a}/${b}`, pValue: coint.pValue, halfLife: coint.halfLife, zScore: trade.spreadZScore, signal: trade.signal, action })
    }
  }

  console.log(`\nPairs: ${pairs.length} cointegrated, ${tradeCount} signals`)
  await writeJsonAtomic('data/runtime/pairs_trading.latest.json', { generatedAt: new Date().toISOString(), pairs })
}

main().catch(console.error)
