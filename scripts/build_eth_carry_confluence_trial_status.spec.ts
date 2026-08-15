import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarryConfluenceTrialStatusReport,
  parseEthCarryConfluenceTrialStatusArgs,
  runEthCarryConfluenceTrialStatus,
} from './build_eth_carry_confluence_trial_status.js'

describe('build_eth_carry_confluence_trial_status', () => {
  it('parses args and is wired as a research-only package script', () => {
    expect(parseEthCarryConfluenceTrialStatusArgs([
      '--candidatePath',
      '/tmp/candidate.json',
      '--validationPath',
      '/tmp/validation.json',
      '--diagnostics',
      '/tmp/diag.json',
      '--output',
      'none',
      '--minTotalClosedOutcomes',
      '50',
      '--minSelectedBucketClosedOutcomes',
      '12',
      '--minValidationTrades',
      '20',
      '--minValidationWindows',
      '2',
      '--maxFdrQ',
      '0.2',
      '--minProfitProbability',
      '0.6',
      '--maxLossTailProbability',
      '0.4',
      '--json',
    ])).toMatchObject({
      confluenceCandidatePath: '/tmp/candidate.json',
      confluenceValidationPath: '/tmp/validation.json',
      signalDiagnosticsPath: '/tmp/diag.json',
      outputPath: null,
      minTotalClosedOutcomes: 50,
      minSelectedBucketClosedOutcomes: 12,
      minValidationTrades: 20,
      minValidationWindows: 2,
      maxFdrQ: 0.2,
      minProfitProbability: 0.6,
      maxLossTailProbability: 0.4,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:confluence-trial-status']).toContain('build_eth_carry_confluence_trial_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_eth_carry_confluence_trial_status.ts')
  })

  it('keeps a positive selected bucket blocked when prospective and BY-FDR evidence are weak', () => {
    const report = buildEthCarryConfluenceTrialStatusReport({
      generatedAt: '2026-05-08T03:30:00.000Z',
      confluenceCandidatePath: '/tmp/missing-candidate.json',
      confluenceValidationPath: '/tmp/missing-validation.json',
      signalDiagnosticsPath: '/tmp/missing-diag.json',
      candidateArtifact: makeCandidateArtifact(),
      validationArtifact: makeValidationArtifact(),
      signalDiagnostics: makeDiagnostics(),
      args: {
        minTotalClosedOutcomes: 100,
        minSelectedBucketClosedOutcomes: 30,
        minValidationTrades: 100,
        minValidationWindows: 3,
        maxFdrQ: 0.1,
        minProfitProbability: 0.55,
        maxLossTailProbability: 0.45,
      },
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_missing_inputs',
      selectedCandidate: {
        candidateId: 'eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc',
        sourceBucketId: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
      },
      trialLedger: {
        rawM: 4,
        rawMComplete: true,
        includesFailedTrials: true,
        fdrMethodPrimary: 'BY_raw_m',
        pValuePromotionGrade: false,
      },
      evidenceCounts: {
        totalClosedOutcomes: 27,
        selectedBucketClosedOutcomes: 5,
        validationTrades: 15074,
        validationWindows: 3,
      },
      wfo: {
        status: 'pass_research_only',
        failedWindowRatio: 0,
      },
      riskSimulation: {
        status: 'pass_research_only',
      },
    })
    expect(report.trialLedger.entries).toHaveLength(4)
    expect(report.trialLedger.entries.find(entry => entry.role === 'selected')).toMatchObject({
      closedOutcomes: 5,
      wins: 3,
      pValue: 0.5,
      pValuePromotionGrade: false,
    })
    expect(report.fdr.selectedQValue).toBeGreaterThan(0.1)
    expect(report.blockers).toEqual(expect.arrayContaining([
      'trial_total_closed_outcomes_low:27<100',
      'selected_bucket_closed_outcomes_low:5<30',
      'by_fdr_q_not_passed:1>0.1',
      'p_values_research_only_not_promotion_grade',
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
    ]))
  })

  it('can become research trial watch-only without enabling execution', () => {
    const report = buildEthCarryConfluenceTrialStatusReport({
      generatedAt: '2026-05-08T03:30:00.000Z',
      confluenceCandidatePath: process.cwd(),
      confluenceValidationPath: process.cwd(),
      signalDiagnosticsPath: process.cwd(),
      candidateArtifact: makeCandidateArtifact({
        buckets: [
          makeBucket('confluence:funding_positive:basis_positive:direction_short_eth_long_btc', 40, 82.5, 0.2),
          makeBucket('confluence:funding_negative:basis_negative:direction_long_eth_short_btc', 40, 30, -0.4),
          makeBucket('confluence:funding_positive:basis_negative:direction_short_eth_long_btc', 40, 45, -0.1),
          makeBucket('confluence:funding_negative:basis_positive:direction_long_eth_short_btc', 40, 47.5, -0.05),
        ],
      }),
      validationArtifact: makeValidationArtifact(),
      signalDiagnostics: makeDiagnostics({ closedRows: 160 }),
      args: {
        minTotalClosedOutcomes: 100,
        minSelectedBucketClosedOutcomes: 30,
        minValidationTrades: 100,
        minValidationWindows: 3,
        maxFdrQ: 0.1,
        minProfitProbability: 0.55,
        maxLossTailProbability: 0.45,
      },
    })

    expect(report.status).toBe('research_trial_watch_only')
    expect(report.fdr.selectedPassed).toBe(true)
    expect(report.wfo.status).toBe('pass_research_only')
    expect(report.riskSimulation.status).toBe('pass_research_only')
    expect(report.promotionEligible).toBe(false)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.executionAllowed).toBe(false)
    expect(report.blockers).toEqual([
      'p_values_research_only_not_promotion_grade',
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'requires_independent_wfo_by_fdr_route_cost_risk_and_paper_telemetry',
    ])
  })

  it('writes the artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-confluence-trial-'))
    const candidatePath = join(root, 'candidate.json')
    const validationPath = join(root, 'validation.json')
    const diagnosticsPath = join(root, 'diagnostics.json')
    const outputPath = join(root, 'out.json')
    await mkdir(root, { recursive: true })
    await writeFile(candidatePath, JSON.stringify(makeCandidateArtifact()), 'utf-8')
    await writeFile(validationPath, JSON.stringify(makeValidationArtifact()), 'utf-8')
    await writeFile(diagnosticsPath, JSON.stringify(makeDiagnostics()), 'utf-8')

    const report = await runEthCarryConfluenceTrialStatus({
      confluenceCandidatePath: candidatePath,
      confluenceValidationPath: validationPath,
      signalDiagnosticsPath: diagnosticsPath,
      outputPath,
      minTotalClosedOutcomes: 100,
      minSelectedBucketClosedOutcomes: 30,
      minValidationTrades: 100,
      minValidationWindows: 3,
      maxFdrQ: 0.1,
      minProfitProbability: 0.55,
      maxLossTailProbability: 0.45,
      json: false,
    })

    expect(report.status).toBe('research_trial_insufficient_evidence')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      trialLedger: {
        rawM: 4,
      },
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'eth_carry_confluence_trial_status',
      businessStatus: 'warn',
      recordsIn: 4,
    })
  })
})

function makeCandidateArtifact(input: { buckets?: unknown[] } = {}) {
  return {
    recommendedCandidate: {
      candidateId: 'eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc',
      sourceBucketId: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
    },
    confluenceBuckets: input.buckets ?? [
      makeBucket('confluence:funding_negative:basis_negative:direction_long_eth_short_btc', 8, 0, -0.6224845718),
      makeBucket('confluence:funding_negative:basis_positive:direction_long_eth_short_btc', 7, 14.2857142857, -0.3409058274),
      makeBucket('confluence:funding_positive:basis_negative:direction_short_eth_long_btc', 7, 0, -0.5222281412),
      makeBucket('confluence:funding_positive:basis_positive:direction_short_eth_long_btc', 5, 60, 0.068262025),
    ],
  }
}

function makeDiagnostics(input: { closedRows?: number } = {}) {
  return {
    counts: {
      closedDiagnosticRows: input.closedRows ?? 27,
    },
    byConfluence: makeCandidateArtifact().confluenceBuckets,
  }
}

function makeValidationArtifact() {
  return {
    status: 'research_validation_passed_observation_only',
    counts: {
      tradesBuilt: 15074,
    },
    summary: {
      meanNetPct: 0.0387523716,
      winRatePct: 99.9867321215,
      passedWindows: 3,
      failedWindows: 0,
    },
  }
}

function makeBucket(bucketId: string, closedOutcomes: number, winRatePct: number, meanNetPct: number) {
  return {
    bucketId,
    count: closedOutcomes,
    closedOutcomes,
    winRatePct,
    meanGrossPct: meanNetPct + 0.2,
    meanFundingCashflowPct: 0,
    meanRouteCostPct: 0.2,
    meanNetPct,
  }
}
