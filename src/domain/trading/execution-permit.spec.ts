import { describe, expect, it } from 'vitest'
import {
  admissionDecisionId,
  type AdmissionDecisionV1,
} from '../../runtime/admission.js'
import {
  issueExecutionPermit,
  validateExecutionPermit,
  verifyExecutionPermit,
  type ExecutionAuthoritySnapshot,
  type ExecutionPermitRequest,
} from './execution-permit.js'

const NOW = new Date('2026-08-01T12:00:00.000Z')
const SOURCE_COMMIT = '1'.repeat(40)
const DIRTY_HASH = '2'.repeat(64)
const RELEASE_HASH = '3'.repeat(64)

describe('ExecutionPermitV1', () => {
  it('issues a short, single-scope paper permit from the authority snapshot', () => {
    const snapshot = makeSnapshot(makeDecision({ paperAllowed: true }))
    const result = issueExecutionPermit(makeRequest(), snapshot)
    expect(result.allowed).toBe(true)
    if (!result.allowed) return
    expect(result.permit.accountId).toBe('paper-main')
    expect(result.permit.symbol).toBe('BTC/USD')
    expect(result.permit.ticketId).toBe('ticket-1')
    expect(result.permit.idempotencyKey).toBe('intent-1')
    expect(Date.parse(result.permit.expiresAt) - NOW.getTime()).toBeLessThanOrEqual(15_000)
  })

  it('hard rejects live admission when the execution arm is false', () => {
    const snapshot = makeSnapshot(makeDecision({
      paperAllowed: true,
      liveAllowed: true,
      liveArmed: false,
    }))
    const result = issueExecutionPermit({
      ...makeRequest(),
      accountMode: 'live_guarded',
    }, snapshot)
    expect(result).toEqual({
      allowed: false,
      reasonCodes: expect.arrayContaining(['live_execution_not_armed']),
    })
  })

  it('allows a scoped, proven close without opening new risk', () => {
    const snapshot = makeSnapshot(makeDecision({}))
    const result = issueExecutionPermit({
      ...makeRequest(),
      action: 'close',
      riskReducing: true,
      completedChecks: [
        'account_fresh',
        'authority_fresh',
        'idempotency_reserved',
        'kill_switch_passed',
        'market_data_fresh',
        'positions_fresh',
        'risk_reduction_proven',
        'ticket_valid',
      ],
    }, snapshot)
    expect(result.allowed).toBe(true)
  })

  it('rejects account, asset, and process binding mismatches', () => {
    const snapshot = makeSnapshot(makeDecision({ paperAllowed: true }))
    const mismatched = {
      decision: snapshot.decision,
      identity: {
        ...snapshot.identity,
        sourceCommit: '9'.repeat(40),
      },
    }
    const result = issueExecutionPermit({
      ...makeRequest(),
      accountId: 'other-account',
      symbol: 'ETH/USD',
    }, mismatched)
    expect(result).toEqual({
      allowed: false,
      reasonCodes: expect.arrayContaining([
        'account_out_of_scope',
        'asset_out_of_scope',
        'authority_source_commit_mismatch',
      ]),
    })
  })

  it('detects permit tampering and expiry during the final recheck', () => {
    const snapshot = makeSnapshot(makeDecision({ paperAllowed: true }))
    const issued = issueExecutionPermit(makeRequest(), snapshot)
    expect(issued.allowed).toBe(true)
    if (!issued.allowed) return
    expect(() => validateExecutionPermit({
      ...issued.permit,
      symbol: 'ETH/USD',
    })).toThrow('execution_permit_hash_mismatch')

    const verified = verifyExecutionPermit({
      permit: issued.permit,
      request: makeRequest(),
      snapshot,
      now: new Date(NOW.getTime() + 20_000),
    })
    expect(verified).toEqual({
      allowed: false,
      reasonCodes: expect.arrayContaining(['execution_permit_expired']),
    })
  })
})

function makeRequest(): ExecutionPermitRequest {
  return {
    intentId: 'intent-1',
    action: 'open',
    riskReducing: false,
    accountId: 'paper-main',
    accountMode: 'paper_only',
    symbol: 'BTC/USD',
    side: 'buy',
    notionalUsd: 100,
    ticketId: 'ticket-1',
    idempotencyKey: 'intent-1',
    completedChecks: [
      'account_fresh',
      'authority_fresh',
      'idempotency_reserved',
      'kill_switch_passed',
      'limits_passed',
      'market_data_fresh',
      'positions_fresh',
      'risk_passed',
      'slippage_policy_loaded',
      'ticket_valid',
    ],
    now: NOW,
  }
}

function makeSnapshot(decision: AdmissionDecisionV1): ExecutionAuthoritySnapshot {
  return {
    decision,
    identity: {
      runtimeRole: 'primary',
      sourceCommit: SOURCE_COMMIT,
      dirtyStateHash: DIRTY_HASH,
      releaseManifestHash: RELEASE_HASH,
    },
  }
}

function makeDecision(input: {
  paperAllowed?: boolean
  liveAllowed?: boolean
  liveArmed?: boolean
}): AdmissionDecisionV1 {
  const paperAllowed = input.paperAllowed ?? false
  const liveAllowed = input.liveAllowed ?? false
  const liveArmed = input.liveArmed ?? false
  const gateIds = [
    'promotion_v2_6',
    'risk',
    'kill_switch',
    'data_freshness',
    ...(liveAllowed ? ['live_dual_approval'] : []),
  ]
  const core: Omit<AdmissionDecisionV1, 'schemaVersion' | 'decisionId'> = {
    candidateId: 'candidate-v2',
    evaluatedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    sourceCommit: SOURCE_COMMIT,
    dirtyStateHash: DIRTY_HASH,
    releaseManifestHash: RELEASE_HASH,
    stage: liveAllowed ? 'live_allowed' : paperAllowed ? 'paper_allowed' : 'research_only',
    paperTradingAllowed: paperAllowed,
    liveTradingAllowed: liveAllowed,
    liveExecutionArmed: liveArmed,
    gateResults: gateIds.map((gateId, index) => ({
      gateId,
      status: 'pass' as const,
      evidenceRefs: [String(index + 4).repeat(64).slice(0, 64)],
      reasonCodes: [],
    })),
    blockingReasons: paperAllowed ? [] : ['paper_blocked'],
    evidenceRefs: gateIds.map((_, index) => String(index + 4).repeat(64).slice(0, 64)),
    approvalRefs: liveAllowed ? ['approval-a', 'approval-b'] : [],
    accountScope: ['paper-main'],
    assetScope: ['BTC/USD'],
  }
  return {
    schemaVersion: 'admission_decision.v1',
    decisionId: admissionDecisionId(core),
    ...core,
  }
}
