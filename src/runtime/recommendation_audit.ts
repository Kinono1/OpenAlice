import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  DEFAULT_PAPER_TRADE_RESULT_PATH,
  DEFAULT_RECOMMENDATION_AUDIT_PATH,
  RECOMMENDATION_SUPPRESS_MS,
} from './market_intel_constants.js'
import { appendJsonlSync } from './runtime_events.js'

export const RecommendationAuditSchema = z.object({
  proEpoch: z.number().int().nonnegative(),
  recommendationKey: z.string(),
  recommendationType: z.string(),
  autoApplied: z.boolean(),
  humanApproved: z.boolean(),
  ignoredCount: z.number().int().nonnegative(),
  suppressUntil: z.string().nullable(),
  suppressReason: z.string().nullable(),
  associatedAvgPnlPct: z.number().nullable(),
})

export type RecommendationAudit = z.infer<typeof RecommendationAuditSchema>

export function appendRecommendationAudit(
  audit: RecommendationAudit,
  path = DEFAULT_RECOMMENDATION_AUDIT_PATH,
): void {
  appendJsonlSync(path, RecommendationAuditSchema.parse(audit))
}

export function withSuppressionIfIgnored(
  audit: Omit<RecommendationAudit, 'suppressUntil' | 'suppressReason'>,
  now = new Date(),
): RecommendationAudit {
  if (audit.ignoredCount < 3) {
    return { ...audit, suppressUntil: null, suppressReason: null }
  }
  return {
    ...audit,
    suppressUntil: new Date(now.getTime() + RECOMMENDATION_SUPPRESS_MS).toISOString(),
    suppressReason: 'ignored_3_times',
  }
}

export function calculateAssociatedAvgPnlPct(
  proEpoch: number,
  paperTradeResultPath = DEFAULT_PAPER_TRADE_RESULT_PATH,
): number | null {
  let raw = ''
  try {
    raw = readFileSync(paperTradeResultPath, 'utf-8')
  } catch {
    return null
  }
  const values: number[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      if (row.proEpochAtOpen !== proEpoch) continue
      if (typeof row.pnlPct === 'number' && Number.isFinite(row.pnlPct)) values.push(row.pnlPct)
    } catch {
      // Ignore malformed JSONL rows.
    }
  }
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

