import { describe, expect, it } from 'vitest'
import {
  READY_DENY_ONLY_PRODUCTION_RISK_POLICY,
  evaluateProductionRiskPreflight,
  productionRiskPreflightOrderResult,
} from './production-risk-preflight.js'
import type {
  ProductionRiskPreflightInput,
  ProductionRiskPreflightPolicyLike,
} from './production-risk-preflight.js'

const baseInput: ProductionRiskPreflightInput = {
  lane: 'volume_breakout_3x',
  symbol: 'BTC-USDT',
  side: 'buy',
  leverage: 3,
  requestedAction: 'paper_order',
  decisionTime: '2026-05-04T00:00:00.000Z',
  sourcePath: 'spec',
}

const readyPolicy: ProductionRiskPreflightPolicyLike = {
  ...READY_DENY_ONLY_PRODUCTION_RISK_POLICY,
}

function evaluate(
  input: Partial<ProductionRiskPreflightInput> = {},
  policy: ProductionRiskPreflightPolicyLike | null | undefined = readyPolicy,
) {
  return evaluateProductionRiskPreflight({ ...baseInput, ...input }, policy)
}

describe('evaluateProductionRiskPreflight', () => {
  it('fails closed when production risk policy is missing', () => {
    const result = evaluate({}, null)

    expect(result.allowed).toBe(false)
    expect(result.decision).toBe('reject')
    expect(result.reasonCodes).toContain('production_risk_policy_missing')
  })

  it('fails closed when production risk policy is blocked', () => {
    const result = evaluate({}, {
      ...readyPolicy,
      status: 'blocked',
      blockers: ['source_evidence_not_trusted:quarantine'],
    })

    expect(result.allowed).toBe(false)
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'production_risk_policy_not_ready:blocked',
      'production_risk_policy:source_evidence_not_trusted:quarantine',
    ]))
  })

  it('fails closed when production risk policy mode is invalid', () => {
    const result = evaluate({}, {
      ...readyPolicy,
      mode: 'authorize_execution',
    })

    expect(result.allowed).toBe(false)
    expect(result.reasonCodes).toContain('production_risk_policy_mode_invalid:authorize_execution')
  })

  it('fails closed when policy artifact attempts to authorize paper or live execution', () => {
    const paper = evaluate({}, {
      ...readyPolicy,
      paperExecutionAllowedByThisArtifact: true,
    })
    const live = evaluate({}, {
      ...readyPolicy,
      liveExecutionAllowedByThisArtifact: true,
    })

    expect(paper.reasonCodes).toContain('production_risk_policy_must_not_authorize_execution')
    expect(live.reasonCodes).toContain('production_risk_policy_must_not_authorize_execution')
  })

  it('hard rejects leverage >= 100', () => {
    const result = evaluate({ leverage: 100 })

    expect(result.allowed).toBe(false)
    expect(result.decision).toBe('reject')
    expect(result.reasonCodes).toContain('p0d_100x_production_hard_block')
    expect(result.matchedRules).toContain('static:deny_leverage_ge_100x')
    expect(productionRiskPreflightOrderResult(result)).toMatchObject({
      success: false,
      orderStatus: 'rejected',
      error: expect.stringContaining('p0d_100x_production_hard_block'),
    })
  })

  it('hard rejects the microstructure_100x lane even without explicit leverage', () => {
    const result = evaluate({ lane: 'microstructure_100x', leverage: null })

    expect(result.allowed).toBe(false)
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'production_forbidden_lane:microstructure_100x',
      'production_risk_preflight_unknown_leverage',
    ]))
  })

  it('rejects unknown lane and unknown leverage for order-entry fail closed', () => {
    const result = evaluate({ lane: null, leverage: null })

    expect(result.allowed).toBe(false)
    expect(result.decision).toBe('reject')
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'production_risk_preflight_unknown_lane',
      'production_risk_preflight_unknown_leverage',
    ]))
  })

  it('allows risk-reducing close orders without lane/leverage when policy is ready', () => {
    const result = evaluate({
      lane: null,
      leverage: null,
      side: 'sell',
      requestedAction: 'position_mutation',
      riskReducing: true,
    })

    expect(result).toEqual(expect.objectContaining({
      allowed: true,
      decision: 'allow',
      reasonCodes: [],
    }))
  })

  it('rejects deny rules from the production risk policy', () => {
    const result = evaluate({}, {
      ...readyPolicy,
      rules: [
        {
          ruleId: 'deny_btc',
          decision: 'deny',
          scope: { lane: null, symbol: 'BTC-USDT', side: null, minLeverage: null },
          reason: 'p1_stoploss_block',
          actionReason: ['stoploss_cluster'],
          maxWeightMultiplier: null,
        },
      ],
    })

    expect(result.allowed).toBe(false)
    expect(result.decision).toBe('reject')
    expect(result.matchedRules).toEqual(['deny_btc'])
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'production_risk_policy_rule:deny_btc:deny',
      'p1_stoploss_block',
      'stoploss_cluster',
    ]))
  })

  it('maps cooldown, shadow_only, and downweight policy decisions to non-executing decisions', () => {
    const cooldown = evaluate({}, {
      ...readyPolicy,
      rules: [
        {
          ruleId: 'cooldown_btc',
          decision: 'cooldown',
          scope: { lane: null, symbol: 'BTC-USDT', side: null, minLeverage: null },
        },
      ],
    })
    const shadowOnly = evaluate({}, {
      ...readyPolicy,
      rules: [
        {
          ruleId: 'shadow_btc',
          decision: 'shadow_only',
          scope: { lane: null, symbol: 'BTC-USDT', side: null, minLeverage: null },
        },
      ],
    })
    const downweight = evaluate({}, {
      ...readyPolicy,
      rules: [
        {
          ruleId: 'downweight_btc',
          decision: 'downweight',
          maxWeightMultiplier: 0.5,
          scope: { lane: null, symbol: 'BTC-USDT', side: null, minLeverage: null },
        },
      ],
    })

    expect(cooldown).toMatchObject({ allowed: false, decision: 'cooldown' })
    expect(shadowOnly).toMatchObject({ allowed: false, decision: 'shadow_only' })
    expect(downweight).toMatchObject({
      allowed: false,
      decision: 'downweight',
      maxWeightMultiplier: 0.5,
    })
  })

  it('uses the most severe matching policy rule', () => {
    const result = evaluate({}, {
      ...readyPolicy,
      rules: [
        {
          ruleId: 'downweight_btc',
          decision: 'downweight',
          maxWeightMultiplier: 0.5,
          scope: { lane: null, symbol: 'BTC-USDT', side: null, minLeverage: null },
        },
        {
          ruleId: 'deny_lane',
          decision: 'deny',
          scope: { lane: 'volume_breakout_3x', symbol: null, side: null, minLeverage: null },
        },
      ],
    })

    expect(result.allowed).toBe(false)
    expect(result.decision).toBe('reject')
    expect(result.matchedRules[0]).toBe('deny_lane')
  })

  it('allows a known lane with finite leverage under a ready deny-only policy', () => {
    const result = evaluate()

    expect(result).toEqual(expect.objectContaining({
      allowed: true,
      decision: 'allow',
      reasonCodes: [],
      matchedRules: [],
      maxWeightMultiplier: null,
    }))
  })
})
