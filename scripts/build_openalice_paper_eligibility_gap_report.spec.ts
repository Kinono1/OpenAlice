import { describe, expect, it } from 'vitest'
import {
  buildPaperEligibilityGapReport,
} from './build_openalice_paper_eligibility_gap_report.js'

describe('build_openalice_paper_eligibility_gap_report', () => {
  it('handles present or absent runtime artifacts without fabricating counts', async () => {
    const report = await buildPaperEligibilityGapReport({ outputPath: null, json: false })

    expect(report.schemaVersion).toBe(1)
    expect(report.generatedAt).toBeTruthy()

    expect(report.rawClosedTrades === null || Number.isFinite(report.rawClosedTrades)).toBe(true)
    expect(report.promotionCountedTrades === null || Number.isFinite(report.promotionCountedTrades)).toBe(true)

    expect(report.funnel.length).toBeGreaterThan(0)
    expect(report.funnel[0].stage).toBe('raw_closed')
    expect(report.funnel[0].extractable).toBe(report.rawClosedTrades !== null)
    expect(report.funnel[report.funnel.length - 1].stage).toBe('promotion_counted')
    expect(report.funnel[report.funnel.length - 1].extractable).toBe(report.promotionCountedTrades !== null)

    // Non-extractable stages must provide a reason
    const nonExtractable = report.funnel.filter(s => !s.extractable)
    for (const stage of nonExtractable) {
      expect(stage.description.length).toBeGreaterThan(20)
      expect(stage.count).toBeNull()
    }

    expect(Array.isArray(report.byLane)).toBe(true)
    expect(typeof report.byBlockReason).toBe('object')

    expect(report.timeWindowMismatch.description).toEqual(expect.any(String))
    for (const timestamp of [
      report.timeWindowMismatch.pnlDiagnosticsGeneratedAt,
      report.timeWindowMismatch.promotionGeneratedAt,
      report.timeWindowMismatch.paperDecisionGeneratedAt,
    ]) {
      expect(timestamp === null || typeof timestamp === 'string').toBe(true)
    }

    expect(typeof report.gapSummary).toBe('string')
    expect(report.gapSummary.length).toBeGreaterThan(0)
  })

  it('calls out that the gap cannot be fully decomposed', async () => {
    const report = await buildPaperEligibilityGapReport({ outputPath: null, json: false })
    expect(report.gapSummary).toContain('cannot be fully decomposed')
    expect(report.gapSummary).toContain(String(report.rawClosedTrades ?? 'unknown'))
    expect(report.gapSummary).toContain(String(report.promotionCountedTrades ?? 'unknown'))
  })
})
