import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarryConfluenceCandidateStatusReport,
  parseEthCarryConfluenceCandidateStatusArgs,
  runEthCarryConfluenceCandidateStatus,
} from './build_eth_carry_confluence_candidate_status.js'

describe('build_eth_carry_confluence_candidate_status', () => {
  it('parses args and keeps package script research-only', () => {
    expect(parseEthCarryConfluenceCandidateStatusArgs([
      '--signalDiagnosticsPath',
      '/tmp/diag.json',
      '--output',
      'none',
      '--minTotalClosedOutcomes',
      '50',
      '--minBucketClosedOutcomes',
      '10',
      '--minBucketWinRatePct',
      '60',
      '--minBucketMeanNetPct',
      '0.01',
      '--json',
    ])).toMatchObject({
      signalDiagnosticsPath: '/tmp/diag.json',
      outputPath: null,
      minTotalClosedOutcomes: 50,
      minBucketClosedOutcomes: 10,
      minBucketWinRatePct: 60,
      minBucketMeanNetPct: 0.01,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:confluence-candidate-status']).toContain('build_eth_carry_confluence_candidate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_eth_carry_confluence_candidate_status.ts')
  })

  it('turns a positive confluence bucket into a blocked research-only candidate', () => {
    const report = buildEthCarryConfluenceCandidateStatusReport({
      generatedAt: '2026-05-08T03:00:00.000Z',
      signalDiagnosticsPath: '/repo/diag.json',
      signalDiagnostics: makeDiagnostics({
        closedRows: 26,
        buckets: [
          makeBucket({
            bucketId: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
            closedOutcomes: 4,
            winRatePct: 75,
            meanNetPct: 0.145,
          }),
          makeBucket({
            bucketId: 'confluence:funding_negative:basis_negative:direction_long_eth_short_btc',
            closedOutcomes: 8,
            winRatePct: 0,
            meanNetPct: -0.622,
          }),
        ],
      }),
      minTotalClosedOutcomes: 100,
      minBucketClosedOutcomes: 30,
      minBucketWinRatePct: 55,
      minBucketMeanNetPct: 0,
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T03:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'research_candidate_insufficient_evidence',
      recommendedCandidate: {
        candidateId: 'eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc',
        familyId: 'funding_carry_rebuild',
        researchOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        rule: {
          fundingSpreadSign: 'positive',
          basisSpreadDiffPctSign: 'positive',
          direction: 'short_eth_long_btc',
        },
        evidence: {
          closedOutcomes: 4,
          winRatePct: 75,
          meanNetPct: 0.145,
        },
      },
      avoidListCandidate: {
        candidateId: 'eth_carry_confluence_avoid_funding_negative_basis_negative_long_eth_short_btc',
        sourceBucketId: 'confluence:funding_negative:basis_negative:direction_long_eth_short_btc',
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'prospective_closed_outcomes_low:26<100',
      'confluence_bucket_closed_outcomes_low:4<30',
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'wfo_fdr_pit_route_cost_prospective_paper_gates_required',
    ]))
  })

  it('can report ready for offline validation without enabling paper or live', () => {
    const report = buildEthCarryConfluenceCandidateStatusReport({
      generatedAt: '2026-05-08T03:00:00.000Z',
      signalDiagnosticsPath: '/repo/diag.json',
      signalDiagnostics: makeDiagnostics({
        closedRows: 120,
        buckets: [
          makeBucket({
            bucketId: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
            closedOutcomes: 35,
            winRatePct: 62,
            meanNetPct: 0.18,
          }),
        ],
      }),
      minTotalClosedOutcomes: 100,
      minBucketClosedOutcomes: 30,
      minBucketWinRatePct: 55,
      minBucketMeanNetPct: 0,
    })

    expect(report).toMatchObject({
      status: 'research_candidate_ready_for_offline_validation',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(report.blockers).toEqual([
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'wfo_fdr_pit_route_cost_prospective_paper_gates_required',
    ])
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-confluence-'))
    const signalDiagnosticsPath = join(root, 'diag.json')
    const outputPath = join(root, 'out.json')
    await mkdir(root, { recursive: true })
    await writeFile(signalDiagnosticsPath, JSON.stringify(makeDiagnostics({
      closedRows: 26,
      buckets: [
        makeBucket({
          bucketId: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
          closedOutcomes: 4,
          winRatePct: 75,
          meanNetPct: 0.145,
        }),
      ],
    })), 'utf-8')

    const report = await runEthCarryConfluenceCandidateStatus({
      signalDiagnosticsPath,
      outputPath,
      minTotalClosedOutcomes: 100,
      minBucketClosedOutcomes: 30,
      minBucketWinRatePct: 55,
      minBucketMeanNetPct: 0,
      json: false,
    })

    expect(report.recommendedCandidate?.candidateId).toBe('eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      status: 'research_candidate_insufficient_evidence',
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'eth_carry_confluence_candidate_status',
      businessStatus: 'warn',
      recordsOut: 1,
    })
  })
})

function makeDiagnostics(input: {
  closedRows: number
  buckets: unknown[]
}) {
  return {
    status: 'insufficient_closed_outcomes',
    counts: {
      closedDiagnosticRows: input.closedRows,
    },
    summary: {
      meanNetPct: -0.4,
      winRateNetPct: 15,
      strongestPositiveBucket: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
      strongestNegativeBucket: 'confluence:funding_negative:basis_negative:direction_long_eth_short_btc',
    },
    byConfluence: input.buckets,
  }
}

function makeBucket(input: {
  bucketId: string
  closedOutcomes: number
  winRatePct: number
  meanNetPct: number
}) {
  return {
    bucketId: input.bucketId,
    count: input.closedOutcomes,
    closedOutcomes: input.closedOutcomes,
    winRatePct: input.winRatePct,
    meanGrossPct: input.meanNetPct + 0.2,
    meanFundingCashflowPct: 0,
    meanRouteCostPct: 0.2,
    meanNetPct: input.meanNetPct,
  }
}
