/**
 * Validate enhancedCarry, liquidationAftermath, and crossSectionalMomentum
 * on real market data with full statistical significance testing.
 *
 * Usage: npx tsx scripts/run_new_strategies_validation.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runStrategyBacktest } from '../src/backtest/strategy-validation/backtest.js'
import { runStrategyWalkForward } from '../src/backtest/wfo.js'
import { evaluateReleaseGate } from '../src/backtest/release_gate.js'
import { evaluateRiskSimulation } from '../src/backtest/risk_simulation.js'
import { evaluateSignificanceGate } from '../src/backtest/statistical_significance.js'
import { evaluateCrossSectionalMomentum } from '../src/domain/strategy/cross-sectional-momentum.js'
import type {
  MarketData,
  StrategyName,
  StrategyParams,
} from '../src/backtest/strategy-validation/types.js'
import { resolveStrategyParams } from '../src/backtest/strategy-validation/types.js'

interface CliArgs {
  dryRun: boolean
}

// ==================== Data Loading ====================

interface FundingHistoryEntry {
  timestamp: number
  fundingRate: number
}

async function loadCandles(csvPath: string): Promise<MarketData[]> {
  const raw = await readFile(csvPath, 'utf-8')
  const lines = raw.trim().split('\n')
  const header = lines[0].split(',')
  const timestampIdx = header.indexOf('timestamp')
  const openIdx = header.indexOf('open')
  const highIdx = header.indexOf('high')
  const lowIdx = header.indexOf('low')
  const closeIdx = header.indexOf('close')
  const volumeIdx = header.indexOf('volume')
  const symbolIdx = header.indexOf('symbol')

  return lines.slice(1).map(line => {
    const cols = line.split(',')
    return {
      symbol: cols[symbolIdx] ?? 'UNKNOWN',
      time: Number(cols[timestampIdx]),
      open: Number(cols[openIdx]),
      high: Number(cols[highIdx]),
      low: Number(cols[lowIdx]),
      close: Number(cols[closeIdx]),
      volume: Number(cols[volumeIdx]),
    }
  })
    .filter(c => [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) && c.time > 0)
    .sort((a, b) => a.time - b.time)
}

async function loadFundingHistory(jsonPath: string): Promise<FundingHistoryEntry[]> {
  const raw = await readFile(jsonPath, 'utf-8')
  return JSON.parse(raw)
}

function mergeFundingIntoOHLCV(candles: MarketData[], fundingHistory: FundingHistoryEntry[]): MarketData[] {
  const fundingByHour = new Map<number, number>()
  for (const f of fundingHistory) {
    const hourKey = f.timestamp - (f.timestamp % 3_600_000)
    fundingByHour.set(hourKey, f.fundingRate)
  }

  // Forward-fill: carry last known funding rate forward
  let lastFundingRate: number | undefined
  return candles.map(c => {
    const hourKey = c.time - (c.time % 3_600_000)
    const exact = fundingByHour.get(hourKey)
    if (exact !== undefined) {
      lastFundingRate = exact
      return { ...c, fundingRate: exact }
    }
    return { ...c, fundingRate: lastFundingRate }
  })
}

// ==================== Validation Runner ====================

interface StrategyValidationResult {
  trialId: string
  candidateId: string
  strategy: StrategyName
  symbol: string
  diagnosticOnly: true
  promotionEligible: false
  includedInFdr: false
  includedInEffectiveM: false
  fdrReportStatus: 'excluded_from_fdr'
  fdrPValuesAvailable: false
  fdrMissingPValueCount: 1
  fdrPValueBlockedReason: 'new_strategy_validation_diagnostic_only_not_complete_trial_universe'
  fdrPValueIsPromotionGrade: false
  fdrExclusionReason: 'new_strategy_validation_diagnostic_only_not_complete_trial_universe'
  pitAuditStatus: 'not_implemented'
  pitAuditPromotionGrade: false
  failureCodes: []
  barCount: number
  dateRange: { start: string; end: string }
  trades: number
  winRate: number
  totalReturnPct: number
  annualizedReturnPct: number
  sharpe: number
  sortino: number
  maxDrawdownPct: number
  netExpectancyPct: number
  costDragPct: number
  wfo?: {
    passed: boolean
    degradationRate: number
    passedWindows: number
    totalWindows: number
  }
  pbo?: number
  dsr?: number
  releaseGateResult?: string
  riskSimulation?: {
    profitProbability: number
    riskOfRuin: number
  }
}

async function validateStrategy(
  strategy: StrategyName,
  candles: MarketData[],
  symbol: string,
  params: StrategyParams = {},
): Promise<StrategyValidationResult> {
  const resolved = resolveStrategyParams(params)

  console.log(`\n=== Validating ${strategy} on ${symbol} ===`)
  console.log(`Candles: ${candles.length}, Date range: ${new Date(candles[0].time).toISOString()} — ${new Date(candles[candles.length - 1].time).toISOString()}`)

  // Run single backtest
  const backtest = runStrategyBacktest({
    candles,
    strategy,
    params: resolved,
    costModel: { feeRate: 0.0005, slippageBps: 3, latencyBars: 1, fundingRatePer8h: 0.0001 },
  })

  const tradeCount = backtest.trades.length
  const winRate = tradeCount > 0
    ? backtest.trades.filter(t => t.netReturnPct > 0).length / tradeCount * 100
    : 0
  const totalCostDrag = tradeCount > 0
    ? backtest.trades.reduce((s, t) => s + t.totalCostPct, 0) / tradeCount
    : 0

  console.log(`Trades: ${tradeCount}`)
  console.log(`Win Rate: ${winRate.toFixed(1)}%`)
  console.log(`Total Return: ${(backtest.metrics.totalReturnPct).toFixed(2)}%`)
  console.log(`Annualized Return: ${(backtest.metrics.annualizedReturnPct).toFixed(2)}%`)
  console.log(`Sharpe: ${(backtest.metrics.sharpe).toFixed(3)}`)
  console.log(`Sortino: ${(backtest.metrics.sortino).toFixed(3)}`)
  console.log(`Max Drawdown: ${(backtest.metrics.maxDrawdownPct).toFixed(2)}%`)
  console.log(`Net Expectancy: ${(backtest.metrics.netExpectancyPct * 100).toFixed(3)}%`)
  console.log(`Cost Drag/Trade: ${(totalCostDrag * 100).toFixed(3)}%`)

  // Run WFO
  let wfoResult: StrategyValidationResult['wfo'] | undefined
  try {
    const wfo = runStrategyWalkForward({
      candles,
      strategy,
      params: resolved,
      config: {
        trainBars: Math.floor(candles.length * 0.6),
        testBars: Math.floor(candles.length * 0.2),
        stepBars: Math.floor(candles.length * 0.2),
        degradationThreshold: 0.4,
        minTradesPerWindow: 3,
        embargoBars: 24,
      },
    })
    const passedWindows = wfo.windows.filter(w => w.passed).length
    wfoResult = {
      passed: wfo.passed,
      degradationRate: wfo.windows.length > 0
        ? wfo.windows.reduce((s, w) => s + w.degradation, 0) / wfo.windows.length
        : 0,
      passedWindows,
      totalWindows: wfo.windows.length,
    }
    console.log(`WFO: ${wfoResult.passed ? 'PASSED' : 'FAILED'} (${passedWindows}/${wfo.windows.length} windows, avg degradation ${(wfoResult.degradationRate * 100).toFixed(1)}%)`)
  } catch (err) {
    console.log(`WFO: skipped (${err instanceof Error ? err.message : err})`)
  }

  // Run significance
  let pbo: number | undefined
  let dsr: number | undefined
  try {
    const sig = evaluateSignificanceGate({
      strategy,
      equityCurve: backtest.equityCurve.map(e => e.equity),
      sharpe: backtest.metrics.sharpe,
      sortino: backtest.metrics.sortino,
      trades: backtest.trades.map(t => ({
        returnPct: t.netReturnPct,
        holdingBars: t.holdingBars,
      })),
      totalTrades: tradeCount,
      candidateCount: 9, // 9 strategies in the family
    })
    pbo = sig.pbo
    dsr = sig.dsr
    console.log(`PBO: ${(pbo * 100).toFixed(1)}%, DSR: ${(dsr * 100).toFixed(1)}%`)
  } catch (err) {
    console.log(`Significance: skipped`)
  }

  // Run risk simulation
  let riskSim: StrategyValidationResult['riskSimulation'] | undefined
  try {
    const sim = evaluateRiskSimulation({
      equityCurve: backtest.equityCurve.map(e => e.equity),
      method: 'iid_bootstrap',
      simulations: 1000,
    })
    riskSim = {
      profitProbability: sim.profitProbability,
      riskOfRuin: sim.riskOfRuin,
    }
    console.log(`Profit Prob: ${(sim.profitProbability * 100).toFixed(1)}%, Risk of Ruin: ${(sim.riskOfRuin * 100).toFixed(1)}%`)
  } catch (err) {
    console.log(`Risk Simulation: skipped`)
  }

  return {
    trialId: `new_strategy_validation:${strategy}:${symbol}:${candles[0].time}:${candles[candles.length - 1].time}`,
    candidateId: `${strategy}_${symbol}`.replace(/[^A-Za-z0-9_:-]/g, '_'),
    strategy,
    symbol,
    diagnosticOnly: true,
    promotionEligible: false,
    includedInFdr: false,
    includedInEffectiveM: false,
    fdrReportStatus: 'excluded_from_fdr',
    fdrPValuesAvailable: false,
    fdrMissingPValueCount: 1,
    fdrPValueBlockedReason: 'new_strategy_validation_diagnostic_only_not_complete_trial_universe',
    fdrPValueIsPromotionGrade: false,
    fdrExclusionReason: 'new_strategy_validation_diagnostic_only_not_complete_trial_universe',
    pitAuditStatus: 'not_implemented',
    pitAuditPromotionGrade: false,
    failureCodes: [],
    barCount: candles.length,
    dateRange: {
      start: new Date(candles[0].time).toISOString(),
      end: new Date(candles[candles.length - 1].time).toISOString(),
    },
    trades: tradeCount,
    winRate,
    totalReturnPct: backtest.metrics.totalReturnPct,
    annualizedReturnPct: backtest.metrics.annualizedReturnPct,
    sharpe: backtest.metrics.sharpe,
    sortino: backtest.metrics.sortino,
    maxDrawdownPct: backtest.metrics.maxDrawdownPct,
    netExpectancyPct: backtest.metrics.netExpectancyPct,
    costDragPct: totalCostDrag,
    wfo: wfoResult,
    pbo,
    dsr,
    riskSimulation: riskSim,
  }
}

// ==================== Cross-Sectional Momentum Validation ====================

interface CrossSectionalValidationResult {
  totalPeriods: number
  averageRankSpread: number
  topReturnPct: number
  bottomReturnPct: number
  spreadReturnPct: number
  winRate: number
}

async function validateCrossSectionalMomentum(
  btcCandles: MarketData[],
  ethCandles: MarketData[],
): Promise<CrossSectionalValidationResult> {
  console.log('\n=== Validating Cross-Sectional Momentum ===')

  const lookbackHours = 168 // 7 days
  let correctPredictions = 0
  let totalPredictions = 0
  let topCumulativeReturn = 0
  let bottomCumulativeReturn = 0

  let debugOnce = true
  for (let i = lookbackHours + 1; i < Math.min(btcCandles.length, ethCandles.length); i++) {
    const btcReturn = btcCandles[i].close / btcCandles[i - lookbackHours].close - 1
    const ethReturn = ethCandles[i].close / ethCandles[i - lookbackHours].close - 1

    const btcVol = computeRollingVol(btcCandles, i, 24)
    const ethVol = computeRollingVol(ethCandles, i, 24)

    const assets = [
      {
        symbol: 'BTC-USDT',
        currentPrice: btcCandles[i].close,
        returns: { [`${lookbackHours}h`]: btcReturn * 100 },
        realizedVolPct: btcVol,
        avgVolume24h: btcCandles[i].volume,
      },
      {
        symbol: 'ETH-USDT',
        currentPrice: ethCandles[i].close,
        returns: { [`${lookbackHours}h`]: ethReturn * 100 },
        realizedVolPct: ethVol,
        avgVolume24h: ethCandles[i].volume,
      },
    ]

    const ranks = evaluateCrossSectionalMomentum(assets, {
      lookbackHours,
      topN: 1,
      bottomN: 1,
      minUniverseSize: 2,
      maxVolPercentile: 0.99,
    })

    const topAsset = ranks.find(r => r.signal === 1)
    const bottomAsset = ranks.find(r => r.signal === -1)

    if (debugOnce && !topAsset && !bottomAsset) {
      console.log(`CS debug i=${i}: btcVol=${btcVol.toFixed(1)} ethVol=${ethVol.toFixed(1)} btcRet=${(btcReturn*100).toFixed(1)}% ethRet=${(ethReturn*100).toFixed(1)}%`)
      console.log(`  ranks: ${JSON.stringify(ranks.map(r => ({s: r.symbol, sig: r.signal, r: r.rank})))}}`)
      console.log(`  eligible check: ${btcVol < 85}=${btcVol < 85} ${ethVol < 85}=${ethVol < 85}`)
      debugOnce = false
    }

    if (topAsset && bottomAsset) {
      totalPredictions++
      // Forward return: next 24h return after the signal
      const fwdIdx = Math.min(i + 24, btcCandles.length - 1, ethCandles.length - 1)
      const btcFwdReturn = (btcCandles[fwdIdx].close / btcCandles[i].close - 1) * 100
      const ethFwdReturn = (ethCandles[fwdIdx].close / ethCandles[i].close - 1) * 100

      const topFwdReturn = topAsset.symbol === 'BTC-USDT' ? btcFwdReturn : ethFwdReturn
      const bottomFwdReturn = bottomAsset.symbol === 'BTC-USDT' ? btcFwdReturn : ethFwdReturn

      if (topFwdReturn > bottomFwdReturn) {
        correctPredictions++
      }

      topCumulativeReturn += topFwdReturn
      bottomCumulativeReturn += bottomFwdReturn
    }
  }

  const winRate = totalPredictions > 0 ? correctPredictions / totalPredictions * 100 : 0

  console.log(`Total signals: ${totalPredictions}`)
  console.log(`Win rate (top > bottom): ${winRate.toFixed(1)}%`)
  console.log(`Top cumulative return: ${topCumulativeReturn.toFixed(2)}%`)
  console.log(`Bottom cumulative return: ${bottomCumulativeReturn.toFixed(2)}%`)
  console.log(`Spread: ${(topCumulativeReturn - bottomCumulativeReturn).toFixed(2)}%`)

  return {
    totalPeriods: totalPredictions,
    averageRankSpread: 0,
    topReturnPct: topCumulativeReturn,
    bottomReturnPct: bottomCumulativeReturn,
    spreadReturnPct: topCumulativeReturn - bottomCumulativeReturn,
    winRate,
  }
}

function computeRollingVol(candles: MarketData[], index: number, lookback: number): number {
  const start = Math.max(0, index - lookback)
  const returns: number[] = []
  for (let i = start + 1; i <= index; i++) {
    if (candles[i - 1].close > 0) {
      returns.push(candles[i].close / candles[i - 1].close - 1)
    }
  }
  if (returns.length < 2) return 50
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance * 365 * 24) * 100
}

// ==================== Main ====================

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: 'new_strategies_validation',
      command: 'run_new_strategies_validation',
      executionMode: {
        dryRun: true,
        writesResearchArtifacts: false,
        promotionEligible: false,
      },
      artifactPolicy: {
        diagnosticOnly: true,
        includedInFdr: false,
      },
      optIn: {
        runValidation: '--dryRun false',
      },
    }, null, 2))
    return
  }

  const dataDir = join(import.meta.dirname, '..', 'data', 'market', 'gate')
  const fundingDir = join(import.meta.dirname, '..', 'data', 'research', 'derivatives_history')
  const outputDir = join(import.meta.dirname, '..', 'data', 'research', 'new_strategies_validation')

  await mkdir(outputDir, { recursive: true })

  // Load data
  console.log('Loading data...')
  const btcCandles = await loadCandles(join(dataDir, 'BTC_USDT_USDT_1h.csv'))
  const ethCandles = await loadCandles(join(dataDir, 'ETH_USDT_USDT_1h.csv'))

  let ethFundingHistory: FundingHistoryEntry[] = []
  try {
    ethFundingHistory = await loadFundingHistory(
      join(fundingDir, 'binance_ETH_USDT_USDT_funding_history.json'),
    )
    console.log(`Loaded ${ethFundingHistory.length} funding rate entries`)
  } catch {
    console.log('No funding history found, enhancedCarry will skip bars without fundingRate')
  }

  const ethWithFunding = mergeFundingIntoOHLCV(ethCandles, ethFundingHistory)
  const fundedBars = ethWithFunding.filter(c => typeof c.fundingRate === 'number').length
  console.log(`ETH candles: ${ethCandles.length}, with funding: ${fundedBars}`)

  const results: StrategyValidationResult[] = []

  // Validate each strategy
  results.push(await validateStrategy('liquidationAftermath', btcCandles, 'BTC-USDT', {
    cascadeMinVolSurge: 6.0,
    cascadeMinDropPct: 3.0,
    cascadeStopLossPct: 0.03,
    cascadeMaxHoldingBars: 12,
  }))
  results.push(await validateStrategy('liquidationAftermath', ethCandles, 'ETH-USDT', {
    cascadeMinVolSurge: 6.0,
    cascadeMinDropPct: 3.0,
    cascadeStopLossPct: 0.03,
    cascadeMaxHoldingBars: 12,
  }))

  if (fundedBars > 60) {
    results.push(await validateStrategy('enhancedCarry', ethWithFunding, 'ETH-USDT', {
      carryZEntry: 2.5,
      carryZExit: 0.3,
      carryMinFundingBars: 48,
      carryMaxHoldingBars: 72,
      carryStopLossPct: 0.10,
    }))
  } else {
    console.log('\n=== Skipping enhancedCarry: insufficient funding rate data ===')
  }

  // Cross-sectional momentum
  const csResult = await validateCrossSectionalMomentum(btcCandles, ethCandles)

  // Output summary
  console.log('\n\n========================================')
  console.log('        VALIDATION SUMMARY')
  console.log('========================================\n')

  for (const r of results) {
    const verdict = r.netExpectancyPct > 0 && r.wfo?.passed && (r.pbo ?? 1) < 0.1
      ? 'PROMOTE'
      : r.netExpectancyPct > 0 ? 'WATCH' : 'FAIL'
    console.log(`${verdict} | ${r.strategy} ${r.symbol}`)
    console.log(`  Return: ${r.totalReturnPct.toFixed(1)}% | Sharpe: ${r.sharpe.toFixed(2)} | DD: ${r.maxDrawdownPct.toFixed(1)}%`)
    console.log(`  Expectancy: ${(r.netExpectancyPct * 100).toFixed(3)}% | Win: ${r.winRate.toFixed(0)}% | Trades: ${r.trades}`)
    if (r.wfo) console.log(`  WFO: ${r.wfo.passedWindows}/${r.wfo.totalWindows} windows, degradation ${(r.wfo.degradationRate * 100).toFixed(1)}%`)
    if (r.pbo !== undefined) console.log(`  PBO: ${(r.pbo * 100).toFixed(1)}%`)
    if (r.dsr !== undefined) console.log(`  DSR: ${(r.dsr * 100).toFixed(1)}%`)
    console.log()
  }

  console.log(`Cross-Sectional Momentum (BTC vs ETH, 7d):`)
  console.log(`  Signals: ${csResult.totalPeriods} | Win Rate: ${csResult.winRate.toFixed(1)}%`)
  console.log(`  Top Return: ${csResult.topReturnPct.toFixed(1)}% | Bottom Return: ${csResult.bottomReturnPct.toFixed(1)}%`)
  console.log(`  Spread: ${csResult.spreadReturnPct.toFixed(1)}%`)

  // Save results
  const output = {
    generatedAt: new Date().toISOString(),
    strategies: results,
    crossSectionalMomentum: csResult,
  }
  await writeFile(
    join(outputDir, `validation_${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    JSON.stringify(output, null, 2),
  )
  console.log(`\nResults saved to ${outputDir}`)
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
