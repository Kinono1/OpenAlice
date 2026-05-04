import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildProductionRiskPolicy,
  evaluateProductionRiskPolicy,
  runProductionRiskPolicy,
} from './build_production_risk_policy.js'

describe('build_production_risk_policy', () => {
  it('builds a deny-only blocked policy from quarantined P1 stop-loss evidence', () => {
    const policy = buildProductionRiskPolicy({
      stoplossRiskPolicy: makeStoplossRiskPolicy(),
      gateEffectiveness: makeGateEffectiveness(),
      stoplossRiskPolicyManifest: { evidenceTrust: 'quarantine' },
      gateEffectivenessManifest: { evidenceTrust: 'quarantine' },
      paths: sourcePaths('/repo'),
      generatedAt: '2026-05-04T00:00:00.000Z',
    })

    expect(policy).toMatchObject({
      mode: 'fail_closed_deny_only',
      tradingBehaviorChanged: false,
      paperExecutionAllowedByThisArtifact: false,
      liveExecutionAllowedByThisArtifact: false,
      sourceEvidenceTrustObserved: 'quarantine',
      status: 'blocked',
      blockers: expect.arrayContaining([
        'source_evidence_not_trusted:quarantine',
        'p1_stoploss_risk_policy_not_clear:blocked',
        'p1_gate_effectiveness_not_useful:insufficient_data',
        'p1_gate_not_cost_adjusted:insufficient_data',
      ]),
      denyRuleCount: 2,
      cooldownRuleCount: 1,
      downweightRuleCount: 1,
      shadowOnlyRuleCount: 1,
    })
    expect(policy.topDenyRules).toContain('deny_leverage_ge_100x')
    expect(policy.rules.find(rule => rule.ruleId === 'deny_leverage_ge_100x')).toMatchObject({
      decision: 'deny',
      scope: { minLeverage: 100 },
    })
  })

  it('evaluates 100x and stop-loss clusters as one-way restrictions only', () => {
    const policy = buildProductionRiskPolicy({
      stoplossRiskPolicy: makeStoplossRiskPolicy(),
      gateEffectiveness: makeGateEffectiveness(),
      stoplossRiskPolicyManifest: { evidenceTrust: 'pass' },
      gateEffectivenessManifest: { evidenceTrust: 'pass' },
      paths: sourcePaths('/repo'),
      generatedAt: '2026-05-04T00:00:00.000Z',
    })

    expect(evaluateProductionRiskPolicy({
      lane: 'anything',
      symbol: 'BTC-USDT',
      side: 'long',
      leverage: 100,
    }, policy)).toMatchObject({
      allowed: false,
      decision: 'deny',
      paperExecutionAllowedByThisDecision: false,
      liveExecutionAllowedByThisDecision: false,
      matchedRules: expect.arrayContaining(['deny_leverage_ge_100x']),
    })

    expect(evaluateProductionRiskPolicy({
      lane: 'microstructure_100x',
      symbol: 'DOGE-USDT',
      side: 'long',
      leverage: 1,
    }, policy)).toMatchObject({
      allowed: false,
      decision: 'deny',
      matchedRules: expect.arrayContaining(['stoploss_lane_microstructure_100x_deny']),
      paperExecutionAllowedByThisDecision: false,
    })

    expect(evaluateProductionRiskPolicy({
      lane: 'volume_breakout_1x',
      symbol: 'WIF-USDT',
      side: 'short',
      leverage: 1,
    }, policy)).toMatchObject({
      allowed: false,
      decision: 'cooldown',
      paperExecutionAllowedByThisDecision: false,
    })

    expect(evaluateProductionRiskPolicy({
      lane: 'volume_breakout_1x',
      symbol: 'ETH-USDT',
      side: 'long',
      leverage: 1,
    }, policy)).toMatchObject({
      allowed: true,
      decision: 'downweight',
      maxWeightMultiplier: 0.5,
      paperExecutionAllowedByThisDecision: false,
    })
  })

  it('writes a runtime artifact and manifest without enabling execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-production-risk-policy-'))
    const outputPath = join(root, 'production_risk_policy.latest.json')
    const policy = await runProductionRiskPolicy({
      stoplossRiskPolicyPath: join(root, 'missing_stoploss.json'),
      gateEffectivenessPath: join(root, 'missing_gate.json'),
      stoplossRiskPolicyManifestPath: join(root, 'missing_stoploss.json.manifest.json'),
      gateEffectivenessManifestPath: join(root, 'missing_gate.json.manifest.json'),
      outputPath,
      json: false,
    })

    expect(policy.status).toBe('blocked')
    expect(policy.paperExecutionAllowedByThisArtifact).toBe(false)
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      status: 'blocked',
      paperExecutionAllowedByThisArtifact: false,
      liveExecutionAllowedByThisArtifact: false,
    })
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'production_risk_policy',
      businessStatus: 'warn',
      errorClass: 'production_risk_policy_blocked',
    })
  })
})

function makeStoplossRiskPolicy() {
  return {
    policyVersion: 'p1_stoploss_risk_policy_v1',
    status: 'blocked',
    summary: {
      reviewedItems: 4,
      block: 1,
      cooldown: 1,
      downweight: 1,
      shadowOnly: 1,
    },
    recommendations: [
      {
        dimension: 'lane',
        key: 'microstructure_100x',
        lane: 'microstructure_100x',
        symbol: null,
        side: null,
        recommendedAction: 'block',
        actionReason: ['production_forbidden_leverage:100x'],
        requiredEvidenceBeforeRelaxation: ['clean_evidence_manifest_and_dirty_worktree_pass'],
      },
      {
        dimension: 'lane_symbol_side',
        key: 'volume_breakout_1x|WIF-USDT|short',
        lane: 'volume_breakout_1x',
        symbol: 'WIF-USDT',
        side: 'short',
        recommendedAction: 'cooldown',
        actionReason: ['stoploss_count_ge_5:6'],
        requiredEvidenceBeforeRelaxation: ['prospective_accept_vs_skip_delta_after_cost_positive'],
      },
      {
        dimension: 'lane_symbol_side',
        key: 'volume_breakout_1x|ETH-USDT|long',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        recommendedAction: 'downweight',
        actionReason: ['elevated_avg_mae_bps:-30'],
        requiredEvidenceBeforeRelaxation: ['cost_model_quarantine_false'],
      },
      {
        dimension: 'symbol',
        key: 'DOGE-USDT',
        lane: null,
        symbol: 'DOGE-USDT',
        side: null,
        recommendedAction: 'shadow_only',
        actionReason: ['low_sample_tail_loss'],
        requiredEvidenceBeforeRelaxation: ['collect_more_data'],
      },
    ],
  }
}

function makeGateEffectiveness() {
  return {
    gateStatus: 'insufficient_data',
    gateStatusBasis: 'insufficient_data',
    costAdjusted: {
      acceptedClosedTrades: 945,
      acceptedWithPredictedCost: 0,
      acceptedMissingPredictedCost: 945,
      acceptVsSkipNetDeltaPct: null,
    },
  }
}

function sourcePaths(root: string) {
  return {
    stoplossRiskPolicyPath: `${root}/stoploss.json`,
    gateEffectivenessPath: `${root}/gate.json`,
    stoplossRiskPolicyManifestPath: `${root}/stoploss.json.manifest.json`,
    gateEffectivenessManifestPath: `${root}/gate.json.manifest.json`,
  }
}
