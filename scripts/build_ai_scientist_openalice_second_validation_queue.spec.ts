import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAiScientistSecondValidationQueueReport,
  parseAiScientistSecondValidationQueueArgs,
  runAiScientistSecondValidationQueue,
} from './build_ai_scientist_openalice_second_validation_queue.js'

describe('build_ai_scientist_openalice_second_validation_queue', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseAiScientistSecondValidationQueueArgs([
      '--intakePath',
      '/tmp/intake.json',
      '--output',
      'null',
      '--maxCandidates',
      '3',
      '--json',
      'true',
    ])).toMatchObject({
      intakePath: '/tmp/intake.json',
      outputPath: null,
      maxCandidates: 3,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:second-validation-queue']).toContain(
      'build_ai_scientist_openalice_second_validation_queue.ts',
    )
  })

  it('queues AI-Scientist candidates as research-only OpenAlice validation work', () => {
    const intake = {
      candidates: [{
        rank: 1,
        runId: 'run_walk_forward_binance_2024_2026_event_fine_gate',
        runDir: '/ai/crypto_dl/run_walk_forward_binance_2024_2026_event_fine_gate',
        family: 'event_reversal',
        candidateId: 'direction_gbdt_regime',
        sourceFiles: ['walk_forward_evaluation.json', 'data_manifest.json'],
        evidence: {
          walkForwardPresent: true,
          finalHoldoutPresent: false,
        },
        metrics: {
          meanFinalHoldoutDirectionalAccuracy: 0.899,
          foldPassRate: 0,
        },
        pitAndData: {
          chronologicalOrEmbargoSplit: false,
          leakageControlsPresent: true,
          fundingAvailableTimePolicy: null,
        },
        safety: {
          researchOnly: true,
          promotionEligible: false,
          paperTradingAllowed: false,
          liveTradingAllowed: false,
          safetyViolation: false,
        },
        blockers: [
          'openalice_second_validation_required',
          'openalice_pit_audit_missing',
          'fold_pass_rate_below_minimum:0<0.67',
        ],
      }],
    }

    const report = buildAiScientistSecondValidationQueueReport({
      intakePath: '/tmp/intake.json',
      intake,
      maxCandidates: 5,
      generatedAt: '2026-05-06T12:00:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T12:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'queued_research_only',
      counts: {
        intakeCandidates: 1,
        queuedCandidates: 1,
        requiredGateCount: 11,
      },
    })
    expect(report.queue[0]).toMatchObject({
      queueRank: 1,
      queueStatus: 'queued_research_only',
      executionAllowed: false,
      runId: 'run_walk_forward_binance_2024_2026_event_fine_gate',
      family: 'event_reversal',
      candidateId: 'direction_gbdt_regime',
      requiredValidationGates: expect.arrayContaining([
        expect.objectContaining({
          id: 'pit_audit',
          currentStatus: 'missing',
          blockers: ['openalice_pit_audit_missing'],
        }),
        expect.objectContaining({
          id: 'wfo',
          currentStatus: 'candidate_supplied_unverified',
          blockers: ['openalice_wfo_missing'],
        }),
        expect.objectContaining({
          id: 'paper_telemetry',
          currentStatus: 'missing',
          blockers: ['paper_execution_telemetry_missing'],
        }),
      ]),
      blockers: expect.arrayContaining([
        'openalice_second_validation_required',
        'openalice_pit_audit_missing',
        'openalice_by_fdr_missing',
        'openalice_route_cost_validation_missing',
        'openalice_slippage_stress_missing',
        'openalice_risk_simulation_missing',
        'openalice_trial_ledger_missing',
        'openalice_prospective_evidence_missing',
        'paper_execution_telemetry_missing',
        'openalice_second_validation_queued_not_completed',
        'candidate_not_execution_authority',
      ]),
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'run_walk_forward_binance_2024_2026_event_fine_gate:openalice_second_validation_required',
      'openalice_second_validation_queued_not_completed',
      'ai_scientist_queue_research_only',
      'paper_execution_telemetry_missing',
    ]))
  })

  it('writes artifact and manifest sidecar without execution authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-second-validation-'))
    const intakePath = join(root, 'intake.latest.json')
    const outputPath = join(root, 'queue.latest.json')
    await mkdir(root, { recursive: true })
    await writeFile(intakePath, JSON.stringify({
      candidates: [{
        rank: 1,
        runId: 'run_candidate',
        runDir: join(root, 'run_candidate'),
        family: 'funding_regime',
        candidateId: 'candidate_a',
        sourceFiles: ['walk_forward_evaluation.json'],
        evidence: { walkForwardPresent: true },
        safety: { researchOnly: true },
        blockers: ['openalice_second_validation_required'],
      }],
    }), 'utf-8')

    const report = await runAiScientistSecondValidationQueue({
      intakePath,
      outputPath,
      maxCandidates: 2,
      json: false,
    })

    expect(report.status).toBe('queued_research_only')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_second_validation_queue',
      businessStatus: 'warn',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})
