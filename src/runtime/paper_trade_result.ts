import { z } from 'zod'
import { DEFAULT_PAPER_TRADE_RESULT_PATH } from './market_intel_constants.js'
import { appendJsonlSync } from './runtime_events.js'

const DEFAULT_CONTEXT_CUTOVER_TS = '2026-05-02T00:00:00.000Z'
const DEFAULT_PREDICTED_OPEN_EVIDENCE_ENFORCEMENT_TS = '2026-05-04T00:44:00.000Z'

export const PaperTradeCloseReasonSchema = z.enum([
  'signal',
  'holding_expired',
  'stop_loss',
  'take_profit',
  'stale_context',
  'severe_news',
  'fuse',
  'pro_pause',
  'banned_symbol',
  'forced_exit_timeout',
  'virtual_liquidation_guard',
  'hard_close_price_unavailable',
])

export const PaperTradeResultSchema = z.object({
  tradeId: z.string(),
  lane: z.string(),
  symbol: z.string(),
  leverage: z.number(),
  side: z.enum(['long', 'short']),
  openTs: z.string(),
  closeTs: z.string().nullable(),
  openPrice: z.number(),
  closePrice: z.number().nullable(),
  pnlPct: z.number().nullable(),
  pnlUsd: z.number().nullable(),
  closeReason: PaperTradeCloseReasonSchema,
  priceSource: z.enum(['1s', '5m', 'last_known', 'unavailable']),
  priceStale: z.boolean(),
  contextSnapshotId: z.string().nullable().default(null),
  decisionTime: z.string().nullable().default(null),
  marketDataWatermarkAtDecisionTime: z.string().nullable().default(null),
  watermark: z.string().nullable().default(null),
  featuresAvailableAtDecisionTime: z.boolean().nullable().default(null),
  featureSchemaVersion: z.string().nullable().default(null),
  contextGenerationAtOpen: z.number().int().nonnegative().nullable(),
  contextStatus: z.string().nullable().default(null),
  flashContextStatus: z.string().nullable().default(null),
  contextReason: z.string().nullable().default(null),
  flashEpochAtOpen: z.number().int().nonnegative().nullable().default(null),
  flashConfidenceLowAtOpen: z.number().nullable(),
  ruleScoreAtOpen: z.number().nullable(),
  proEpochAtOpen: z.number().int().nonnegative().nullable(),
  marketIntelTriggerAtOpen: z.string().nullable(),
  volumeRatioAtOpen: z.number().nullable().default(null),
  rangeBreakoutPctAtOpen: z.number().nullable().default(null),
  breakQualityAtOpen: z.number().nullable().default(null),
  liquidityUsdAtOpen: z.number().nullable().default(null),
  liquidityStatusAtOpen: z.string().nullable().default(null),
  spreadBpsAtOpen: z.number().nullable().default(null),
  spreadStatusAtOpen: z.string().nullable().default(null),
  return30sPctAtOpen: z.number().nullable().default(null),
  return60sPctAtOpen: z.number().nullable().default(null),
  microstructureConfidenceAtOpen: z.number().nullable().default(null),
  rankAtOpen: z.number().nullable().default(null),
  rankSpreadPctAtOpen: z.number().nullable().default(null),
  estimatedRoundTripCostPctAtOpen: z.number().nullable().default(null),
  estimatedRoundTripCostPctOfMarginAtOpen: z.number().nullable().default(null),
  expectedGrossEdgePctAtOpen: z.number().nullable().default(null),
  expectedNetEdgePctAtOpen: z.number().nullable().default(null),
  expectedEdgeSourceAtOpen: z.string().nullable().default(null),
  routeCostBpsAtOpen: z.number().nullable().default(null),
  roundTripCostBpsAtOpen: z.number().nullable().default(null),
  markPriceAtOpen: z.number().nullable().default(null),
  markPriceTimestampAtOpen: z.string().nullable().default(null),
  matchPriceAtOpen: z.number().nullable().default(null),
  matchPriceSourceAtOpen: z.string().nullable().default(null),
  markMatchPenaltyBpsAtOpen: z.number().nullable().default(null),
  markMatchStatusAtOpen: z.string().nullable().default(null),
  signalConfidenceAtOpen: z.number().nullable().default(null),
  realizedRoundTripCostBps: z.number().nullable().default(null),
  realizedCostBps: z.number().nullable().default(null),
  fillAdjustedCostBps: z.number().nullable().default(null),
  fillAdjustedCostPct: z.number().nullable().default(null),
  costEvidenceSource: z.string().nullable().default(null),
  costEvidenceStatus: z.string().nullable().default(null),
  predictedOpenEvidenceStatus: z.enum([
    'ok',
    'missing',
    'transitional_dirty_open',
  ]).nullable().default(null),
  predictedOpenEvidenceReason: z.string().nullable().default(null),
  mfeBps: z.number().nullable().default(null),
  maeBps: z.number().nullable().default(null),
  timeToMfeSec: z.number().nullable().default(null),
  timeToMaeSec: z.number().nullable().default(null),
  timeToStopSec: z.number().nullable().default(null),
  mfeBeforeStop: z.boolean().nullable().default(null),
  contextCoverageStatus: z.enum([
    'ok',
    'legacy_missing',
    'partial_missing',
    'stale',
    'timeout',
  ]).nullable().default(null),
  contextCoverageReason: z.string().nullable().default(null),
})

export type PaperTradeResult = z.input<typeof PaperTradeResultSchema>
export type PaperTradeCloseReason = z.infer<typeof PaperTradeCloseReasonSchema>

export interface PaperTradePathCandle {
  timestamp: number
  high: number
  low: number
  close?: number
}

export interface PaperTradeCostEvidenceInput {
  roundTripCostBpsAtOpen?: number | null
  routeCostBpsAtOpen?: number | null
  estimatedRoundTripCostPctAtOpen?: number | null
}

export type PaperTradeCostEvidence = Pick<
  PaperTradeResult,
  | 'realizedRoundTripCostBps'
  | 'realizedCostBps'
  | 'fillAdjustedCostBps'
  | 'fillAdjustedCostPct'
  | 'costEvidenceSource'
  | 'costEvidenceStatus'
>

export type PaperTradePredictedOpenEvidence = Pick<
  PaperTradeResult,
  | 'predictedOpenEvidenceStatus'
  | 'predictedOpenEvidenceReason'
>

export const REQUIRED_COMPLETE_PREDICTED_OPEN_EVIDENCE_FIELDS = [
  'estimatedRoundTripCostPctAtOpen',
  'estimatedRoundTripCostPctOfMarginAtOpen',
  'expectedGrossEdgePctAtOpen',
  'expectedNetEdgePctAtOpen',
  'expectedEdgeSourceAtOpen',
  'routeCostBpsAtOpen',
  'roundTripCostBpsAtOpen',
  'matchPriceAtOpen',
  'matchPriceSourceAtOpen',
  'markMatchPenaltyBpsAtOpen',
  'markMatchStatusAtOpen',
] as const

export type CompletePredictedOpenEvidenceField =
  typeof REQUIRED_COMPLETE_PREDICTED_OPEN_EVIDENCE_FIELDS[number]

export type CompletePredictedOpenEvidenceRecord = Partial<
  Record<CompletePredictedOpenEvidenceField, unknown>
>

export type PaperTradeMfeMaeEvidence = Pick<
  PaperTradeResult,
  | 'mfeBps'
  | 'maeBps'
  | 'timeToMfeSec'
  | 'timeToMaeSec'
  | 'timeToStopSec'
  | 'mfeBeforeStop'
>

export function buildPaperTradeCostEvidence(input: PaperTradeCostEvidenceInput): PaperTradeCostEvidence {
  const explicitBps = firstNonNegativeFinite([
    input.roundTripCostBpsAtOpen,
    input.routeCostBpsAtOpen,
  ])
  const estimatedPct = nonNegativeFinite(input.estimatedRoundTripCostPctAtOpen)
  const costBps = explicitBps ?? (estimatedPct == null ? null : roundCostNumber(estimatedPct * 100))
  return {
    realizedRoundTripCostBps: null,
    realizedCostBps: null,
    fillAdjustedCostBps: null,
    fillAdjustedCostPct: null,
    costEvidenceSource: costBps == null ? null : 'paper_cost_model_at_open',
    costEvidenceStatus: costBps == null ? 'missing' : 'paper_model_not_exchange_reconciled',
  }
}

export function buildPaperTradePredictedOpenEvidence(
  result: Partial<PaperTradeResult>,
): PaperTradePredictedOpenEvidence {
  const missing = missingPaperTradePredictedOpenEvidenceFields(result)
  if (missing.length === 0) {
    return {
      predictedOpenEvidenceStatus: 'ok',
      predictedOpenEvidenceReason: null,
    }
  }
  const openMs = typeof result.openTs === 'string' ? Date.parse(result.openTs) : Number.NaN
  const enforcementMs = Date.parse(
    process.env.OPENALICE_PREDICTED_OPEN_EVIDENCE_ENFORCEMENT_TS ??
    DEFAULT_PREDICTED_OPEN_EVIDENCE_ENFORCEMENT_TS,
  )
  const status = Number.isFinite(openMs) &&
    Number.isFinite(enforcementMs) &&
    openMs < enforcementMs
    ? 'transitional_dirty_open'
    : 'missing'
  return {
    predictedOpenEvidenceStatus: status,
    predictedOpenEvidenceReason: `missing:${missing.join(',')}`,
  }
}

export function missingCompletePredictedOpenEvidenceFields(
  value: CompletePredictedOpenEvidenceRecord,
): CompletePredictedOpenEvidenceField[] {
  return REQUIRED_COMPLETE_PREDICTED_OPEN_EVIDENCE_FIELDS.filter(field => {
    const item = value[field]
    return item === null || item === undefined ||
      (typeof item === 'number' && !Number.isFinite(item)) ||
      (typeof item === 'string' && item.trim() === '')
  })
}

export function assertCompletePredictedOpenEvidenceRecord(input: {
  errorPrefix: string
  kind: string
  value: CompletePredictedOpenEvidenceRecord
}): void {
  const missing = missingCompletePredictedOpenEvidenceFields(input.value)
  if (missing.length > 0) {
    throw new Error(`${input.errorPrefix}_open_${input.kind}_missing_predicted_open_evidence:${missing.join(',')}`)
  }
}

function missingPaperTradePredictedOpenEvidenceFields(result: Partial<PaperTradeResult>): string[] {
  const missing: string[] = []
  if (firstNonNegativeFinite([
    result.roundTripCostBpsAtOpen,
    result.routeCostBpsAtOpen,
    result.estimatedRoundTripCostPctAtOpen == null ? null : result.estimatedRoundTripCostPctAtOpen * 100,
  ]) == null) missing.push('predicted_cost_bps')
  if (result.expectedGrossEdgePctAtOpen == null) missing.push('expectedGrossEdgePctAtOpen')
  if (result.expectedNetEdgePctAtOpen == null) missing.push('expectedNetEdgePctAtOpen')
  if (typeof result.expectedEdgeSourceAtOpen !== 'string' || result.expectedEdgeSourceAtOpen.trim() === '') {
    missing.push('expectedEdgeSourceAtOpen')
  }
  if (result.matchPriceAtOpen == null) missing.push('matchPriceAtOpen')
  if (typeof result.matchPriceSourceAtOpen !== 'string' || result.matchPriceSourceAtOpen.trim() === '') {
    missing.push('matchPriceSourceAtOpen')
  }
  if (result.markMatchPenaltyBpsAtOpen == null) missing.push('markMatchPenaltyBpsAtOpen')
  if (typeof result.markMatchStatusAtOpen !== 'string' || result.markMatchStatusAtOpen.trim() === '') {
    missing.push('markMatchStatusAtOpen')
  }
  return missing
}

export function buildPaperTradeMfeMaeEvidence(input: {
  side: 'long' | 'short'
  openTs: string
  closeTs: string | null
  openPrice: number
  closeReason: PaperTradeCloseReason
  priceSource: PaperTradeResult['priceSource']
  candles: PaperTradePathCandle[]
}): PaperTradeMfeMaeEvidence {
  const empty = emptyPaperTradeMfeMaeEvidence()
  const openMs = Date.parse(input.openTs)
  const closeMs = typeof input.closeTs === 'string' ? Date.parse(input.closeTs) : Number.NaN
  if (
    !Number.isFinite(openMs) ||
    !Number.isFinite(closeMs) ||
    input.openPrice <= 0 ||
    input.side !== 'long' && input.side !== 'short'
  ) {
    return empty
  }
  const path = input.candles
    .filter(candle =>
      Number.isFinite(candle.timestamp) &&
      candle.timestamp >= openMs &&
      candle.timestamp <= closeMs &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      candle.high > 0 &&
      candle.low > 0,
    )
    .sort((a, b) => a.timestamp - b.timestamp)
  if (path.length === 0) return empty

  let bestBps = -Infinity
  let worstBps = Infinity
  let bestTs = path[0].timestamp
  let worstTs = path[0].timestamp
  for (const candle of path) {
    const favorablePrice = input.side === 'long' ? candle.high : candle.low
    const adversePrice = input.side === 'long' ? candle.low : candle.high
    const favorableBps = input.side === 'long'
      ? (favorablePrice / input.openPrice - 1) * 10_000
      : (input.openPrice / favorablePrice - 1) * 10_000
    const adverseBps = input.side === 'long'
      ? (adversePrice / input.openPrice - 1) * 10_000
      : (input.openPrice / adversePrice - 1) * 10_000
    if (favorableBps > bestBps) {
      bestBps = favorableBps
      bestTs = candle.timestamp
    }
    if (adverseBps < worstBps) {
      worstBps = adverseBps
      worstTs = candle.timestamp
    }
  }

  return {
    mfeBps: roundCostNumber(bestBps),
    maeBps: roundCostNumber(worstBps),
    timeToMfeSec: Math.max(0, (bestTs - openMs) / 1000),
    timeToMaeSec: Math.max(0, (worstTs - openMs) / 1000),
    timeToStopSec: input.closeReason === 'stop_loss' ? Math.max(0, (closeMs - openMs) / 1000) : null,
    mfeBeforeStop: input.closeReason === 'stop_loss' && input.priceSource === '1s'
      ? bestTs <= closeMs
      : null,
  }
}

export function emptyPaperTradeMfeMaeEvidence(): PaperTradeMfeMaeEvidence {
  return {
    mfeBps: null,
    maeBps: null,
    timeToMfeSec: null,
    timeToMaeSec: null,
    timeToStopSec: null,
    mfeBeforeStop: null,
  }
}

export function appendPaperTradeResult(
  result: PaperTradeResult,
  path = DEFAULT_PAPER_TRADE_RESULT_PATH,
): void {
  appendJsonlSync(path, PaperTradeResultSchema.parse(withPaperTradeContextCoverage(result)))
}

export function withPaperTradeContextCoverage(result: PaperTradeResult): PaperTradeResult {
  const existingStatus = typeof result.contextCoverageStatus === 'string'
    ? result.contextCoverageStatus
    : null
  const existingReason = typeof result.contextCoverageReason === 'string'
    ? result.contextCoverageReason
    : null
  const computed = computePaperTradeContextCoverage(result)
  return {
    ...result,
    contextCoverageStatus: existingStatus ?? computed.status,
    contextCoverageReason: existingReason ?? computed.reason,
  }
}

export function computePaperTradeContextCoverage(
  result: Partial<PaperTradeResult>,
): { status: NonNullable<PaperTradeResult['contextCoverageStatus']>; reason: string | null } {
  const closeReason = typeof result.closeReason === 'string' ? result.closeReason : ''
  if (closeReason === 'stale_context' || result.priceStale === true) {
    return { status: 'stale', reason: 'stale_context_or_price' }
  }
  if (closeReason === 'forced_exit_timeout') {
    return { status: 'timeout', reason: 'forced_exit_timeout' }
  }
  const missing = missingPaperTradeDecisionContextFields(result)
  if (missing.length === 0) return { status: 'ok', reason: null }
  const hasAnyContext = [
    result.contextSnapshotId,
    result.decisionTime,
    result.marketDataWatermarkAtDecisionTime,
    result.watermark,
    result.featureSchemaVersion,
    result.contextGenerationAtOpen,
    result.contextStatus,
    result.flashContextStatus,
    result.flashConfidenceLowAtOpen,
  ].some(value => value != null)
  const status = hasAnyContext || isAfterPaperContextCutover(result.openTs)
    ? 'partial_missing'
    : 'legacy_missing'
  return {
    status,
    reason: `missing:${missing.join(',')}`,
  }
}

function isAfterPaperContextCutover(openTs: unknown): boolean {
  const cutoverMs = Date.parse(process.env.OPENALICE_CONTEXT_CUTOVER_TS ?? DEFAULT_CONTEXT_CUTOVER_TS)
  const openMs = typeof openTs === 'string' ? Date.parse(openTs) : Number.NaN
  if (!Number.isFinite(cutoverMs) || !Number.isFinite(openMs)) return true
  return openMs >= cutoverMs
}

function missingPaperTradeDecisionContextFields(result: Partial<PaperTradeResult>): string[] {
  const missing: string[] = []
  if (!result.contextSnapshotId) missing.push('contextSnapshotId')
  if (!result.decisionTime) missing.push('decisionTime')
  if (!result.marketDataWatermarkAtDecisionTime && !result.watermark) {
    missing.push('marketDataWatermarkAtDecisionTime')
  }
  if (result.featuresAvailableAtDecisionTime !== true) {
    missing.push('featuresAvailableAtDecisionTime')
  }
  if (result.featureSchemaVersion !== 'paper_open_context.v3') {
    missing.push('featureSchemaVersion_v3')
  }
  if (!result.contextStatus) missing.push('contextStatus')
  if (!result.flashContextStatus) missing.push('flashContextStatus')
  if (result.contextGenerationAtOpen == null) missing.push('contextGenerationAtOpen')
  if (result.flashConfidenceLowAtOpen == null) missing.push('flashConfidenceLowAtOpen')
  return missing
}

function firstNonNegativeFinite(values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    const parsed = nonNegativeFinite(value)
    if (parsed != null) return parsed
  }
  return null
}

function nonNegativeFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function roundCostNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
