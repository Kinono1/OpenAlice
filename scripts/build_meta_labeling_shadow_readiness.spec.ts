import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEvidenceManifest } from '../src/runtime/evidence_manifest.js'
import {
  buildMetaLabelingShadowReadinessReport,
  parseMetaLabelingShadowReadinessArgs,
  runMetaLabelingShadowReadiness,
} from './build_meta_labeling_shadow_readiness.js'

describe('build_meta_labeling_shadow_readiness', () => {
  it('parses conservative defaults', () => {
    expect(parseMetaLabelingShadowReadinessArgs([])).toEqual({
      p1EvidenceIndexPath: 'data/runtime/p1_trading_evidence/p1_trading_evidence.index.latest.json',
      outputPath: 'data/runtime/meta_labeling_shadow_readiness.latest.json',
      json: false,
    })
    expect(parseMetaLabelingShadowReadinessArgs([
      '--p1EvidenceIndexPath',
      'tmp/p1.json',
      '--outputPath',
      'null',
      '--json',
      'true',
    ])).toEqual({
      p1EvidenceIndexPath: 'tmp/p1.json',
      outputPath: null,
      json: true,
    })
  })

  it('blocks shadow training when P1 evidence is insufficient or quarantined', () => {
    const report = buildMetaLabelingShadowReadinessReport({
      p1EvidenceIndexPath: '/repo/data/runtime/p1_trading_evidence/p1_trading_evidence.index.latest.json',
      p1EvidenceIndexManifest: buildEvidenceManifest({
        job: 'p1_trading_evidence_index',
        artifactPath: '/repo/data/runtime/p1_trading_evidence/p1_trading_evidence.index.latest.json',
        startedAt: '2026-05-03T00:00:00.000Z',
        finishedAt: '2026-05-03T00:00:01.000Z',
        exitCode: 0,
        gitSnapshot: {
          commit: 'abc',
          dirty: true,
          dirtyFilesCount: 12,
          dirtyHash: 'dirty',
        },
      }),
      gateEffectiveness: {
        gateStatus: 'insufficient_data',
        gateStatusBasis: 'insufficient_data',
        gateStatusDeltaPct: null,
        independentBets: {
          accepted: 50,
          skipped: 19,
        },
        shadowContextCoverage: {
          coveragePct: 97,
          newMissing: 3,
        },
      costAdjusted: {
        acceptedClosedTrades: 937,
        acceptedWithPredictedCost: 0,
        skippedClosedOutcomes: 1377,
        skippedWithPredictedCost: 1377,
        acceptVsSkipNetDeltaPct: null,
      },
      fillAdjusted: {
        acceptedTrades: 937,
        skippedTrades: 1377,
        acceptedWithFillAdjustedCost: 0,
        skippedWithFillAdjustedCost: 0,
        coveragePct: 0,
      },
      },
      costModelDiagnostics: {
        newWindow: {
          status: 'insufficient_data',
          reason: 'awaiting_post_enforcement_closed_trades',
          closedTrades: 0,
        },
      },
      trialLedger: {
        status: 'skeleton',
        fdrGateStatus: 'blocked_missing_complete_trial_universe',
      },
      generatedAt: '2026-05-03T00:00:02.000Z',
    })

    expect(report).toMatchObject({
      generatedAt: '2026-05-03T00:00:02.000Z',
      mode: 'shadow_only_readiness',
      primaryObjective: 'outperform_skip_after_cost',
      trainingAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      promotionAllowed: false,
      modelMayControlLeverage: false,
      modelMayRouteOrders: false,
      status: 'blocked',
      evidenceTrust: {
        indexManifestPresent: true,
        indexEvidenceTrust: 'quarantine',
        indexDqStatus: 'quarantine',
        indexGitDirty: true,
        indexGitDirtyFilesCount: 12,
      },
      metrics: {
        gateStatus: 'insufficient_data',
        gateStatusBasis: 'insufficient_data',
        acceptedCostCoveragePct: 0,
        fillAdjustedCoveragePct: 0,
        skippedClosedOutcomes: 1377,
        shadowContextCoveragePct: 97,
        shadowContextNewMissing: 3,
        costNewWindowReason: 'awaiting_post_enforcement_closed_trades',
      },
    })
    expect(report.labels).toEqual({
      primary: 'outperform_skip_after_cost',
      auxiliary: ['stop_loss', 'tail_loss', 'positive_fill_adjusted_return'],
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'p1_evidence_index_missing',
      'p1_evidence_index_not_trusted:quarantine:quarantine',
      'gate_status_not_useful:insufficient_data',
      'gate_basis_not_cost_adjusted:insufficient_data',
      'accept_vs_skip_net_delta_not_positive:missing',
      'accepted_independent_bets_below_minimum:50<100',
      'skipped_independent_bets_below_minimum:19<100',
      'shadow_context_new_missing:3',
      'accepted_cost_coverage_below_minimum:0<95',
      'fill_adjusted_coverage_below_minimum:0<95',
      'trial_ledger_not_valid:skeleton',
      'post_enforcement_cost_window_not_ok:insufficient_data:awaiting_post_enforcement_closed_trades',
    ]))
  })

  it('allows only shadow training when P1 evidence is clean and sufficient', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-meta-readiness-ready-'))
    const indexPath = join(root, 'p1_trading_evidence.index.latest.json')
    await writeJson(indexPath, { schemaVersion: 1, artifacts: {} })
    const report = buildMetaLabelingShadowReadinessReport({
      p1EvidenceIndexPath: indexPath,
      p1EvidenceIndexManifest: buildEvidenceManifest({
        job: 'p1_trading_evidence_index',
        artifactPath: indexPath,
        startedAt: '2026-05-03T00:00:00.000Z',
        finishedAt: '2026-05-03T00:00:01.000Z',
        exitCode: 0,
        gitSnapshot: {
          commit: 'abc',
          dirty: false,
          dirtyFilesCount: 0,
          dirtyHash: '',
        },
      }),
      gateEffectiveness: {
        gateStatus: 'useful',
        gateStatusBasis: 'cost_adjusted_accept_vs_skip_net_delta',
        gateStatusDeltaPct: 0.2,
        independentBets: {
          accepted: 120,
          skipped: 130,
        },
        shadowContextCoverage: {
          coveragePct: 99,
          newMissing: 0,
        },
      costAdjusted: {
        acceptedClosedTrades: 320,
        acceptedWithPredictedCost: 320,
        skippedClosedOutcomes: 340,
        skippedWithPredictedCost: 340,
        acceptVsSkipNetDeltaPct: 0.2,
      },
      fillAdjusted: {
        acceptedTrades: 320,
        skippedTrades: 340,
        acceptedWithFillAdjustedCost: 320,
        skippedWithFillAdjustedCost: 340,
        coveragePct: 100,
      },
      },
      costModelDiagnostics: {
        newWindow: {
          status: 'ok',
          reason: 'complete_predicted_open_evidence',
          closedTrades: 40,
        },
      },
      trialLedger: {
        status: 'valid',
        fdrGateStatus: 'ready_explanatory_only',
      },
      generatedAt: '2026-05-03T00:00:02.000Z',
    })

    expect(report.trainingAllowed).toBe(true)
    expect(report.status).toBe('ready_shadow_training')
    expect(report.blockers).toEqual([])
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.promotionAllowed).toBe(false)
    expect(report.modelMayControlLeverage).toBe(false)
    expect(report.modelMayRouteOrders).toBe(false)
  })

  it('writes a readiness artifact and evidence manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-meta-readiness-'))
    const p1Dir = join(root, 'p1')
    await mkdir(p1Dir, { recursive: true })
    const indexPath = join(p1Dir, 'p1_trading_evidence.index.latest.json')
    const gatePath = join(p1Dir, 'gate_effectiveness_report.latest.json')
    const costPath = join(p1Dir, 'cost_model_diagnostics.latest.json')
    const trialPath = join(p1Dir, 'trial_ledger.latest.json')
    const outputPath = join(root, 'meta_labeling_shadow_readiness.latest.json')

    await writeJson(gatePath, {
      gateStatus: 'insufficient_data',
      gateStatusBasis: 'insufficient_data',
      independentBets: { accepted: 0, skipped: 0 },
      shadowContextCoverage: { coveragePct: 0, newMissing: 0 },
      costAdjusted: {
        acceptedClosedTrades: 0,
        acceptedWithPredictedCost: 0,
        skippedClosedOutcomes: 0,
        skippedWithPredictedCost: 0,
        acceptVsSkipNetDeltaPct: null,
      },
    })
    await writeJson(costPath, {
      newWindow: {
        status: 'insufficient_data',
        reason: 'awaiting_post_enforcement_closed_trades',
        closedTrades: 0,
      },
    })
    await writeJson(trialPath, { status: 'skeleton', fdrGateStatus: 'blocked_missing_complete_trial_universe' })
    await writeJson(indexPath, {
      schemaVersion: 1,
      artifacts: {
        gateEffectiveness: gatePath,
        costModelDiagnostics: costPath,
        trialLedger: trialPath,
      },
    })
    const indexRaw = await readFile(indexPath, 'utf-8')
    await writeJson(`${indexPath}.manifest.json`, buildEvidenceManifest({
      job: 'p1_trading_evidence_index',
      artifactPath: indexPath,
      startedAt: '2026-05-03T00:00:00.000Z',
      finishedAt: '2026-05-03T00:00:01.000Z',
      exitCode: 0,
      artifactHash: sha256Hex(indexRaw),
      gitSnapshot: {
        commit: 'abc',
        dirty: false,
        dirtyFilesCount: 0,
        dirtyHash: '',
      },
    }))

    const report = await runMetaLabelingShadowReadiness({
      p1EvidenceIndexPath: indexPath,
      outputPath,
      json: true,
    })

    expect(report.trainingAllowed).toBe(false)
    const persisted = JSON.parse(await readFile(outputPath, 'utf-8'))
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(persisted).toMatchObject({
      mode: 'shadow_only_readiness',
      trainingAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
    expect(manifest).toMatchObject({
      job: 'meta_labeling_shadow_readiness',
      artifactPath: outputPath,
      businessStatus: 'warn',
      errorClass: 'meta_labeling_shadow_readiness_blocked',
    })
  })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
