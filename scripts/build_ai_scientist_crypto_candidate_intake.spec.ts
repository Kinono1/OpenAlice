import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAiScientistCryptoCandidateIntakeReport,
  parseAiScientistCryptoCandidateIntakeArgs,
  runAiScientistCryptoCandidateIntake,
} from './build_ai_scientist_crypto_candidate_intake.js'

describe('build_ai_scientist_crypto_candidate_intake', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseAiScientistCryptoCandidateIntakeArgs([
      '--aiScientistRoot',
      '/ai/crypto_dl',
      '--warehouseRoot',
      '/warehouse',
      '--output',
      'null',
      '--maxRuns',
      '7',
      '--json',
      'true',
    ])).toMatchObject({
      aiScientistRoot: '/ai/crypto_dl',
      warehouseRoot: '/warehouse',
      outputPath: null,
      maxRuns: 7,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:crypto-intake']).toContain('build_ai_scientist_crypto_candidate_intake.ts')
  })

  it('summarizes warehouse and AI-Scientist candidates without authorizing execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-intake-'))
    const aiRoot = join(root, 'crypto_dl')
    const warehouseRoot = join(root, 'openalice-data')
    const runDir = join(aiRoot, 'run_auto_improve_funding_regime_real')

    await mkdir(runDir, { recursive: true })
    for (const dir of [
      'market',
      'external/derivatives',
      'normalized',
      'manifests',
      'derived',
      'runtime',
      'research',
      'logs',
    ]) {
      await mkdir(join(warehouseRoot, dir), { recursive: true })
    }
    await writeFile(join(warehouseRoot, 'logs/download.log'), 'ok\n', 'utf-8')
    await writeFile(join(runDir, 'target_proof.json'), JSON.stringify({
      status: 'not_proven',
      observed_validation_directional_accuracy: 0.52,
      observed_validation_high_confidence_precision: 0.65,
      observed_validation_high_confidence: {
        coverage: 0.05,
        precision: 0.64,
      },
      requirements: {
        holdout_not_used_for_selection: true,
        target_metric_meets_target: false,
      },
    }), 'utf-8')
    await writeFile(join(runDir, 'improvement_summary.json'), JSON.stringify({
      status: 'not_reached',
      target_reached: false,
      holdout_used_for_selection: false,
      safety: {
        research_only: true,
        promotion_eligible: false,
        paper_trading_allowed: false,
        live_trading_allowed: false,
      },
      best_candidate: {
        name: 'ridge_multi_assets_h24_lb64',
        split_policy: 'chronological_with_embargo',
        promotion_eligible: false,
        paper_trading_allowed: false,
        live_trading_allowed: false,
        validation_directional_accuracy: 0.52,
        selected_validation_high_confidence: {
          coverage: 0.05,
          precision: 0.65,
        },
        stdout_tail: JSON.stringify({ net_total_return: 0.1, sharpe_proxy: 1.2 }),
      },
    }), 'utf-8')
    await writeFile(join(runDir, 'walk_forward_evaluation.json'), JSON.stringify({
      proof_status: 'not_proven',
      fold_pass_rate: 0,
      min_fold_pass_rate: 0.67,
      folds_completed: 3,
      folds_requested: 3,
      mean_final_holdout_directional_accuracy: 0.64,
      requirements: {
        holdout_not_used_for_selection: true,
      },
      safety: {
        research_only: true,
        promotion_eligible: false,
        paper_trading_allowed: false,
        live_trading_allowed: false,
      },
    }), 'utf-8')
    await writeFile(join(runDir, 'data_manifest.json'), JSON.stringify({
      funding_feature_active: true,
      funding_available_time_policy: 'raw funding timestamp is treated as available only after that timestamp',
      funding_join_policy: 'merge_asof_backward_allow_exact_matches_false',
      selected_files: ['BTC.csv', 'ETH.csv'],
      symbol_count: 2,
      synthetic: false,
    }), 'utf-8')
    await writeFile(join(runDir, 'risk_report.json'), JSON.stringify({
      research_only: true,
      promotion_eligible: false,
      paper_trading_allowed: false,
      live_trading_allowed: false,
      leakage_controls: {
        split: 'chronological_with_embargo',
      },
    }), 'utf-8')

    const report = await buildAiScientistCryptoCandidateIntakeReport({
      aiScientistRoot: aiRoot,
      warehouseRoot,
      generatedAt: '2026-05-06T00:00:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T00:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'research_only_blocked',
      externalDataWarehouse: {
        status: 'present_with_required_dirs',
      },
      counts: {
        candidatesFound: 1,
        runsWithWalkForward: 1,
        runsWithFundingFeatures: 1,
        safetyViolations: 0,
      },
    })
    expect(report.externalDataWarehouse.requiredDirs.map(item => item.name)).toEqual([
      'market',
      'external_derivatives',
      'normalized',
      'manifests',
      'derived',
      'runtime',
      'research',
    ])
    expect(report.externalDataWarehouse.optionalDirs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'onchain', exists: false, lifecycle: 'candidate_dependent' }),
      expect.objectContaining({ name: 'metadata', exists: false, lifecycle: 'candidate_dependent' }),
      expect.objectContaining({ name: 'offline_binance_data_vision', exists: false, lifecycle: 'offline_manual' }),
    ]))
    expect(report.externalDataWarehouse.blockers.some(blocker => blocker.includes('parquet'))).toBe(false)
    expect(report.externalDataWarehouse.blockers.some(blocker => blocker.includes('onchain'))).toBe(false)
    expect(report.externalDataWarehouse.blockers.some(blocker => blocker.includes('metadata'))).toBe(false)
    expect(report.candidates[0]).toMatchObject({
      family: 'funding_regime',
      candidateId: 'ridge_multi_assets_h24_lb64',
      openAliceIntakeDecision: 'research_only_second_validation_required',
      safety: {
        researchOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        safetyViolation: false,
      },
      pitAndData: {
        holdoutNotUsedForSelection: true,
        chronologicalOrEmbargoSplit: true,
        leakageControlsPresent: true,
        fundingFeatureActive: true,
        openAlicePitAuditPassed: false,
      },
      blockers: expect.arrayContaining([
        'ai_scientist_candidate_not_execution_authority',
        'openalice_second_validation_required',
        'openalice_pit_audit_missing',
        'target_proof_status:not_proven',
        'walk_forward_proof_status:not_proven',
        'target_not_reached',
        'final_holdout_evaluation_missing',
        'fold_pass_rate_below_minimum:0<0.67',
      ]),
    })
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-intake-write-'))
    const aiRoot = join(root, 'crypto_dl')
    const warehouseRoot = join(root, 'openalice-data')
    const outputPath = join(root, 'intake.latest.json')
    await mkdir(aiRoot, { recursive: true })
    await mkdir(warehouseRoot, { recursive: true })

    const report = await runAiScientistCryptoCandidateIntake({
      aiScientistRoot: aiRoot,
      warehouseRoot,
      outputPath,
      maxRuns: 5,
      json: false,
    })

    expect(report.status).toBe('blocked_no_candidates')
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(written).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
    expect(manifest).toMatchObject({
      job: 'ai_scientist_crypto_candidate_intake',
      artifactPath: outputPath,
      businessStatus: 'fail',
      recordsOut: 0,
    })
  })
})
