import type { MarketIntelLane } from './market_intel_constants.js'
import type { MarketIntelContext } from './market_intel_context.js'

export type PaperOpenContextStatus =
  | 'ok'
  | 'stale'
  | 'risk_off'
  | 'severe_news'
  | 'semantic_block'
  | 'lane_blocked'
  | 'cold_start'

export interface PaperOpenContextSnapshot {
  contextSnapshotId: string
  decisionTime: string
  marketDataWatermarkAtDecisionTime: string
  watermark: string
  featuresAvailableAtDecisionTime: boolean
  featureSchemaVersion: string
  contextGenerationAtOpen: number
  contextStatus: PaperOpenContextStatus
  flashContextStatus: PaperOpenContextStatus
  contextReason: string | null
  flashEpochAtOpen: number
  proEpochAtOpen: number
  flashConfidenceLowAtOpen: number | null
  marketIntelTriggerAtOpen: string | null
}

export function paperOpenContextAcceptRejectReasons(
  context: Partial<PaperOpenContextSnapshot>,
): string[] {
  const reasons: string[] = []
  if (!context.contextSnapshotId) reasons.push('missing_contextSnapshotId')
  if (!context.decisionTime) reasons.push('missing_decisionTime')
  if (!context.marketDataWatermarkAtDecisionTime && !context.watermark) {
    reasons.push('missing_marketDataWatermarkAtDecisionTime')
  } else if (!isPITSafeWatermark(context.decisionTime, context.marketDataWatermarkAtDecisionTime ?? context.watermark)) {
    reasons.push('marketDataWatermark_after_decisionTime')
  }
  if (context.featuresAvailableAtDecisionTime !== true) {
    reasons.push('features_not_available_at_decision_time')
  }
  if (context.featureSchemaVersion !== 'paper_open_context.v3') {
    reasons.push('invalid_feature_schema_version')
  }
  if (context.contextStatus !== 'ok') {
    reasons.push(`context_status:${context.contextStatus}`)
  }
  if (context.flashContextStatus !== 'ok') {
    reasons.push(`flash_context_status:${context.flashContextStatus}`)
  }
  if (context.flashConfidenceLowAtOpen == null) {
    reasons.push('missing_flashConfidenceLowAtOpen')
  }
  return reasons
}

function isPITSafeWatermark(
  decisionTime: string | undefined,
  watermark: string | undefined,
): boolean {
  if (!decisionTime || !watermark) return false
  const decisionMs = Date.parse(decisionTime)
  const watermarkMs = Date.parse(watermark)
  if (!Number.isFinite(decisionMs) || !Number.isFinite(watermarkMs)) return false
  return watermarkMs <= decisionMs
}

export function paperOpenContextAcceptable(context: PaperOpenContextSnapshot): boolean {
  return paperOpenContextAcceptRejectReasons(context).length === 0
}

export function buildPaperOpenContextSnapshot(
  context: MarketIntelContext,
  lane: MarketIntelLane,
  now = new Date(),
): PaperOpenContextSnapshot {
  const status = resolvePaperOpenContextStatus(context, lane, now)
  const decisionTime = now.toISOString()
  const watermark = context.generatedAt
  return {
    contextSnapshotId: buildContextSnapshotId(context, lane),
    decisionTime,
    marketDataWatermarkAtDecisionTime: watermark,
    watermark,
    featuresAvailableAtDecisionTime: status.status !== 'stale',
    featureSchemaVersion: 'paper_open_context.v3',
    contextGenerationAtOpen: context.contextGeneration,
    contextStatus: status.status,
    flashContextStatus: status.status,
    contextReason: status.reason,
    flashEpochAtOpen: context.sourceEpoch.flashEpoch,
    proEpochAtOpen: context.sourceEpoch.proEpoch,
    flashConfidenceLowAtOpen: context.flashConfidenceByLane[lane]?.confidenceLow ?? null,
    marketIntelTriggerAtOpen: context.trigger ?? null,
  }
}

function resolvePaperOpenContextStatus(
  context: MarketIntelContext,
  lane: MarketIntelLane,
  now: Date,
): { status: PaperOpenContextStatus; reason: string | null } {
  const validUntil = Date.parse(context.validUntil)
  if (!Number.isFinite(validUntil) || validUntil <= now.getTime()) {
    return { status: 'stale', reason: 'context_stale' }
  }
  if (context.riskMode === 'risk_off') {
    return { status: 'risk_off', reason: 'risk_off' }
  }
  if (context.newsRiskRegime === 'severe') {
    return { status: 'severe_news', reason: 'severe_news' }
  }
  if (!context.semanticValidation.passed) {
    return { status: 'semantic_block', reason: 'semantic_validation_block' }
  }
  if (context.coldStartRoundsRemaining > 0) {
    return { status: 'cold_start', reason: `cold_start:${context.coldStartRoundsRemaining}` }
  }
  if (context.allowNewPositionsByLane[lane] !== true) {
    return { status: 'lane_blocked', reason: `lane_not_allowed:${lane}` }
  }
  return { status: 'ok', reason: null }
}

function buildContextSnapshotId(context: MarketIntelContext, lane: MarketIntelLane): string {
  return [
    'market_intel',
    `schema:${context.schemaVersion}`,
    `generation:${context.contextGeneration}`,
    `lane:${lane}`,
    `flash:${context.sourceEpoch.flashEpoch}`,
    `pro:${context.sourceEpoch.proEpoch}`,
    `news:${context.sourceEpoch.newsEpoch}`,
  ].join(':')
}
