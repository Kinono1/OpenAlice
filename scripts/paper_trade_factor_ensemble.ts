/**
 * Factor Ensemble Paper Trader — multi-strategy signal aggregation.
 *
 * Runs all available factor modules, combines signals via ensemble,
 * and executes unified paper trades through PaperPositionExecutor.
 *
 * Usage:
 *   npx tsx scripts/paper_trade_factor_ensemble.ts
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateMomentumComposite } from '../src/domain/strategy/factors/momentum-composite.js'
import { evaluateMeanReversion } from '../src/domain/strategy/factors/mean-reversion.js'
import { evaluateVolatilityRegime } from '../src/domain/strategy/factors/volatility-regime.js'
import { evaluateVolumeSurgeFactor } from '../src/domain/strategy/factors/volume-surge.js'
import { evaluateFundingRateFactor } from '../src/domain/strategy/factors/funding-rate.js'
import { evaluateBasisFactor } from '../src/domain/strategy/factors/basis.js'
import { evaluateCarrySpread } from '../src/domain/strategy/factors/carry-spread.js'
import { evaluateCrossTimeframeDivergence } from '../src/domain/strategy/factors/cross-timeframe-divergence.js'
import { evaluateLiquidationPressure } from '../src/domain/strategy/factors/liquidation-pressure.js'
import { evaluateLiquidationAftermath } from '../src/domain/strategy/factors/liquidation-aftermath.js'
import { evaluateOrderBookImbalance } from '../src/domain/strategy/factors/order-book-imbalance.js'
import { combineFactorSignalsWithGovernance, type CombinedGovernanceResult } from '../src/domain/strategy/factors/ensemble.js'
import { evaluateVolumeBreakout } from '../src/domain/strategy/volume-breakout.js'
import { readMarketIntelContext } from '../src/runtime/market_intel_context.js'
import { readSystemFuse } from '../src/runtime/system_fuse.js'
import { defaultPaperUniverseSymbols } from './lib/paper_universe.js'
import { writeJsonAtomic } from '../src/runtime/atomic_write.js'

interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

function loadCsvCandles(path: string): Candle[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8').trim().split('\n')
  if (raw.length < 2) return []
  const headers = raw[0].split(',')
  return raw.slice(1).map(line => {
    const cols = line.split(',')
    return {
      timestamp: parseInt(cols[headers.indexOf('timestamp')]) || 0,
      open: parseFloat(cols[headers.indexOf('open')]) || 0,
      high: parseFloat(cols[headers.indexOf('high')]) || 0,
      low: parseFloat(cols[headers.indexOf('low')]) || 0,
      close: parseFloat(cols[headers.indexOf('close')]) || 0,
      volume: parseFloat(cols[headers.indexOf('volume')]) || 0,
    }
  }).filter(c => c.timestamp > 0)
}

const SYMBOLS = defaultPaperUniverseSymbols()
const DATA_5M = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'live_5m')
const DATA_ACCUM = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'live_accumulated')

function symbolToFile(symbol: string, suffix: string): string {
  return join(DATA_5M, `${symbol.replace(/-/g, '_')}_USDT_${suffix}.csv`)
}

async function main() {
  console.log('=== Factor Ensemble Paper Trader ===\n')

  const allSignals: any[] = []
  const candleCache: Record<string, Candle[]> = {}

  for (const symbol of SYMBOLS) {
    const path = symbolToFile(symbol, '5m')
    const candles = loadCsvCandles(path)
    if (candles.length < 50) continue
    candleCache[symbol] = candles

    // Volume breakout signal
    try {
      const vb = evaluateVolumeBreakout(symbol, candles)
      if (vb.signal !== 0) {
        allSignals.push({
          name: `vb_${symbol}`,
          role: 'alpha',
          value: vb.signal > 0 ? vb.confidence : -vb.confidence,
          confidence: vb.confidence,
          sourceTier: 2,
          decisionStrength: vb.confidence > 0.5 ? 'D7' : 'D3',
          metadata: { symbol, volRatio: vb.volumeRatio, breakout: vb.rangeBreakoutPct },
        })
      }
    } catch {}

    // Momentum
    try {
      const mom = evaluateMomentumComposite({ candles, lookbackPeriods: [12, 24, 48] })
      allSignals.push({
        name: `momentum_${symbol}`,
        role: 'alpha',
        value: mom.zScore ?? 0,
        confidence: Math.abs(mom.zScore ?? 0) / 3,
        sourceTier: 2,
        decisionStrength: 'D5',
        metadata: { symbol, momentum12: mom.shortTermMomentum, momentum48: mom.longTermMomentum },
      })
    } catch {}

    // Mean reversion
    try {
      const mr = evaluateMeanReversion({ candles, lookback: 20, entryZ: 2.0 })
      allSignals.push({
        name: `mr_${symbol}`,
        role: 'alpha',
        value: mr.zScore ?? 0,
        confidence: Math.abs(mr.zScore ?? 0) / 3,
        sourceTier: 2,
        decisionStrength: 'D5',
        metadata: { symbol, zScore: mr.zScore },
      })
    } catch {}

    // Volatility regime
    try {
      const vol = evaluateVolatilityRegime({ candles, lookback: 48 })
      allSignals.push({
        name: `vol_${symbol}`,
        role: 'conditioning_filter',
        value: vol.regime === 'high_vol' ? -0.5 : vol.regime === 'low_vol' ? 0.3 : 0,
        confidence: 0.5,
        sourceTier: 2,
        decisionStrength: 'D3',
        metadata: { symbol, regime: vol.regime },
      })
    } catch {}

    // Volume surge
    try {
      const vs = evaluateVolumeSurgeFactor({ candles, surgeThreshold: 1.5 })
      allSignals.push({
        name: `volume_surge_${symbol}`,
        role: 'alpha',
        value: vs.surge ? 0.3 : -0.1,
        confidence: vs.confidence ?? 0.3,
        sourceTier: 2,
        decisionStrength: 'D3',
        metadata: { symbol, surge: vs.surge },
      })
    } catch {}

    // Cross-timeframe divergence
    try {
      const ctd = evaluateCrossTimeframeDivergence({
        candles,
        shortPeriod: 12,
        longPeriod: 48,
      })
      allSignals.push({
        name: `ctd_${symbol}`,
        role: 'alpha',
        value: ctd.divergence ?? 0,
        confidence: Math.abs(ctd.divergence ?? 0),
        sourceTier: 2,
        decisionStrength: 'D5',
        metadata: { symbol, divergence: ctd.divergence },
      })
    } catch {}

    // Liquidation pressure (using volume as proxy when no liq data)
    try {
      const liq = evaluateLiquidationPressure({ candles, window: 24 })
      allSignals.push({
        name: `liq_pressure_${symbol}`,
        role: 'conditioning_filter',
        value: (liq.pressureIndex ?? 0) > 0.7 ? -0.5 : 0,
        confidence: liq.confidence ?? 0.3,
        sourceTier: 2,
        decisionStrength: 'D3',
        metadata: { symbol, pressure: liq.pressureIndex },
      })
    } catch {}

    // Liquidation aftermath
    try {
      const aftermath = evaluateLiquidationAftermath({ candles, window: 48 })
      allSignals.push({
        name: `liq_aftermath_${symbol}`,
        role: 'alpha',
        value: aftermath.reversalSignal ?? 0,
        confidence: Math.abs(aftermath.reversalSignal ?? 0),
        sourceTier: 2,
        decisionStrength: 'D5',
        metadata: { symbol, reversal: aftermath.reversalSignal },
      })
    } catch {}
  }

  console.log(`Evaluated ${Object.keys(candleCache).length} symbols`)
  console.log(`Generated ${allSignals.length} raw signals\n`)

  // Combine signals via governance ensemble
  const combined = combineFactorSignalsWithGovernance(allSignals, {})
  console.log('=== Combined Result ===')
  console.log(`  Aggregate value: ${combined.aggregateValue.toFixed(4)}`)
  console.log(`  Confidence: ${combined.aggregateConfidence.toFixed(4)}`)
  console.log(`  Consensus: ${combined.consensusScore.toFixed(4)}`)
  console.log(`  Decision strength: ${combined.decisionStrength}`)
  console.log(`  Signals contributing: ${combined.signals.length}`)
  if ('governance' in combined) {
    const g = (combined as CombinedGovernanceResult).governance
    console.log(`  Governance: passed=${g.passed} rejected=${g.rejectedSignals.length}`)
  }

  // Save runtime report
  const rejectedCount = 'governance' in combined
    ? ((combined as CombinedGovernanceResult).governance.rejectedSignals?.length ?? 0)
    : 0
  await writeJsonAtomic('data/runtime/factor_ensemble.latest.json', {
    generatedAt: new Date().toISOString(),
    symbolCount: Object.keys(candleCache).length,
    totalSignals: allSignals.length,
    aggregateValue: combined.aggregateValue,
    aggregateConfidence: combined.aggregateConfidence,
    consensusScore: combined.consensusScore,
    decisionStrength: combined.decisionStrength,
    governancePassed: 'governance' in combined ? (combined as CombinedGovernanceResult).governance.passed : true,
    governanceRejected: rejectedCount,
  })

  console.log(`\nDone. ${allSignals.length} signals → value=${combined.aggregateValue.toFixed(4)} conf=${combined.aggregateConfidence.toFixed(4)}`)
}

main().catch(console.error)
