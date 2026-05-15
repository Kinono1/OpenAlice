import { describe, expect, it } from 'vitest'
import {
  buildPaperEligibilityGapReport,
} from './build_openalice_paper_eligibility_gap_report.js'

describe('build_openalice_paper_eligibility_gap_report', () => {
  it('reads from live runtime artifacts and produces gap report', async () => {
    const report = await buildPaperEligibilityGapReport({ outputPath: null, json: false })

    expect(report.schemaVersion).toBe(1)
    expect(report.generatedAt).toBeTruthy()

    expect(report.rawClosedTrades).toEqual(expect.any(Number))
    expect(report.promotionCountedTrades).toEqual(expect.any(Number))

    expect(report.funnel.length).toBeGreaterThan(0)
    expect(report.funnel[0].stage).toBe('raw_closed')
    expect(report.funnel[0].extractable).toBe(true)
    expect(report.funnel[report.funnel.length - 1].stage).toBe('promotion_counted')
    expect(report.funnel[report.funnel.length - 1].extractable).toBe(true)

    // Non-extractable stages must provide a reason
    const nonExtractable = report.funnel.filter(s => !s.extractable)
    for (const stage of nonExtractable) {
      expect(stage.description.length).toBeGreaterThan(20)
      expect(stage.count).toBeNull()
    }

    expect(Array.isArray(report.byLane)).toBe(true)
    expect(typeof report.byBlockReason).toBe('object')

    expect(report.timeWindowMismatch).toMatchObject({
      pnlDiagnosticsGeneratedAt: expect.any(String),
      promotionGeneratedAt: expect.any(String),
      paperDecisionGeneratedAt: expect.any(String),
      description: expect.any(String),
    })

    expect(typeof report.gapSummary).toBe('string')
    expect(report.gapSummary.length).toBeGreaterThan(0)
  })

  it('calls out that the gap cannot be fully decomposed', async () => {
    const report = await buildPaperEligibilityGapReport({ outputPath: null, json: false })
    expect(report.gapSummary).toContain('cannot be fully decomposed')
    expect(report.gapSummary).toContain(String(report.rawClosedTrades))
    expect(report.gapSummary).toContain(String(report.promotionCountedTrades))
  })
})
