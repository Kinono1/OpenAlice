import type { OhlcvData } from '../analysis/indicator/types.js'
import type { StrategyConfig } from '../../core/config.js'
import { evaluateFreezeWindows } from './event-calendar/index.js'
import {
  combineFactorSignalsWithGovernance,
  evaluateBasisFactor,
  evaluateFundingRateFactor,
  evaluateMomentumComposite,
  evaluateVolumeSurgeFactor,
} from './factors/index.js'
import type { FactorGovernanceResult, FactorSignal } from './factors/index.js'
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
  createUnavailableStrategyDataProvenance,
  type StrategyExecutionSummary,
  type StrategyDataProvenance,
} from './runtime-types.js'

export interface RuntimeFactorSnapshotInput {
  symbol: string
  candles: OhlcvData[]
  strategyConfig: StrategyConfig
  sourceTier: SourceTier
  useType: UseType
  sentiment: SentimentCrowding
  fundingRatePct?: number
  openInterest?: number
  openInterestValue?: number
  liquidationCount24h?: number
  liquidationNotional24h?: number
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
}

export interface RuntimeFactorSnapshot {
  symbol: string
  factorSignals: FactorSignal[]
  governance: FactorGovernanceResult['governance']
  ensemble: Omit<FactorGovernanceResult, 'governance'>
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
  dataProvenance: StrategyDataProvenance
  positionSizing: PositionSizingDecision & {
    requestedPctOfEquity: number
    recommendedNotionalUsd: number | null
    assetLayer: AssetLayer
    equity: number | null
  }
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
  const volPct = realizedVolPct(input.candles)

  const signals: FactorSignal[] = []
  const factorWeights: Record<string, number> = {}

  if (input.strategyConfig.factors.momentumComposite.enabled) {
    signals.push(
      evaluateMomentumComposite({
        return1hPct: ret1h,
        return6hPct: ret6h,
        return24hPct: ret24h,
        return7dPct: ret7d,
        realizedVolPct: volPct,
      }),
    )
    factorWeights['momentum-composite'] =
      input.strategyConfig.factors.momentumComposite.weight
  }

  if (input.strategyConfig.factors.volumeSurge.enabled) {
    signals.push(
      evaluateVolumeSurgeFactor({
        currentVolume,
        averageVolume: avgVol,
        priceReturnPct: ret24h,
      }),
    )
    factorWeights['volume-surge'] = input.strategyConfig.factors.volumeSurge.weight
  }

  if (
    typeof input.fundingRatePct === 'number' &&
    input.strategyConfig.factors.fundingRate.enabled
  ) {
    signals.push(
      evaluateFundingRateFactor({
        currentFundingRatePct: input.fundingRatePct,
        rollingMeanPct: 0,
        rollingStdPct: 0.03,
      }),
    )
    factorWeights['funding-rate'] = input.strategyConfig.factors.fundingRate.weight
  }

  if (input.basisInput && input.strategyConfig.factors.basis.enabled) {
    signals.push(evaluateBasisFactor(input.basisInput))
    factorWeights.basis = input.strategyConfig.factors.basis.weight
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

  const ensemble = combineFactorSignalsWithGovernance(
    signals,
    {
      sourceTier: input.sourceTier,
      useType: input.useType,
      sentiment: input.sentiment,
    },
    factorWeights,
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
            ? false
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

  return {
    symbol: input.symbol,
    factorSignals: signals,
    ensemble: {
      signals: ensemble.signals,
      weights: ensemble.weights,
      aggregateValue: ensemble.aggregateValue,
      aggregateConfidence: ensemble.aggregateConfidence,
      consensusScore: ensemble.consensusScore,
      decisionStrength: ensemble.decisionStrength,
    },
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
  }
}
