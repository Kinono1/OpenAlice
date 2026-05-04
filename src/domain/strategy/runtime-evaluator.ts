import type { OhlcvData } from '../analysis/indicator/types.js'
import type { StrategyConfig } from '../../core/config.js'
import { evaluateFreezeWindows } from './event-calendar/index.js'
import {
  combineFactorSignalsWithGovernance,
  DEFAULT_IC_MONITOR_CONFIG,
  evaluateBasisFactor,
  evaluateCarrySpread,
  evaluateCrossTimeframeDivergence,
  evaluateFundingRateFactor,
  evaluateLiquidationAftermath,
  evaluateLiquidationPressure,
  evaluateMeanReversion,
  evaluateMomentumComposite,
  evaluateVolatilityRegime,
  evaluateVolumeSurgeFactor,
  FactorIcMonitor,
} from './factors/index.js'
import type {
  FactorGovernanceResult,
  FactorIcMonitorConfig,
  FactorSignal,
  IcMonitorSnapshot,
} from './factors/index.js'
import { clamp, safeZScore } from './factors/helpers.js'
import { evaluateMetaLabelAdmission } from './meta-labeling/index.js'
import {
  evaluateSignalGovernance,
  type GovernanceContext,
  type SentimentCrowding,
  type SourceTier,
  type UseType,
} from './governance/index.js'
import {
  evaluateLayerLimits,
  fractionalKelly,
  volatilityTargetSize,
} from './position-sizing/index.js'
import type { AssetLayer, PositionSizingDecision } from './position-sizing/index.js'
import {
  type MetaLabelAdmissionSummary,
  createUnavailableStrategyDataProvenance,
  type StrategyExecutionSummary,
  type StrategyDataProvenance,
} from './runtime-types.js'
import {
  calibrateStateConditionedFactorWeights,
  DEFAULT_HMM_PARAMS,
  DEFAULT_REGIME_HMM_CONFIG,
  evaluateRegime,
  extractHmmObservations,
  predictRegimeTransition,
  RegimeHmm,
  type HmmColdStartMode,
  type HmmParams,
  type HmmRegimeOutput,
  type RegimeEvaluation,
  type RegimeTransitionForecast,
} from './regime/index.js'

import type { HmmStateName } from './regime/hmm/types.js'

export interface TimestampedValue {
  value: number
  timestampMs: number
}

export interface RuntimeFactorSnapshotInput {
  symbol: string
  candles: OhlcvData[]
  strategyConfig: StrategyConfig
  sourceTier: SourceTier
  useType: UseType
  sentiment: SentimentCrowding
  fundingRatePct?: number
  fundingRateHistoryPct?: number[]
  fundingRateHistory8h?: { ratePct: number; timestampMs: number }[]
  openInterest?: number
  openInterestValue?: number
  openInterestHistory?: TimestampedValue[]
  liquidationCount24h?: number
  liquidationNotional24h?: number
  liquidationHistory?: TimestampedValue[]
  basisInput?: {
    futuresPrice: number
    spotPrice: number
    daysToExpiry?: number
  }
  dataProvenance?: StrategyDataProvenance
  equity?: number
  assetLayer?: AssetLayer
  currentOpenPositions?: number
  currentLayerOpenPositions?: number
  coreRiskOff?: boolean
  winRate?: number
  avgWinLossRatio?: number
  nowUtcMs?: number
  staleData?: boolean
  icSharpeByState?: Partial<Record<HmmStateName, Record<string, number>>>
  icMonitorConfig?: FactorIcMonitorConfig
  icMonitorSnapshot?: IcMonitorSnapshot
}

export interface RuntimeFactorSnapshot {
  symbol: string
  factorSignals: FactorSignal[]
  governance: FactorGovernanceResult['governance']
  ensemble: Omit<FactorGovernanceResult, 'governance'>
  regimeEvaluation?: RegimeEvaluation
  hmmRegime?: HmmRegimeOutput | null
  regimeTransitionForecast?: RegimeTransitionForecast | null
  freeze: ReturnType<typeof evaluateFreezeWindows>
  derivedMetrics: {
    return1hPct: number
    return6hPct: number
    return24hPct: number
    return7dPct: number
    currentPrice: number
    currentVolume: number
    averageVolume: number
    realizedVolPct: number
    openInterest: number | null
    openInterestValue: number | null
    liquidationCount24h: number | null
    liquidationNotional24h: number | null
  }
  researchDiagnostics?: {
    hmmEnabled: boolean
    observationCount: number
    coldStartMode?: HmmColdStartMode
    factorDirectionMultipliers: Record<string, number>
    factorWeightMultipliers: Record<string, number>
    icWeightMultipliers: Record<string, number>
    icDecayedByFactor: Record<string, boolean>
    effectiveFactorValues: Record<string, number>
    effectiveFactorWeights: Record<string, number>
  }
  metaLabeling?: MetaLabelAdmissionSummary
  dataProvenance: StrategyDataProvenance
  positionSizing: PositionSizingDecision & {
    requestedPctOfEquity: number
    recommendedNotionalUsd: number | null
    assetLayer: AssetLayer
    equity: number | null
  }
  icMonitorSnapshot?: IcMonitorSnapshot
  executionPreview?: StrategyExecutionSummary
}

function getClose(candles: OhlcvData[], offsetFromEnd: number): number {
  const index = candles.length - 1 - offsetFromEnd
  return index >= 0 ? candles[index].close : candles[0].close
}

function pctChange(current: number, previous: number): number {
  if (!Number.isFinite(previous) || previous === 0) {
    return 0
  }
  return ((current - previous) / previous) * 100
}

function realizedVolPct(candles: OhlcvData[]): number {
  if (candles.length < 2) {
    return 0
  }
  const returns: number[] = []
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1].close
    const next = candles[i].close
    returns.push(prev > 0 ? (next - prev) / prev : 0)
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance) * Math.sqrt(24 * 365) * 100
}

function averageVolume(candles: OhlcvData[], lookback = 30): number {
  const window = candles.slice(-lookback)
  const volumes = window
    .map((candle) => candle.volume ?? 0)
    .filter((value) => Number.isFinite(value))
  if (volumes.length === 0) {
    return 0
  }
  return volumes.reduce((sum, value) => sum + value, 0) / volumes.length
}

function buildRealizedVolSeries(
  candles: OhlcvData[],
  window = 24,
): number[] {
  if (candles.length < 2) {
    return []
  }
  const returns: number[] = []
  const result: number[] = []
  for (let index = 1; index < candles.length; index += 1) {
    const prev = candles[index - 1].close
    const next = candles[index].close
    returns.push(prev > 0 ? (next - prev) / prev : 0)
    const slice = returns.slice(-window)
    const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length
    const variance = slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / slice.length
    result.push(Math.sqrt(Math.max(variance, 0)) * Math.sqrt(24 * 365) * 100)
  }
  return result
}

function computeVolatilityRegimeMetrics(
  candles: OhlcvData[],
): {
  previousRealizedVolPct: number
  volOfVolPct: number
  consecutiveHighVol: number
  volExpansionScore: number
} {
  const volSeries = buildRealizedVolSeries(candles)
  if (volSeries.length === 0) {
    return {
      previousRealizedVolPct: 0,
      volOfVolPct: 0,
      consecutiveHighVol: 0,
      volExpansionScore: 0,
    }
  }

  const current = volSeries[volSeries.length - 1]
  const previous = volSeries[Math.max(0, volSeries.length - 25)] ?? current
  const trailing = volSeries.slice(-24)
  const mean = trailing.reduce((sum, value) => sum + value, 0) / trailing.length
  const variance = trailing.reduce((sum, value) => sum + (value - mean) ** 2, 0) / trailing.length
  const sorted = [...trailing].sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)] ?? mean

  let consecutiveHighVol = 0
  for (let index = volSeries.length - 1; index >= 0; index -= 1) {
    if (volSeries[index] > median) {
      consecutiveHighVol += 1
      continue
    }
    break
  }

  return {
    previousRealizedVolPct: previous,
    volOfVolPct: Math.sqrt(Math.max(variance, 0)),
    consecutiveHighVol,
    volExpansionScore: clamp((current / Math.max(previous, 1e-6) - 1) / 2, 0, 1),
  }
}

function computeTrendStrength(candles: OhlcvData[], lookback = 24): number {
  const window = candles.slice(-Math.max(lookback, 2))
  if (window.length < 2) {
    return 0
  }
  const closes = window.map((candle) => candle.close)
  const netMove = Math.abs(closes[closes.length - 1] - closes[0])
  const grossMove = closes
    .slice(1)
    .reduce((sum, value, index) => sum + Math.abs(value - closes[index]), 0)
  if (grossMove <= 0) {
    return 0
  }
  return Math.min(1, Math.max(0, netMove / grossMove))
}

function computeRangeCompressionScore(candles: OhlcvData[], lookback = 24): number {
  const window = candles.slice(-Math.max(lookback, 2))
  if (window.length < 2) {
    return 0
  }
  const highestHigh = Math.max(...window.map((candle) => candle.high))
  const lowestLow = Math.min(...window.map((candle) => candle.low))
  const averageClose = window.reduce((sum, candle) => sum + candle.close, 0) / window.length
  if (averageClose <= 0) {
    return 0
  }
  const normalizedRangePct = ((highestHigh - lowestLow) / averageClose) * 100
  return Math.min(1, Math.max(0, 1 - normalizedRangePct / 12))
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stdDev(values: number[], meanValue: number): number {
  if (values.length === 0) {
    return 0
  }
  const variance = values.reduce(
    (sum, value) => sum + (value - meanValue) ** 2,
    0,
  ) / values.length
  return Math.sqrt(Math.max(variance, 0))
}

function buildRollingFundingRateStats(
  fundingRateHistoryPct: number[] | undefined,
  lookback = 24,
): { meanPct: number; stdPct: number } | null {
  const history = (fundingRateHistoryPct ?? []).filter((value) => Number.isFinite(value))
  if (history.length < 2) {
    return null
  }

  const window = history.slice(-Math.max(lookback, 2))
  const meanPct = mean(window)
  const stdPct = stdDev(window, meanPct)
  return {
    meanPct,
    stdPct,
  }
}

function deriveOpenInterestPressure(input: {
  currentPrice: number
  currentVolume: number
  openInterest?: number
  openInterestValue?: number
  return1hPct: number
  return24hPct: number
}): {
  openInterestPressure: number
  openInterestNotional: number
  openInterestCoverage: number
  directionalReturnPct: number
} | null {
  const openInterestNotional =
    typeof input.openInterestValue === 'number' && Number.isFinite(input.openInterestValue) && input.openInterestValue > 0
      ? input.openInterestValue
      : typeof input.openInterest === 'number' && Number.isFinite(input.openInterest) && input.openInterest > 0
        ? input.openInterest * input.currentPrice
        : null

  if (openInterestNotional == null || input.currentPrice <= 0) {
    return null
  }

  const turnoverNotional = Math.max(
    input.currentVolume > 0 ? input.currentVolume * input.currentPrice : 0,
    input.currentPrice,
    1,
  )
  const openInterestCoverage = openInterestNotional / turnoverNotional
  const crowdingStrength = clamp(
    Math.log1p(openInterestCoverage) / Math.log(11),
    0,
    1,
  )
  const directionalReturnPct =
    Math.abs(input.return1hPct) >= Math.abs(input.return24hPct)
      ? input.return1hPct
      : input.return24hPct
  const direction = directionalReturnPct > 0 ? -1 : directionalReturnPct < 0 ? 1 : 0

  return {
    openInterestPressure: crowdingStrength * direction,
    openInterestNotional,
    openInterestCoverage,
    directionalReturnPct,
  }
}

function normalizeLiquidationComponentWeights(input: {
  componentWeights?: {
    fundingPressure: number
    cascadePressure: number
    openInterestPressure: number
  }
  hasOpenInterestPressure: boolean
}): {
  fundingPressure: number
  cascadePressure: number
  openInterestPressure: number
} | undefined {
  if (input.hasOpenInterestPressure) {
    return input.componentWeights
  }

  if (!input.componentWeights) {
    return {
      fundingPressure: 0.5,
      cascadePressure: 0.5,
      openInterestPressure: 0,
    }
  }

  const availableWeight = input.componentWeights.fundingPressure + input.componentWeights.cascadePressure
  if (availableWeight <= 0) {
    return {
      fundingPressure: 0.5,
      cascadePressure: 0.5,
      openInterestPressure: 0,
    }
  }

  return {
    fundingPressure: input.componentWeights.fundingPressure / availableWeight,
    cascadePressure: input.componentWeights.cascadePressure / availableWeight,
    openInterestPressure: 0,
  }
}

export function evaluateRuntimeFactorSnapshot(
  input: RuntimeFactorSnapshotInput,
): RuntimeFactorSnapshot {
  if (input.candles.length < 2) {
    throw new Error('At least 2 candles are required to evaluate runtime factors.')
  }

  const latest = input.candles[input.candles.length - 1]
  const latestClose = latest.close
  const ret1h = pctChange(latestClose, getClose(input.candles, 1))
  const ret6h = pctChange(
    latestClose,
    getClose(input.candles, Math.min(6, input.candles.length - 1)),
  )
  const ret24h = pctChange(
    latestClose,
    getClose(input.candles, Math.min(24, input.candles.length - 1)),
  )
  const ret7d = pctChange(
    latestClose,
    getClose(input.candles, Math.min(24 * 7, input.candles.length - 1)),
  )
  const avgVol = averageVolume(input.candles, Math.min(30, input.candles.length))
  const currentVolume = latest.volume ?? 0
  const volumeChangeRate = avgVol > 0 ? (currentVolume - avgVol) / avgVol : 0
  const volPct = realizedVolPct(input.candles)
  const volatilityMetrics = computeVolatilityRegimeMetrics(input.candles)
  const rollingFundingRateStats = buildRollingFundingRateStats(
    input.fundingRateHistoryPct ??
    input.fundingRateHistory8h?.map((point) => point.ratePct),
  )
  const openInterestPressure = deriveOpenInterestPressure({
    currentPrice: latestClose,
    currentVolume,
    openInterest: input.openInterest,
    openInterestValue: input.openInterestValue,
    return1hPct: ret1h,
    return24hPct: ret24h,
  })

  const signals: FactorSignal[] = []
  const factorWeights: Record<string, number> = {}

  if (input.strategyConfig.factors.momentumComposite.enabled) {
    const momentumSignal = evaluateMomentumComposite({
      return1hPct: ret1h,
      return6hPct: ret6h,
      return24hPct: ret24h,
      return7dPct: ret7d,
      realizedVolPct: volPct,
    })
    signals.push(momentumSignal)
    factorWeights['momentum-composite'] =
      input.strategyConfig.factors.momentumComposite.weight
  }

  const meanReversionConfig = input.strategyConfig.factors.meanReversion
  if (meanReversionConfig?.enabled ?? true) {
    signals.push(
      evaluateMeanReversion({
        closes: input.candles.map((c) => c.close),
      }),
    )
    factorWeights['mean-reversion'] = meanReversionConfig?.weight ?? 1
  }

  if (input.strategyConfig.factors.volumeSurge.enabled) {
    const volumeSignal = evaluateVolumeSurgeFactor({
      currentVolume,
      averageVolume: avgVol,
      priceReturnPct: ret24h,
    })
    signals.push(volumeSignal)
    factorWeights['volume-surge'] = input.strategyConfig.factors.volumeSurge.weight

    const liquidationPressureConfig = input.strategyConfig.factors.liquidationPressure
    if (liquidationPressureConfig?.enabled ?? true) {
      const volumeSurgeStrength = clamp(
        (((volumeSignal.metadata.surgeRatio ?? 1) as number) - 1) / 2,
        0,
        1,
      )
      const liquidationComponentWeights = normalizeLiquidationComponentWeights({
        componentWeights: liquidationPressureConfig?.componentWeights
          ? {
              fundingPressure: liquidationPressureConfig.componentWeights.first,
              cascadePressure: liquidationPressureConfig.componentWeights.second,
              openInterestPressure: liquidationPressureConfig.componentWeights.third,
            }
          : undefined,
        hasOpenInterestPressure: openInterestPressure != null,
      })
      signals.push(
        evaluateLiquidationPressure({
          fundingRateZScore:
            typeof input.fundingRatePct === 'number' && rollingFundingRateStats
              ? safeZScore(
                  input.fundingRatePct,
                  rollingFundingRateStats.meanPct,
                  rollingFundingRateStats.stdPct,
                )
              : 0,
          volumeSurgeStrength,
          volExpansionScore: volatilityMetrics.volExpansionScore,
          priceReturnPct: ret1h,
          openInterestPressure: openInterestPressure?.openInterestPressure,
          componentWeights: liquidationComponentWeights,
        }),
      )
      factorWeights['liquidation-pressure'] =
        (liquidationPressureConfig?.weight ?? 1) *
        (openInterestPressure ? 1 : 2 / 3)
    }
  }

  const fundingRatePct = input.fundingRatePct
  const basisInput = input.basisInput
  const fundingHistoryPct =
    input.fundingRateHistoryPct ??
    input.fundingRateHistory8h?.map((point) => point.ratePct)
  const canRunFundingRate =
    typeof fundingRatePct === 'number' &&
    input.strategyConfig.factors.fundingRate.enabled &&
    rollingFundingRateStats != null
  const canRunBasis = basisInput != null && input.strategyConfig.factors.basis.enabled
  const carrySpreadSignal = canRunFundingRate && canRunBasis && rollingFundingRateStats
    ? evaluateCarrySpread({
        currentFundingRatePct: fundingRatePct,
        rollingFundingMeanPct: rollingFundingRateStats.meanPct,
        rollingFundingStdPct: rollingFundingRateStats.stdPct,
        fundingHistoryPct,
        basisInput,
      })
    : null

  if (carrySpreadSignal) {
    signals.push(carrySpreadSignal)
    factorWeights['carry-spread'] =
      (
        input.strategyConfig.factors.fundingRate.weight +
        input.strategyConfig.factors.basis.weight
      ) / 2
  } else if (canRunFundingRate) {
    signals.push(
      evaluateFundingRateFactor({
        currentFundingRatePct: fundingRatePct,
        rollingMeanPct: rollingFundingRateStats.meanPct,
        rollingStdPct: rollingFundingRateStats.stdPct,
        historyPct: fundingHistoryPct,
      }),
    )
    factorWeights['funding-rate'] = input.strategyConfig.factors.fundingRate.weight
  }

  if (!carrySpreadSignal && canRunBasis) {
    signals.push(evaluateBasisFactor(basisInput))
    factorWeights.basis = input.strategyConfig.factors.basis.weight
  }

  const liqAftermathSignal = evaluateLiquidationAftermath({
    liquidationHistory: input.liquidationHistory?.map((h) => ({
      value: h.value,
      timestampMs: h.timestampMs,
    })),
    currentPrice: latestClose,
    return1hPct: ret1h,
    nowUtcMs: input.nowUtcMs,
  })
  if (liqAftermathSignal) {
    signals.push(liqAftermathSignal)
    factorWeights['liquidation-aftermath'] = 1
  }

  const volatilityRegimeConfig = input.strategyConfig.factors.volatilityRegime
  if (volatilityRegimeConfig?.enabled ?? true) {
    signals.push(
      evaluateVolatilityRegime({
        realizedVolPct: volPct,
        previousRealizedVolPct: volatilityMetrics.previousRealizedVolPct,
        volOfVolPct: volatilityMetrics.volOfVolPct,
        consecutiveHighVol: volatilityMetrics.consecutiveHighVol,
        componentWeights: volatilityRegimeConfig?.componentWeights
          ? {
              volExpansion: volatilityRegimeConfig.componentWeights.first,
              volClustering: volatilityRegimeConfig.componentWeights.second,
              volOfVol: volatilityRegimeConfig.componentWeights.third,
            }
          : undefined,
      }),
    )
    factorWeights['volatility-regime'] = volatilityRegimeConfig?.weight ?? 1
  }

  const divergenceConfig = input.strategyConfig.factors.crossTimeframeDivergence
  if (divergenceConfig?.enabled ?? true) {
    signals.push(
      evaluateCrossTimeframeDivergence({
        closes: input.candles.map((c) => c.close),
      }),
    )
    factorWeights['cross-timeframe-divergence'] = divergenceConfig?.weight ?? 1
  }

  const nowUtcMs = input.nowUtcMs ?? Date.now()
  const freeze = input.strategyConfig.eventCalendar.enabled
    ? evaluateFreezeWindows(
        nowUtcMs,
        input.strategyConfig.runtime.marketScope,
        input.strategyConfig.eventCalendar.events,
      )
    : {
        active: false,
        marketScope: input.strategyConfig.runtime.marketScope,
        activeWindows: [],
        maxActionDuringFreeze: undefined,
      }

  const governanceContext: GovernanceContext = {
    eventWindowFrozen: freeze.active,
    eventSeverity: freeze.activeWindows[0]?.event.severity ?? 'none',
    maxActionDuringFreeze: freeze.maxActionDuringFreeze,
  }

  const hmmConfig = {
    ...DEFAULT_REGIME_HMM_CONFIG,
    ...(input.strategyConfig.regime?.hmm ?? {}),
  }
  const hmmEnabled = hmmConfig.enabled
  const hmmObservations = hmmEnabled
    ? extractHmmObservations(input.candles, {
        realizedVolWindow: hmmConfig.realizedVolWindow,
        volumeBaselineWindow: hmmConfig.volumeBaselineWindow,
        zScoreWindow: hmmConfig.zScoreWindow,
      })
    : []
  const hmmRegime = hmmEnabled
    ? new RegimeHmm(hmmConfig).classify(hmmObservations)
    : null

  const icMonitorConfig = input.icMonitorConfig ?? DEFAULT_IC_MONITOR_CONFIG
  const icMonitor = new FactorIcMonitor(icMonitorConfig)
  if (input.icMonitorSnapshot) {
    icMonitor.importSnapshot(input.icMonitorSnapshot)
  }

  if (Number.isFinite(ret1h)) {
    icMonitor.recordReturn(nowUtcMs, ret1h, input.symbol)
  }

  const icConditioning = icMonitor.getConditioning(nowUtcMs, input.symbol)

  for (const signal of signals) {
    icMonitor.recordSignal(signal.name, signal.value, nowUtcMs, input.symbol)
  }
  const updatedIcMonitorSnapshot = icMonitor.exportSnapshot()

  const factorWeightConditioning = calibrateStateConditionedFactorWeights({
    baseWeights: factorWeights,
    hmmOutput: hmmRegime,
    icSharpeByState: input.icSharpeByState,
  })
  const adjustedSignals: FactorSignal[] = signals.map((signal) => {
    const direction = factorWeightConditioning.directions[signal.name] ?? 1
    return {
      ...signal,
      value: clamp(signal.value * direction, -1, 1),
      metadata: {
        ...signal.metadata,
        regimeDirection: direction,
      },
    }
  })
  const crossTimeframeFilter = adjustedSignals.find(
    (signal) => signal.name === 'cross-timeframe-divergence',
  )
  const crossTimeframeFilterMultipliers: Record<string, number> = {}
  if (crossTimeframeFilter) {
    const meanReversionPenalty = metadataNumber(
      crossTimeframeFilter.metadata.meanReversionPenalty,
      1,
    )
    const momentumConfidenceModifier = metadataNumber(
      crossTimeframeFilter.metadata.momentumConfidenceModifier,
      1,
    )
    crossTimeframeFilterMultipliers['mean-reversion'] = meanReversionPenalty
    crossTimeframeFilterMultipliers['momentum-composite'] = momentumConfidenceModifier
  }
  const regimeEvaluation = evaluateRegime(
    {
      trendStrength: computeTrendStrength(input.candles),
      realizedVolPct: volPct,
      rangeCompressionScore: computeRangeCompressionScore(input.candles),
      volumeChangeRate,
      eventWindowFrozen: freeze.active,
    },
    {
      hmm: hmmRegime,
      hmmConfidenceFloor: hmmConfig.confidenceFloor,
    },
  )

  const ensemble = combineFactorSignalsWithGovernance(
    adjustedSignals,
    {
      sourceTier: input.sourceTier,
      useType: input.useType,
      sentiment: input.sentiment,
    },
    factorWeights,
    {
      multiplierBySignal: Object.fromEntries(
        Object.keys(factorWeights).map((factor) => [
          factor,
          (factorWeightConditioning.multipliers[factor] ?? 1) *
          (icConditioning.multipliers[factor] ?? 1) *
          (crossTimeframeFilterMultipliers[factor] ?? 1),
        ]),
      ),
      reasons: [
        ...factorWeightConditioning.reasons,
        ...icConditioning.reasons,
      ],
    },
  )

  const governance = input.strategyConfig.governance.useGovernanceGate
    ? evaluateSignalGovernance(
        {
          sourceTier: input.sourceTier,
          useType: input.useType,
          decisionStrength: ensemble.decisionStrength,
          sentiment: input.sentiment,
        },
        {
          ...governanceContext,
          staleData: input.strategyConfig.governance.staleDataCapsExecution
            ? input.staleData === true
            : undefined,
          preferReduceOnWeakSignal:
            input.strategyConfig.governance.preferReduceOnWeakSignal,
        },
      )
    : ensemble.governance

  const assetLayer =
    input.assetLayer ?? input.strategyConfig.positionSizing.defaultAssetLayer
  const layerConfig = input.strategyConfig.positionSizing.layerConfigs.find(
    (item) => item.layer === assetLayer,
  )

  const requestedPctOfEquity = !input.strategyConfig.positionSizing.enabled
    ? input.strategyConfig.positionSizing.maxPctOfEquity
    : input.strategyConfig.positionSizing.method === 'kelly'
      ? fractionalKelly(
          input.winRate ?? 0.55,
          input.avgWinLossRatio ?? 1.5,
          input.strategyConfig.positionSizing.kellyFraction,
        )
      : input.strategyConfig.positionSizing.method === 'volTarget'
        ? volatilityTargetSize(
            input.strategyConfig.positionSizing.targetVolPct,
            Math.max(volPct, 0.0001),
            input.strategyConfig.positionSizing.maxPctOfEquity,
          )
        : input.strategyConfig.positionSizing.maxPctOfEquity

  const positionSizing = layerConfig
    ? evaluateLayerLimits(
        layerConfig,
        {
          actionStatus: governance.actionStatus,
          assetLayer,
          currentOpenPositions: input.currentOpenPositions ?? 0,
          currentLayerOpenPositions: input.currentLayerOpenPositions ?? 0,
          equity: input.equity ?? 0,
          coreRiskOff: input.coreRiskOff,
        },
        requestedPctOfEquity,
        input.strategyConfig.positionSizing.method,
      )
    : {
        allowed: false,
        maxPositionPctOfEquity: 0,
        recommendedPctOfEquity: 0,
        method: input.strategyConfig.positionSizing.method,
        reasons: [`missing layer config for ${assetLayer}`],
      }

  const snapshot: RuntimeFactorSnapshot = {
    symbol: input.symbol,
    factorSignals: adjustedSignals,
    ensemble: {
      signals: ensemble.signals,
      weights: ensemble.weights,
      aggregateValue: ensemble.aggregateValue,
      aggregateConfidence: ensemble.aggregateConfidence,
      consensusScore: ensemble.consensusScore,
      decisionStrength: ensemble.decisionStrength,
    },
    regimeEvaluation,
    hmmRegime,
    governance,
    freeze,
    derivedMetrics: {
      return1hPct: ret1h,
      return6hPct: ret6h,
      return24hPct: ret24h,
      return7dPct: ret7d,
      currentPrice: latestClose,
      currentVolume,
      averageVolume: avgVol,
      realizedVolPct: volPct,
      openInterest: input.openInterest ?? null,
      openInterestValue: input.openInterestValue ?? null,
      liquidationCount24h: input.liquidationCount24h ?? null,
      liquidationNotional24h: input.liquidationNotional24h ?? null,
    },
    researchDiagnostics: {
      hmmEnabled,
      observationCount: hmmObservations.length,
      coldStartMode: hmmRegime?.coldStartMode,
      factorDirectionMultipliers: factorWeightConditioning.directions,
      factorWeightMultipliers: factorWeightConditioning.multipliers,
      icWeightMultipliers: icConditioning.multipliers,
      icDecayedByFactor: icConditioning.decayedByFactor,
      effectiveFactorValues: Object.fromEntries(
        adjustedSignals.map((signal) => [signal.name, signal.value]),
      ),
      effectiveFactorWeights: factorWeightConditioning.weights,
    },
    dataProvenance:
      input.dataProvenance ?? createUnavailableStrategyDataProvenance(),
    positionSizing: {
      ...positionSizing,
      requestedPctOfEquity,
      recommendedNotionalUsd:
        typeof input.equity === 'number'
          ? positionSizing.recommendedPctOfEquity * input.equity
          : null,
      assetLayer,
      equity: input.equity ?? null,
    },
    icMonitorSnapshot: updatedIcMonitorSnapshot,
  }

  if (input.strategyConfig.metaLabeling?.enabled) {
    snapshot.metaLabeling = evaluateMetaLabelAdmission({
      snapshot,
      minConfidenceToTrade: input.strategyConfig.metaLabeling.minConfidenceToTrade,
      enforcementMode: input.strategyConfig.metaLabeling.enforcementMode,
    })
  }

  return snapshot
}

function metadataNumber(
  value: number | string | boolean | null | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
