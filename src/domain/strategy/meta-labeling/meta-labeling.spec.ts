import { describe, expect, it } from 'vitest'
import { evaluateRuntimeFactorSnapshot } from '../runtime-evaluator.js'
import { buildMetaLabelFeatureVector } from './feature-builder.js'
import { computeDynamicThreshold, evaluateFeedbackMetrics } from './feedback-loop.js'
import { evaluateMetaLabelAdmission } from './admission.js'
import { MetaLabelShadowModel } from './shadow-model.js'
import { TradeOutcomeStore } from './trade-outcome-store.js'
import { evaluateTripleBarrierLabel } from './triple-barrier.js'
import type { StrategyConfig } from '../../../core/config.js'

function makeCandles() {
  return [
    { date: '2026-03-01', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { date: '2026-03-02', open: 100, high: 103, low: 99.5, close: 102, volume: 1200 },
    { date: '2026-03-03', open: 102, high: 106, low: 101, close: 105, volume: 1400 },
    { date: '2026-03-04', open: 105, high: 106, low: 97, close: 98, volume: 1600 },
  ]
}

const config: StrategyConfig = {
  enabled: true,
  governance: {
    useGovernanceGate: true,
    staleDataCapsExecution: true,
    preferReduceOnWeakSignal: false,
  },
  runtime: {
    marketScope: 'crypto',
    runtimeIntegrationEnabled: false,
  },
  eventCalendar: {
    enabled: true,
    events: [],
  },
  factors: {
    fundingRate: { enabled: true, weight: 1 },
    basis: { enabled: true, weight: 1 },
    volumeSurge: { enabled: true, weight: 1 },
    momentumComposite: { enabled: true, weight: 1 },
    meanReversion: { enabled: true, weight: 1 },
    volatilityRegime: { enabled: true, weight: 1 },
    liquidationPressure: { enabled: true, weight: 1 },
    crossTimeframeDivergence: { enabled: true, weight: 1 },
  },
  positionSizing: {
    enabled: true,
    method: 'fixed',
    defaultAssetLayer: 'core',
    targetVolPct: 10,
    maxPctOfEquity: 0.3,
    kellyFraction: 0.15,
    layerConfigs: [
      {
        layer: 'core',
        maxPositions: 5,
        maxPositionPctOfEquity: 0.3,
        minActionStatusToTrade: 'probe',
        requiresCoreNotRiskOff: false,
      },
    ],
  },
}

describe('strategy meta-labeling', () => {
  it('labels take-profit before stop-loss for long trades', () => {
    const result = evaluateTripleBarrierLabel({
      candles: makeCandles(),
      entryIndex: 0,
      upperBarrierPct: 3,
      lowerBarrierPct: 2,
      maxHoldingBars: 3,
      side: 'long',
    })

    expect(result.label).toBe(1)
    expect(result.exitReason).toBe('take-profit')
  })

  it('scales triple barriers by high-low volatility when requested', () => {
    const candles = [
      { date: '2026-03-01', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      { date: '2026-03-02', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      { date: '2026-03-03', open: 100, high: 111, low: 89, close: 100, volume: 1000 },
      { date: '2026-03-04', open: 100, high: 101.2, low: 99.8, close: 100.5, volume: 1000 },
    ]

    const staticBarrier = evaluateTripleBarrierLabel({
      candles,
      entryIndex: 2,
      upperBarrierPct: 1,
      lowerBarrierPct: 1,
      maxHoldingBars: 1,
      side: 'long',
    })
    const dynamicBarrier = evaluateTripleBarrierLabel({
      candles,
      entryIndex: 2,
      upperBarrierPct: 1,
      lowerBarrierPct: 1,
      maxHoldingBars: 1,
      side: 'long',
      barrierMode: 'volatility_scaled',
      volatilityLookbackBars: 3,
      volatilityEstimator: 'garman_klass',
    })

    expect(staticBarrier.hitUpperBarrier).toBe(true)
    expect(dynamicBarrier.exitReason).toBe('time-expiry')
    expect(dynamicBarrier.hitUpperBarrier).toBe(false)
  })

  it('labels stop-loss before take-profit for short trades', () => {
    const result = evaluateTripleBarrierLabel({
      candles: makeCandles(),
      entryIndex: 1,
      upperBarrierPct: 2,
      lowerBarrierPct: 2,
      maxHoldingBars: 2,
      side: 'short',
    })

    expect(result.exitReason).toBe('stop-loss')
    expect(result.label).toBe(0)
    expect(result.hitUpperBarrier).toBe(true)
    expect(result.hitLowerBarrier).toBe(false)
  })

  it('labels take-profit on the lower price barrier for short trades', () => {
    const result = evaluateTripleBarrierLabel({
      candles: makeCandles(),
      entryIndex: 2,
      upperBarrierPct: 2,
      lowerBarrierPct: 1,
      maxHoldingBars: 1,
      side: 'short',
    })

    expect(result.exitReason).toBe('take-profit')
    expect(result.label).toBe(1)
    expect(result.hitUpperBarrier).toBe(false)
    expect(result.hitLowerBarrier).toBe(true)
  })

  it('builds meta-label features from a strategy snapshot', () => {
    const snapshot = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: Array.from({ length: 48 }, (_, index) => ({
        date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1000 + index * 10,
      })),
      strategyConfig: config,
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.02,
    })

    const vector = buildMetaLabelFeatureVector({ snapshot })
    expect(vector.names).toContain('ensemble-value')
    expect(vector.names).toContain('hmm-stress-prob')
    expect(vector.names).toContain('return-24h-pct')
    expect(vector.values.length).toBe(vector.names.length)
  })

  it('falls back to the static meta-label threshold when feedback samples are unavailable', () => {
    const snapshot = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: Array.from({ length: 48 }, (_, index) => ({
        date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1000 + index * 10,
      })),
      strategyConfig: config,
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.02,
    })

    const admission = evaluateMetaLabelAdmission({
      snapshot,
      minConfidenceToTrade: 0.55,
    })

    expect(admission.adaptiveThresholdStatus).toBe('fallback_static')
    expect(admission.enforcementMode).toBe('shadow_only')
    expect(admission.primaryObjective).toBe('outperform_skip_after_cost')
    expect(admission.canControlLiveLeverage).toBe(false)
    expect(admission.staticThreshold).toBe(0.55)
    expect(admission.dynamicThreshold).toBe(0.55)
    expect(admission.effectiveThreshold).toBe(0.55)
  })

  it('activates dynamic thresholding when feedback samples are supplied', () => {
    const snapshot = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: Array.from({ length: 48 }, (_, index) => ({
        date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1000 + index * 10,
      })),
      strategyConfig: config,
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.02,
    })

    const admission = evaluateMetaLabelAdmission({
      snapshot,
      minConfidenceToTrade: 0.55,
      adaptiveThresholdFeedback: {
        recentWinRate: 0.3,
        sampleCount: 12,
      },
    })

    expect(admission.adaptiveThresholdStatus).toBe('active')
    expect(admission.dynamicThreshold).toBeDefined()
    expect(admission.effectiveThreshold).toBeGreaterThanOrEqual(admission.staticThreshold ?? 0)
  })

  it('can report explicit gate mode while still keeping leverage control disabled', () => {
    const snapshot = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: Array.from({ length: 48 }, (_, index) => ({
        date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1000 + index * 10,
      })),
      strategyConfig: config,
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.02,
    })

    const admission = evaluateMetaLabelAdmission({
      snapshot,
      minConfidenceToTrade: 0.55,
      enforcementMode: 'gate',
    })

    expect(admission.enforcementMode).toBe('gate')
    expect(admission.primaryObjective).toBe('outperform_skip_after_cost')
    expect(admission.canControlLiveLeverage).toBe(false)
  })

  it('computes feedback metrics without creating execution authority', () => {
    const metrics = evaluateFeedbackMetrics([
      { admissionScore: 0.8, tripleBarrierLabel: 1, realizedReturnPct: 0.4 },
      { admissionScore: 0.7, tripleBarrierLabel: 1, realizedReturnPct: 0.2 },
      { admissionScore: 0.2, tripleBarrierLabel: 0, realizedReturnPct: -0.3 },
    ])

    expect(metrics.recentWinRate).toBeCloseTo(2 / 3)
    expect(metrics.admissionScoreVsPnlCorrelation).toBeGreaterThan(0)
    expect(metrics.retrainRecommended).toBe(false)
    expect(computeDynamicThreshold(0.55, 'stressed', 0.35)).toBeGreaterThan(0.55)
  })

  it('keeps shadow model training readiness separate from trading permission', () => {
    const model = new MetaLabelShadowModel()
    model.record({
      timestampMs: 1,
      features: { edge: 1 },
      ruleBasedScore: 0.7,
      ruleBasedAdmitted: true,
    })
    model.labelOutcome(1, 1, 0.2)

    expect(model.getLabeledCount()).toBe(1)
    expect(model.isReadyForTraining()).toBe(false)
    expect(model.getDiagnostics()).toMatchObject({
      totalRecords: 1,
      labeledRecords: 1,
      readyForTraining: false,
      admissionRate: 1,
    })
  })

  it('stores shadow trade outcomes without duplicating settled entries', () => {
    const store = new TradeOutcomeStore({ maxRecords: 10, exportBatchSize: 5 })
    store.recordEntry('trade-1', { edge: 0.4 }, 0.6)
    store.recordExit('trade-1', 0.3, 'take-profit')
    store.recordExit('trade-1', -0.4, 'stop-loss')

    expect(store.size).toBe(1)
    expect(store.pendingCount).toBe(0)
    expect(store.getRecentWinRate()).toBe(1)
    expect(store.exportForRetraining()).toHaveLength(1)
  })
})
