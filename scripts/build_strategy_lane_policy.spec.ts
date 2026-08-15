import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildStrategyLanePolicyReport,
  parseStrategyLanePolicyArgs,
  runStrategyLanePolicy,
} from './build_strategy_lane_policy.js'

describe('build_strategy_lane_policy', () => {
  it('parses conservative default inputs', () => {
    expect(parseStrategyLanePolicyArgs([])).toMatchObject({
      paperPnlPath: 'data/research/paper_pnl_diagnostics.latest.json',
      stoplossRiskPolicyPath: 'data/runtime/p1_trading_evidence/stoploss_risk_policy.latest.json',
      bestConfigPath: 'data/research/best_config.json',
      releaseGateStatusPath: 'data/runtime/release_gate_status.json',
      outputPath: 'data/runtime/strategy_lane_policy.latest.json',
      json: false,
    })
    expect(parseStrategyLanePolicyArgs([
      '--paperPnl',
      'pnl.json',
      '--stoplossRiskPolicy',
      'stoploss.json',
      '--bestConfig',
      'best.json',
      '--releaseGate',
      'release.json',
      '--output',
      'null',
      '--json',
      'true',
    ])).toMatchObject({
      paperPnlPath: 'pnl.json',
      stoplossRiskPolicyPath: 'stoploss.json',
      bestConfigPath: 'best.json',
      releaseGateStatusPath: 'release.json',
      outputPath: null,
      json: true,
    })
  })

  it('turns lane diagnostics into one-way restrictions without approving execution', () => {
    const report = buildStrategyLanePolicyReport({
      paperPnlPath: '/repo/paper_pnl.json',
      paperPnl: makePaperPnl(),
      stoplossRiskPolicyPath: '/repo/stoploss.json',
      stoplossRiskPolicy: makeStoplossPolicy(),
      bestConfigPath: '/repo/best_config.json',
      bestConfig: {
        status: 'no_passing_config',
        selectedConfig: false,
        config: null,
      },
      releaseGateStatusPath: '/repo/release_gate.json',
      releaseGateStatus: {
        allowPaperTrading: false,
        allowLiveTrading: false,
        result: 'NO_GO',
      },
      generatedAt: '2026-05-05T00:00:00.000Z',
    })

    expect(report).toMatchObject({
      diagnosticOnly: true,
      policyMutationAllowed: false,
      paperExecutionAllowed: false,
      liveExecutionAllowed: false,
      globalBlockers: expect.arrayContaining([
        'best_config_no_passing_config',
        'release_gate_blocks_paper_trading',
        'cost_evidence_not_ok:missing',
        'stoploss_policy_promotion_blocked',
      ]),
      summary: {
        lanesReviewed: 6,
        blockNewOrders: 4,
        shadowOnly: 1,
        probation: 1,
        worstLane: 'cross_sectional',
        bestPositiveLowSampleLane: 'cross_sectional_10x',
      },
    })
    expect(report.lanes.every(lane =>
      lane.policyMutationAllowed === false &&
      lane.paperExecutionAllowed === false &&
      lane.liveExecutionAllowed === false,
    )).toBe(true)

    const micro100x = lane(report, 'microstructure_100x')
    expect(micro100x).toMatchObject({
      action: 'block_new_orders',
      severity: 'critical',
      reasons: expect.arrayContaining([
        'production_forbidden_leverage:100x',
        'stoploss_policy_blocks_lane:microstructure_100x',
        'material_negative_pf:0.78<0.9',
      ]),
    })

    const crossSectional = lane(report, 'cross_sectional')
    expect(crossSectional).toMatchObject({
      action: 'block_new_orders',
      severity: 'high',
      reasons: expect.arrayContaining([
        'cross_sectional_best_config_no_passing_config',
        'low_sample:22<30',
        'negative_total_pnl_pct:-17.9',
      ]),
    })

    expect(lane(report, 'volume_breakout_1x')).toMatchObject({
      action: 'block_new_orders',
      severity: 'high',
      reasons: expect.arrayContaining(['material_negative_pf:0.84<0.9']),
    })
    expect(lane(report, 'microstructure_10x')).toMatchObject({
      action: 'shadow_only',
      severity: 'medium',
      reasons: expect.arrayContaining([
        'pf_below_break_even:0.95<1',
        'negative_total_pnl_pct:-0.5',
      ]),
    })
    expect(lane(report, 'cross_sectional_10x')).toMatchObject({
      action: 'probation',
      severity: 'low',
      closedTrades: 5,
      totalPnlPct: 4.5,
      profitFactor: 3.05,
      reasons: expect.arrayContaining([
        'release_gate_blocks_paper_trading',
        'low_sample:5<30',
      ]),
    })
    expect(lane(report, 'cross_sectional_10x').reasons).not.toContain('cross_sectional_best_config_no_passing_config')
  })

  it('writes a diagnostic artifact and manifest without authorizing execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-strategy-lane-policy-'))
    const paperPnlPath = join(root, 'paper_pnl.json')
    const stoplossRiskPolicyPath = join(root, 'stoploss.json')
    const bestConfigPath = join(root, 'best_config.json')
    const releaseGateStatusPath = join(root, 'release_gate.json')
    const outputPath = join(root, 'strategy_lane_policy.latest.json')
    await writeFile(paperPnlPath, `${JSON.stringify(makePaperPnl())}\n`, 'utf-8')
    await writeFile(stoplossRiskPolicyPath, `${JSON.stringify(makeStoplossPolicy())}\n`, 'utf-8')
    await writeFile(bestConfigPath, `${JSON.stringify({ status: 'no_passing_config', selectedConfig: false, config: null })}\n`, 'utf-8')
    await writeFile(releaseGateStatusPath, `${JSON.stringify({ allowPaperTrading: false })}\n`, 'utf-8')

    const report = await runStrategyLanePolicy({
      paperPnlPath,
      stoplossRiskPolicyPath,
      bestConfigPath,
      releaseGateStatusPath,
      outputPath,
      json: false,
    })

    expect(report.paperExecutionAllowed).toBe(false)
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      diagnosticOnly: true,
      paperExecutionAllowed: false,
      liveExecutionAllowed: false,
      policyMutationAllowed: false,
      summary: {
        blockNewOrders: 4,
        shadowOnly: 1,
        probation: 1,
      },
    })
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'strategy_lane_policy',
      businessStatus: 'warn',
      errorClass: 'strategy_lane_global_blockers',
      recordsIn: 6,
      recordsOut: 6,
    })
  })
})

function lane(
  report: ReturnType<typeof buildStrategyLanePolicyReport>,
  laneName: string,
) {
  const item = report.lanes.find(candidate => candidate.lane === laneName)
  expect(item).toBeDefined()
  return item!
}

function makePaperPnl() {
  return {
    coverage: {
      costEvidence: {
        status: 'missing',
      },
    },
    byLane: [
      {
        key: 'microstructure_100x',
        count: 378,
        winRate: 34.1,
        totalPnlPct: -2.06,
        avgPnlPct: -0.005,
        profitFactor: 0.78,
        maxConsecutiveLosses: 9,
      },
      {
        key: 'cross_sectional',
        count: 22,
        winRate: 36.3,
        totalPnlPct: -17.9,
        avgPnlPct: -0.81,
        profitFactor: 0.48,
        maxConsecutiveLosses: 4,
      },
      {
        key: 'volume_breakout_1x',
        count: 106,
        winRate: 46.2,
        totalPnlPct: -2.2,
        avgPnlPct: -0.02,
        profitFactor: 0.84,
        maxConsecutiveLosses: 7,
      },
      {
        key: 'microstructure_10x',
        count: 301,
        winRate: 36.5,
        totalPnlPct: -0.5,
        avgPnlPct: -0.002,
        profitFactor: 0.95,
        maxConsecutiveLosses: 6,
      },
      {
        key: 'cross_sectional_10x',
        count: 5,
        winRate: 40,
        totalPnlPct: 4.5,
        avgPnlPct: 0.9,
        profitFactor: 3.05,
        maxConsecutiveLosses: 1,
      },
      {
        key: 'volume_breakout_100x',
        count: 9,
        winRate: 33.3,
        totalPnlPct: -1.3,
        avgPnlPct: -0.14,
        profitFactor: 0.28,
        maxConsecutiveLosses: 4,
      },
    ],
  }
}

function makeStoplossPolicy() {
  return {
    summary: {
      promotionBlocked: true,
    },
    recommendations: [{
      dimension: 'lane',
      key: 'microstructure_100x',
      lane: 'microstructure_100x',
      recommendedAction: 'block',
    }],
  }
}
