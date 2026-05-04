/**
 * Deep risk analysis: drawdowns, tail events, extreme moves, regime breakdown.
 * Runs enhancedCarry, liquidationAftermath, and crossSectionalReversal
 * with full risk metrics and equity curve visualization data.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runStrategyBacktest } from '../src/backtest/strategy-validation/backtest.js'
import { evaluateCrossSectionalMomentum } from '../src/domain/strategy/cross-sectional-momentum.js'
import type { MarketData, StrategyName } from '../src/backtest/strategy-validation/types.js'
import { resolveStrategyParams } from '../src/backtest/strategy-validation/types.js'

interface CliArgs {
  dryRun: boolean
}

// ==================== Data Loading ====================

async function loadCandles(csvPath: string): Promise<MarketData[]> {
  const raw = await readFile(csvPath, 'utf-8')
  const lines = raw.trim().split('\n')
  const header = lines[0].split(',')
  const ti = header.indexOf('timestamp'); const oi = header.indexOf('open')
  const hi = header.indexOf('high'); const li = header.indexOf('low')
  const ci = header.indexOf('close'); const vi = header.indexOf('volume')
  const si = header.indexOf('symbol')

  return lines.slice(1).map(line => {
    const c = line.split(',')
    return { symbol: c[si] ?? '?', time: Number(c[ti]), open: Number(c[oi]), high: Number(c[hi]), low: Number(c[li]), close: Number(c[ci]), volume: Number(c[vi]) }
  }).filter(c => Number.isFinite(c.close) && c.time > 0)
}

async function loadFundingHistory(jsonPath: string): Promise<Array<{ timestamp: number; fundingRate: number }>> {
  return JSON.parse(await readFile(jsonPath, 'utf-8'))
}

function mergeFunding(candles: MarketData[], funding: Array<{ timestamp: number; fundingRate: number }>): MarketData[] {
  const map = new Map<number, number>()
  for (const f of funding) map.set(f.timestamp - (f.timestamp % 3_600_000), f.fundingRate)
  let last: number | undefined
  return candles.map(c => {
    const k = c.time - (c.time % 3_600_000)
    const v = map.get(k)
    if (v !== undefined) last = v
    return { ...c, fundingRate: last }
  })
}

// ==================== Risk Metrics ====================

interface RiskAnalysis {
  strategyName: string
  symbol: string

  // Basic
  trades: number
  totalReturnPct: number
  winRate: number

  // Drawdown analysis
  maxDrawdownPct: number
  maxDrawdownDuration: number  // bars
  avgDrawdownPct: number
  drawdownsOver5Pct: number
  drawdownsOver10Pct: number
  worstDrawdownStart: string
  worstDrawdownEnd: string

  // Extreme moves
  bestTradePct: number
  worstTradePct: number
  bestTradeDate: string
  worstTradeDate: string
  avgWinPct: number
  avgLossPct: number
  payoffRatio: number

  // Tail risk
  var95Pct: number  // 95% VaR per trade
  var99Pct: number  // 99% VaR per trade
  cvar95Pct: number // CVaR (expected shortfall)
  maxConsecutiveLosses: number
  maxConsecutiveWins: number
  worstDrawdownTrades: number // consecutive losing streak PnL

  // Regime analysis
  bullMarketTrades: number
  bearMarketTrades: number
  bullWinRate: number
  bearWinRate: number
  bullNetReturn: number
  bearNetReturn: number

  // Equity curve (sampled)
  equityCurve: Array<{ date: string; equity: number; drawdownPct: number }>
}

interface CrossSectionalRiskAnalysis {
  totalSignals: number
  winRate: number
  spreadCumulative: number
  maxDrawdownPct: number
  worstNSignals: { n: number; return: number }
  bestNSignals: { n: number; return: number }
  var95Pct: number
  cvar95Pct: number
  bullWinRate: number
  bearWinRate: number
  equityCurve: Array<{ date: string; equity: number; drawdownPct: number }>
}

// ==================== Risk Analyzers ====================

function computeRollingVol(candles: MarketData[], index: number, lookback: number): number {
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

function detectMarketRegime(candles: MarketData[], index: number): 'bull' | 'bear' | 'range' {
  const sma20 = candles.slice(Math.max(0, index - 480), index + 1).reduce((s, c) => s + c.close, 0) / Math.min(480, index + 1)
  const sma50 = candles.slice(Math.max(0, index - 1200), index + 1).reduce((s, c) => s + c.close, 0) / Math.min(1200, index + 1)
  const price = candles[index].close
  const maRatio20 = price / sma20
  const maRatio50 = price / sma50
  if (maRatio20 > 1.05 && maRatio50 > 1.03) return 'bull'
  if (maRatio20 < 0.95 || maRatio50 < 0.97) return 'bear'
  return 'range'
}

function analyzeTradeRisk(trades: Array<{ netReturnPct: number; entryTime: number; exitTime: number; entryRegime: string }>, candles: MarketData[]): RiskAnalysis['var95Pct' | 'var99Pct' | 'cvar95Pct' | 'maxConsecutiveLosses' | 'maxConsecutiveWins' | 'worstDrawdownTrades'] & Pick<RiskAnalysis, 'bestTradePct' | 'worstTradePct' | 'bestTradeDate' | 'worstTradeDate' | 'avgWinPct' | 'avgLossPct' | 'payoffRatio'> {
  const returns = trades.map(t => t.netReturnPct * 100) // convert to %
  const sorted = [...returns].sort((a, b) => a - b)

  // Wins and losses analysis
  const wins = trades.filter(t => t.netReturnPct > 0)
  const losses = trades.filter(t => t.netReturnPct < 0)
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netReturnPct, 0) / wins.length * 100 : 0
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netReturnPct, 0) / losses.length * 100 : 0
  const payoff = Math.abs(avgLoss) > 0 ? Math.abs(avgWin / avgLoss) : 0

  // Best/worst trades
  const bestIdx = returns.indexOf(Math.max(...returns))
  const worstIdx = returns.indexOf(Math.min(...returns))

  // VaR and CVaR
  const var95 = sorted[Math.floor(sorted.length * 0.05)] ?? 0
  const var99 = sorted[Math.floor(sorted.length * 0.01)] ?? 0
  const cvar95 = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.05))).reduce((s, v) => s + v, 0) / Math.max(1, Math.floor(sorted.length * 0.05))

  // Consecutive losses/wins
  let maxConsecLosses = 0; let maxConsecWins = 0
  let currentLossStreak = 0; let currentWinStreak = 0
  let worstLossStreakPnl = 0; let currentLossStreakPnl = 0
  for (const r of returns) {
    if (r < 0) {
      currentLossStreak++
      currentWinStreak = 0
      currentLossStreakPnl += r
      if (currentLossStreak > maxConsecLosses) {
        maxConsecLosses = currentLossStreak
        worstLossStreakPnl = currentLossStreakPnl
      }
    } else if (r > 0) {
      currentWinStreak++
      currentLossStreak = 0
      currentLossStreakPnl = 0
      if (currentWinStreak > maxConsecWins) maxConsecWins = currentWinStreak
    } else {
      currentLossStreak = 0
      currentWinStreak = 0
      currentLossStreakPnl = 0
    }
  }

  return {
    bestTradePct: Math.max(...returns),
    worstTradePct: Math.min(...returns),
    bestTradeDate: new Date(trades[bestIdx]?.entryTime ?? 0).toISOString(),
    worstTradeDate: new Date(trades[worstIdx]?.entryTime ?? 0).toISOString(),
    avgWinPct: avgWin,
    avgLossPct: avgLoss,
    payoffRatio: payoff,
    var95Pct: var95,
    var99Pct: var99,
    cvar95Pct: cvar95,
    maxConsecutiveLosses: maxConsecLosses,
    maxConsecutiveWins: maxConsecWins,
    worstDrawdownTrades: worstLossStreakPnl,
  }
}

function analyzeDrawdowns(equityCurve: Array<{ time: number; equity: number }>, candles: MarketData[]): Pick<RiskAnalysis, 'maxDrawdownPct' | 'maxDrawdownDuration' | 'avgDrawdownPct' | 'drawdownsOver5Pct' | 'drawdownsOver10Pct' | 'worstDrawdownStart' | 'worstDrawdownEnd'> {
  let peak = equityCurve[0].equity
  let maxDD = 0; let maxDDDuration = 0; let currentDDDuration = 0
  let worstStart = equityCurve[0].time; let worstEnd = equityCurve[0].time
  let ddSum = 0; let ddCount = 0
  let ddOver5 = 0; let ddOver10 = 0
  let inDD = false; let ddStart = equityCurve[0].time
  let currentPeak = peak

  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity
      if (inDD) {
        const dd = (peak - currentPeak) / peak * 100
        if (dd > 5) ddOver5++
        if (dd > 10) ddOver10++
        ddSum += dd
        ddCount++
      }
      inDD = false
      currentDDDuration = 0
    } else {
      if (!inDD) {
        inDD = true
        ddStart = point.time
        currentPeak = peak
      }
      currentDDDuration++
      const dd = (peak - point.equity) / peak * 100
      if (dd > maxDD) {
        maxDD = dd
        worstStart = ddStart
        worstEnd = point.time
      }
      if (currentDDDuration > maxDDDuration) {
        maxDDDuration = currentDDDuration
      }
    }
  }

  return {
    maxDrawdownPct: maxDD,
    maxDrawdownDuration: maxDDDuration,
    avgDrawdownPct: ddCount > 0 ? ddSum / ddCount : 0,
    drawdownsOver5Pct: ddOver5,
    drawdownsOver10Pct: ddOver10,
    worstDrawdownStart: new Date(worstStart).toISOString(),
    worstDrawdownEnd: new Date(worstEnd).toISOString(),
  }
}

// ==================== Main Analysis ====================

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: 'risk_deep_analysis',
      command: 'run_risk_deep_analysis',
      executionMode: {
        dryRun: true,
        writesResearchArtifacts: false,
        promotionEligible: false,
      },
      artifactPolicy: {
        diagnosticOnly: true,
      },
      optIn: {
        runAnalysis: '--dryRun false',
      },
    }, null, 2))
    return
  }

  const dataDir = join(import.meta.dirname, '..', 'data', 'market', 'gate')
  const fundingDir = join(import.meta.dirname, '..', 'data', 'research', 'derivatives_history')

  console.log('Loading data...')
  const btcRaw = await loadCandles(join(dataDir, 'BTC_USDT_USDT_1h.csv'))
  const ethRaw = await loadCandles(join(dataDir, 'ETH_USDT_USDT_1h.csv'))

  let fundingHistory: Array<{ timestamp: number; fundingRate: number }> = []
  try { fundingHistory = await loadFundingHistory(join(fundingDir, 'binance_ETH_USDT_USDT_funding_history.json')) } catch {}

  const ethCandles = mergeFunding(ethRaw, fundingHistory)
  const btcCandles = [...btcRaw]

  console.log(`BTC: ${btcCandles.length} bars, ETH: ${ethCandles.length} bars (${ethCandles.filter(c => c.fundingRate !== undefined).length} with funding)\n`)

  const analyses: RiskAnalysis[] = []

  // ====== Liquidation Aftermath ======
  for (const { symbol, candles } of [{ symbol: 'BTC-USDT', candles: btcCandles }, { symbol: 'ETH-USDT', candles: ethCandles }]) {
    console.log(`=== Analyzing liquidationAftermath on ${symbol} ===`)

    const backtest = runStrategyBacktest({
      candles,
      strategy: 'liquidationAftermath',
      params: resolveStrategyParams({
        cascadeMinVolSurge: 6.0,
        cascadeMinDropPct: 3.0,
        cascadeStopLossPct: 0.03,
        cascadeMaxHoldingBars: 12,
      }),
      costModel: { feeRate: 0.0005, slippageBps: 3, latencyBars: 1, fundingRatePer8h: 0.0001 },
    })

    const risk = analyzeTradeRisk(
      backtest.trades.map(t => ({ netReturnPct: t.netReturnPct, entryTime: t.entryTime, exitTime: t.exitTime, entryRegime: t.entryRegime })),
      candles,
    )
    const dd = analyzeDrawdowns(backtest.equityCurve, candles)

    // Regime analysis
    let bullTrades = 0; let bearTrades = 0
    let bullWins = 0; let bearWins = 0
    let bullNet = 0; let bearNet = 0
    for (const trade of backtest.trades) {
      const regime = detectMarketRegime(candles, Math.floor(trade.entryTime / 3_600_000) % candles.length)
      if (regime === 'bull') { bullTrades++; if (trade.netReturnPct > 0) bullWins++; bullNet += trade.netReturnPct }
      if (regime === 'bear') { bearTrades++; if (trade.netReturnPct > 0) bearWins++; bearNet += trade.netReturnPct }
    }

    const equityCurve = backtest.equityCurve.map((p, i) => {
      let peak = backtest.equityCurve[0].equity
      for (let j = 1; j <= i; j++) peak = Math.max(peak, backtest.equityCurve[j].equity)
      return {
        date: new Date(p.time).toISOString().slice(0, 10),
        equity: p.equity,
        drawdownPct: peak > 0 ? (peak - p.equity) / peak * 100 : 0,
      }
    })

    const eq = equityCurve.filter((_, i) => i % 72 === 0 || i === equityCurve.length - 1) // Sample every 3 days

    analyses.push({
      strategyName: 'liquidationAftermath',
      symbol,
      trades: backtest.trades.length,
      totalReturnPct: backtest.metrics.totalReturnPct,
      winRate: backtest.trades.length > 0 ? backtest.trades.filter(t => t.netReturnPct > 0).length / backtest.trades.length * 100 : 0,
      ...dd,
      ...risk,
      bullMarketTrades: bullTrades,
      bearMarketTrades: bearTrades,
      bullWinRate: bullTrades > 0 ? bullWins / bullTrades * 100 : 0,
      bearWinRate: bearTrades > 0 ? bearWins / bearTrades * 100 : 0,
      bullNetReturn: bullNet * 100,
      bearNetReturn: bearNet * 100,
      equityCurve: eq,
    })
  }

  // ====== Enhanced Carry ======
  console.log('\n=== Analyzing enhancedCarry on ETH-USDT ===')
  const carryBacktest = runStrategyBacktest({
    candles: ethCandles,
    strategy: 'enhancedCarry',
    params: resolveStrategyParams({
      carryZEntry: 2.5,
      carryZExit: 0.3,
      carryMinFundingBars: 48,
      carryMaxHoldingBars: 72,
      carryStopLossPct: 0.08,
    }),
    costModel: { feeRate: 0.0005, slippageBps: 3, latencyBars: 1, fundingRatePer8h: 0.0001 },
  })

  const carryRisk = analyzeTradeRisk(
    carryBacktest.trades.map(t => ({ netReturnPct: t.netReturnPct, entryTime: t.entryTime, exitTime: t.exitTime, entryRegime: t.entryRegime })),
    ethCandles,
  )
  const carryDD = analyzeDrawdowns(carryBacktest.equityCurve, ethCandles)

  let carryBull = 0; let carryBear = 0; let carryBullWin = 0; let carryBearWin = 0
  let carryBullNet = 0; let carryBearNet = 0
  for (const trade of carryBacktest.trades) {
    const regime = detectMarketRegime(ethCandles, Math.floor(trade.entryTime / 3_600_000) % ethCandles.length)
    if (regime === 'bull') { carryBull++; if (trade.netReturnPct > 0) carryBullWin++; carryBullNet += trade.netReturnPct }
    if (regime === 'bear') { carryBear++; if (trade.netReturnPct > 0) carryBearWin++; carryBearNet += trade.netReturnPct }
  }

  const carryEq = carryBacktest.equityCurve.map((p, i) => {
    let peak = carryBacktest.equityCurve[0].equity
    for (let j = 1; j <= i; j++) peak = Math.max(peak, carryBacktest.equityCurve[j].equity)
    return { date: new Date(p.time).toISOString().slice(0, 10), equity: p.equity, drawdownPct: peak > 0 ? (peak - p.equity) / peak * 100 : 0 }
  }).filter((_, i) => i % 72 === 0 || i === carryBacktest.equityCurve.length - 1)

  analyses.push({
    strategyName: 'enhancedCarry',
    symbol: 'ETH-USDT',
    trades: carryBacktest.trades.length,
    totalReturnPct: carryBacktest.metrics.totalReturnPct,
    winRate: carryBacktest.trades.length > 0 ? carryBacktest.trades.filter(t => t.netReturnPct > 0).length / carryBacktest.trades.length * 100 : 0,
    ...carryDD,
    ...carryRisk,
    bullMarketTrades: carryBull,
    bearMarketTrades: carryBear,
    bullWinRate: carryBull > 0 ? carryBullWin / carryBull * 100 : 0,
    bearWinRate: carryBear > 0 ? carryBearWin / carryBear * 100 : 0,
    bullNetReturn: carryBullNet * 100,
    bearNetReturn: carryBearNet * 100,
    equityCurve: carryEq,
  })

  // ====== Cross-Sectional Reversal ======
  console.log('\n=== Analyzing Cross-Sectional Reversal ===')
  const csLookback = 168
  let csSignals = 0; let csWins = 0; let csSpreadCumulative = 0
  let csPeak = 0; let csMaxDD = 0
  const csReturns: number[] = []
  let csBullTotal = 0; let csBearTotal = 0; let csBullWin = 0; let csBearWin = 0
  const csEquity: Array<{ date: string; equity: number; drawdownPct: number }> = []
  let csEquityVal = 10000

  for (let i = csLookback + 1; i < Math.min(btcCandles.length, ethCandles.length); i++) {
    const btcRet = (btcCandles[i].close / btcCandles[i - csLookback].close - 1) * 100
    const ethRet = (ethCandles[i].close / ethCandles[i - csLookback].close - 1) * 100
    const btcVol = computeRollingVol(btcCandles, i, 24)
    const ethVol = computeRollingVol(ethCandles, i, 24)

    const assets = [
      { symbol: 'BTC-USDT', currentPrice: btcCandles[i].close, returns: { [`${csLookback}h`]: btcRet }, realizedVolPct: btcVol, avgVolume24h: btcCandles[i].volume },
      { symbol: 'ETH-USDT', currentPrice: ethCandles[i].close, returns: { [`${csLookback}h`]: ethRet }, realizedVolPct: ethVol, avgVolume24h: ethCandles[i].volume },
    ]

    const ranks = evaluateCrossSectionalMomentum(assets, { lookbackHours: csLookback, topN: 1, bottomN: 1, minUniverseSize: 2, maxVolPercentile: 0.99 })
    const top = ranks.find(r => r.signal !== 0)
    const bottom = ranks.find(r => r.signal !== 0 && r.symbol !== top?.symbol)

    if (top && bottom && top.symbol !== bottom.symbol) {
      csSignals++
      const fwd = Math.min(i + 24, btcCandles.length - 1, ethCandles.length - 1)
      const topFwd = top.symbol === 'BTC-USDT' ? (btcCandles[fwd].close / btcCandles[i].close - 1) * 100 : (ethCandles[fwd].close / ethCandles[i].close - 1) * 100
      const bottomFwd = bottom.symbol === 'BTC-USDT' ? (btcCandles[fwd].close / btcCandles[i].close - 1) * 100 : (ethCandles[fwd].close / ethCandles[i].close - 1) * 100
      const signalReturn = topFwd - bottomFwd

      csReturns.push(signalReturn)
      if (signalReturn > 0) csWins++
      csSpreadCumulative += signalReturn

      // Simulate equity with 2% risk per signal
      const positionReturn = signalReturn * 0.02
      csEquityVal *= (1 + positionReturn / 100)
      csPeak = Math.max(csPeak, csEquityVal)
      const dd = csPeak > 0 ? (csPeak - csEquityVal) / csPeak * 100 : 0
      if (dd > csMaxDD) csMaxDD = dd

      const regime = detectMarketRegime(btcCandles, i)
      if (regime === 'bull') { csBullTotal++; if (signalReturn > 0) csBullWin++ }
      if (regime === 'bear') { csBearTotal++; if (signalReturn > 0) csBearWin++ }
    }

    if (i % 72 === 0) {
      const dd = csPeak > 0 ? (csPeak - csEquityVal) / csPeak * 100 : 0
      csEquity.push({ date: new Date(btcCandles[i].time).toISOString().slice(0, 10), equity: csEquityVal, drawdownPct: dd })
    }
  }

  const csSorted = [...csReturns].sort((a, b) => a - b)
  const csVar95 = csSorted[Math.floor(csSorted.length * 0.05)] ?? 0
  const csCVaR95 = csSorted.slice(0, Math.max(1, Math.floor(csSorted.length * 0.05))).reduce((s, v) => s + v, 0) / Math.max(1, Math.floor(csSorted.length * 0.05))

  // Worst/best N-signal sequences
  let worstWindow = { n: 100, return: Infinity }
  let bestWindow = { n: 100, return: -Infinity }
  for (let w = 50; w <= 200; w += 50) {
    for (let j = 0; j <= csReturns.length - w; j++) {
      const windowReturn = csReturns.slice(j, j + w).reduce((s, v) => s + v, 0)
      if (windowReturn < worstWindow.return) worstWindow = { n: w, return: windowReturn }
      if (windowReturn > bestWindow.return) bestWindow = { n: w, return: windowReturn }
    }
  }

  const csRisk: CrossSectionalRiskAnalysis = {
    totalSignals: csSignals,
    winRate: csSignals > 0 ? csWins / csSignals * 100 : 0,
    spreadCumulative: csSpreadCumulative,
    maxDrawdownPct: csMaxDD,
    worstNSignals: worstWindow,
    bestNSignals: bestWindow,
    var95Pct: csVar95,
    cvar95Pct: csCVaR95,
    bullWinRate: csBullTotal > 0 ? csBullWin / csBullTotal * 100 : 0,
    bearWinRate: csBearTotal > 0 ? csBearWin / csBearTotal * 100 : 0,
    equityCurve: csEquity,
  }

  // ====== Output ======
  console.log('\n\n═══════════════════════════════════════════')
  console.log('        DEEP RISK ANALYSIS REPORT')
  console.log('═══════════════════════════════════════════\n')

  for (const a of analyses) {
    const emoji = a.totalReturnPct > 0 ? '🟢' : a.totalReturnPct < -5 ? '🔴' : '🟡'
    console.log(`${emoji} ${a.strategyName} ${a.symbol}`)
    console.log(`  Trades: ${a.trades} | Win Rate: ${a.winRate.toFixed(1)}% | Return: ${a.totalReturnPct.toFixed(1)}%`)
    console.log(`  ── Drawdown ──`)
    console.log(`  Max DD: ${a.maxDrawdownPct.toFixed(2)}% | Duration: ${a.maxDrawdownDuration}h | Avg DD: ${a.avgDrawdownPct.toFixed(2)}%`)
    console.log(`  DDs >5%: ${a.drawdownsOver5Pct} | DDs >10%: ${a.drawdownsOver10Pct}`)
    console.log(`  Worst DD: ${a.worstDrawdownStart.slice(0,10)} → ${a.worstDrawdownEnd.slice(0,10)}`)
    console.log(`  ── Extremes ──`)
    console.log(`  Best Trade: +${a.bestTradePct.toFixed(2)}% (${a.bestTradeDate.slice(0,10)})`)
    console.log(`  Worst Trade: ${a.worstTradePct.toFixed(2)}% (${a.worstTradeDate.slice(0,10)})`)
    console.log(`  Avg Win: +${a.avgWinPct.toFixed(2)}% | Avg Loss: ${a.avgLossPct.toFixed(2)}% | Payoff: ${a.payoffRatio.toFixed(2)}`)
    console.log(`  ── Tail Risk ──`)
    console.log(`  VaR 95%: ${a.var95Pct.toFixed(2)}% | VaR 99%: ${a.var99Pct.toFixed(2)}% | CVaR 95%: ${a.cvar95Pct.toFixed(2)}%`)
    console.log(`  Max Consec Losses: ${a.maxConsecutiveLosses} (PnL: ${a.worstDrawdownTrades.toFixed(2)}%)`)
    console.log(`  Max Consec Wins: ${a.maxConsecutiveWins}`)
    console.log(`  ── Regime ──`)
    console.log(`  Bull: ${a.bullMarketTrades} trades, ${a.bullWinRate.toFixed(0)}% WR, ${a.bullNetReturn.toFixed(1)}% return`)
    console.log(`  Bear: ${a.bearMarketTrades} trades, ${a.bearWinRate.toFixed(0)}% WR, ${a.bearNetReturn.toFixed(1)}% return`)
    console.log()
  }

  console.log(`🔵 Cross-Sectional Reversal (BTC vs ETH, 7d lookback, 24h forward)`)
  console.log(`  Signals: ${csRisk.totalSignals} | Win Rate: ${csRisk.winRate.toFixed(1)}%`)
  console.log(`  Spread Cumulative: ${csRisk.spreadCumulative.toFixed(1)}% | Max DD: ${csRisk.maxDrawdownPct.toFixed(2)}%`)
  console.log(`  ── Extremes ──`)
  console.log(`  Worst ${csRisk.worstNSignals.n}-signal window: ${csRisk.worstNSignals.return.toFixed(1)}%`)
  console.log(`  Best ${csRisk.bestNSignals.n}-signal window: ${csRisk.bestNSignals.return.toFixed(1)}%`)
  console.log(`  ── Tail ──`)
  console.log(`  VaR 95%: ${csRisk.var95Pct.toFixed(2)}% | CVaR 95%: ${csRisk.cvar95Pct.toFixed(2)}%`)
  console.log(`  ── Regime ──`)
  console.log(`  Bull Win Rate: ${csRisk.bullWinRate.toFixed(1)}% | Bear Win Rate: ${csRisk.bearWinRate.toFixed(1)}%`)

  // Save JSON
  const outputDir = join(import.meta.dirname, '..', 'data', 'research', 'risk_analysis')
  await mkdir(outputDir, { recursive: true })
  await writeFile(
    join(outputDir, `risk_${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    JSON.stringify({ generatedAt: new Date().toISOString(), strategies: analyses, crossSectionalReversal: csRisk }, null, 2),
  )
  console.log(`\nSaved to ${outputDir}`)
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
