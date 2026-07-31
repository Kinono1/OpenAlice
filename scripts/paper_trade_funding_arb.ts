/**
 * Funding Rate Arbitrage Paper Trader.
 * Uses available funding history to detect arb opportunities.
 * Usage: npx tsx scripts/paper_trade_funding_arb.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateFundingArb } from '../src/domain/strategy/arbitrage/funding-arb.js'
import { evaluateFundingRateFactor } from '../src/domain/strategy/factors/funding-rate.js'
import { writeJsonAtomic } from '../src/runtime/atomic_write.js'

async function main() {
  const root = join(import.meta.dirname ?? '.', '..')
  const derivDir = join(root, 'data/research/derivatives_history')

  let totalSignal = 0
  let signalCount = 0
  const results: any[] = []

  for (const sym of ['BTC', 'ETH']) {
    const path = join(derivDir, `binance_${sym}_USDT_USDT_funding_history.json`)
    if (!existsSync(path)) continue
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    if (!Array.isArray(data) || data.length < 10) continue

    const rates = data.slice(-50).map((d: any) => d.fundingRate)
    const currentRate = rates[rates.length - 1]
    const avgRate = rates.reduce((a: number, b: number) => a + b, 0) / rates.length

    const arb = evaluateFundingArb(`${sym}/USDT:USDT`, currentRate, rates)
    results.push({ symbol: sym, currentRate, avgRate, arbSignal: arb.signal, arbConfidence: arb.confidence })
    totalSignal += (arb.signal ?? 0)
    signalCount++
    console.log(`${sym}: funding=${(currentRate*100).toFixed(4)}% avg=${(avgRate*100).toFixed(4)}% signal=${arb.signal?.toFixed(2)??'?'}`)
  }

  console.log(`\nFunding arb: ${signalCount} symbols, aggregate=${totalSignal.toFixed(2)}`)
  await writeJsonAtomic('data/runtime/funding_arb.latest.json', { generatedAt: new Date().toISOString(), symbols: signalCount, aggregateSignal: totalSignal, details: results })
  console.log('Saved: data/runtime/funding_arb.latest.json')
}

main().catch(console.error)
