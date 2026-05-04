import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildP1TradingEvidenceNotification,
  buildP1TradingEvidenceNotificationFromFiles,
  parseArgs,
} from './build_p1_trading_evidence_notification.js'

describe('build_p1_trading_evidence_notification', () => {
  it('parses conservative defaults', () => {
    expect(parseArgs([])).toEqual({
      indexPath: 'data/runtime/p1_trading_evidence/p1_trading_evidence.index.latest.json',
      metaLabelReadinessPath: 'data/runtime/meta_labeling_shadow_readiness.latest.json',
      outputPath: 'data/runtime/p1_trading_evidence_notification.json',
      json: false,
    })
    expect(parseArgs(['--index', 'idx.json', '--metaPath', 'meta.json', '--output', 'null', '--json'])).toEqual({
      indexPath: 'idx.json',
      metaLabelReadinessPath: 'meta.json',
      outputPath: null,
      json: true,
    })
  })

  it('surfaces route-cost blockers without granting paper execution', () => {
    const notification = buildP1TradingEvidenceNotification({
      indexPath: 'index.json',
      metaLabelReadinessPath: 'meta.json',
      trialSourcePath: 'trial_source.json',
      gate: {
        gateStatus: 'insufficient_data',
        gateStatusBasis: 'cost_adjusted',
        accepted: 10,
        skipped: 5,
        acceptVsSkipDeltaPct: 1,
        costAdjusted: {
          acceptedClosedTrades: 4,
          acceptedWithPredictedCost: 2,
          acceptedMissingPredictedCost: 2,
          skippedWithPredictedCost: 1,
          skippedClosedOutcomes: 3,
        },
      },
      cost: {
        quarantine: true,
        quarantineReasons: ['low_cost_prediction_sample'],
        openPositionReadiness: {
          status: 'blocked_new_missing_evidence',
          totalOpenPositions: 3,
          newOpenPositions: 1,
          missingPredictedOpenEvidence: 3,
          legacyOpenPositions: 2,
        },
        routeCostShadowEligibility: {
          routeBudgetStatus: 'exceeded',
          selectedRoute: 'taker_taker',
          feeSnapshotStatus: 'manual_override',
          blockers: [
            'route_cost_shadow_eligibility_diagnostic_only',
            'route_cost_budget_exceeded:taker_taker',
          ],
        },
      },
      mfe: {
        coverage: {
          stopLossTrades: 42,
        },
      },
      trialSource: {
        status: 'blocked',
        nextPatchTargets: [{
          source: 'validation_pipeline',
          familyId: 'cross_sectional',
          missingPValueTrials: 7,
          missingFdrReportTrials: 8,
          pitAuditNotImplementedTrials: 9,
        }],
      },
      meta: {
        status: 'blocked',
        trainingAllowed: false,
        blockers: ['accepted_independent_bets_below_minimum'],
      },
    })

    expect(notification).toMatchObject({
      shouldNotify: true,
      deliveryDecision: 'notify',
      routeCostShadowEligibility: {
        routeBudgetStatus: 'exceeded',
        selectedRoute: 'taker_taker',
        feeSnapshotStatus: 'manual_override',
        blockers: expect.arrayContaining([
          'route_cost_budget_exceeded:taker_taker',
        ]),
      },
    })
    expect(notification.headline).toContain('route=exceeded/taker_taker')
    expect(notification.fullText).toContain('routeBudgetStatus=exceeded')
    expect(notification.fullText).toContain('routeSelected=taker_taker')
    expect(notification.fullText).toContain('routeFeeSnapshotStatus=manual_override')
    expect(notification.fullText).toContain('routeCostBlockers=route_cost_shadow_eligibility_diagnostic_only|route_cost_budget_exceeded:taker_taker')
    expect(notification.blockers).toEqual(expect.arrayContaining([
      'route_cost_shadow_budget_status:exceeded',
      'route_cost_shadow_eligibility_diagnostic_only',
      'route_cost_budget_exceeded:taker_taker',
      'meta_labeling_blocked',
    ]))
  })

  it('builds a notification from P1 index artifact paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-p1-notification-'))
    const outputPath = join(root, 'notification.json')
    const artifactDir = join(root, 'artifacts')
    await mkdir(artifactDir, { recursive: true })
    const gatePath = join(artifactDir, 'gate.json')
    const costPath = join(artifactDir, 'cost.json')
    const mfePath = join(artifactDir, 'mfe.json')
    const trialSourcePath = join(artifactDir, 'trial_source.json')
    const metaPath = join(artifactDir, 'meta.json')
    const indexPath = join(artifactDir, 'index.json')
    await writeFile(gatePath, JSON.stringify({ gateStatus: 'useful', costAdjusted: {} }))
    await writeFile(costPath, JSON.stringify({
      quarantine: false,
      openPositionReadiness: { status: 'ok' },
      routeCostShadowEligibility: {
        routeBudgetStatus: 'pass',
        selectedRoute: 'passive_passive',
        feeSnapshotStatus: 'runtime_verified',
        blockers: [],
      },
    }))
    await writeFile(mfePath, JSON.stringify({ coverage: { stopLossTrades: 0 } }))
    await writeFile(trialSourcePath, JSON.stringify({ status: 'clear', nextPatchTargets: [] }))
    await writeFile(metaPath, JSON.stringify({ status: 'ready', trainingAllowed: false, blockers: [] }))
    await writeFile(indexPath, JSON.stringify({
      artifacts: {
        gateEffectiveness: gatePath,
        costModelDiagnostics: costPath,
        mfeMaeStoploss: mfePath,
        trialSourceCoverage: trialSourcePath,
      },
    }))

    const notification = await buildP1TradingEvidenceNotificationFromFiles({
      indexPath,
      metaLabelReadinessPath: metaPath,
      outputPath,
      json: true,
    })

    expect(notification.shouldNotify).toBe(false)
    expect(notification.routeCostShadowEligibility).toMatchObject({
      routeBudgetStatus: 'pass',
      selectedRoute: 'passive_passive',
      blockers: [],
    })
  })
})
