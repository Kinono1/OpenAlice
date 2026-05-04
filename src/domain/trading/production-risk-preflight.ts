import { createHash } from 'node:crypto'
import type { CryptoOrderResult } from './operation-dispatcher.types.js'
import {
  FORBIDDEN_PRODUCTION_LEVERAGE_REASON_CODE,
  buildForbiddenProductionLeverageError,
  isForbiddenProductionLeverage,
} from './production-leverage-guard.js'

type UnknownRecord = Record<string, unknown>

export type ProductionRiskPreflightAction =
  | 'paper_order'
  | 'stage_order'
  | 'position_mutation'
  | 'adjust_leverage'
  | 'shadow_only'

export type ProductionRiskPreflightDecision =
  | 'reject'
  | 'cooldown'
  | 'shadow_only'
  | 'downweight'
  | 'allow'

export type ProductionRiskPolicyRuleDecision =
  | 'deny'
  | 'cooldown'
  | 'downweight'
  | 'shadow_only'
  | 'allow'

export interface ProductionRiskPreflightInput {
  lane: string | null
  symbol: string | null
  side: string | null
  leverage: number | null
  requestedAction: ProductionRiskPreflightAction
  decisionTime: string
  sourcePath: string
  riskReducing?: boolean
}

export interface ProductionRiskPreflightPolicyLike {
  status?: unknown
  mode?: unknown
  paperExecutionAllowedByThisArtifact?: unknown
  liveExecutionAllowedByThisArtifact?: unknown
  blockers?: unknown
  rules?: unknown
}

export interface ProductionRiskPreflightResult {
  allowed: boolean
  decision: ProductionRiskPreflightDecision
  reasonCodes: string[]
  matchedRules: string[]
  maxWeightMultiplier: number | null
  auditId: string
}

interface ProductionRiskRuleLike {
  ruleId: string
  decision: ProductionRiskPolicyRuleDecision
  scope: {
    lane: string | null
    symbol: string | null
    side: string | null
    minLeverage: number | null
  }
  maxWeightMultiplier: number | null
  reason: string | null
  actionReason: string[]
}

const READY_DENY_ONLY_STATUS = 'ready_deny_only'
const FAIL_CLOSED_DENY_ONLY_MODE = 'fail_closed_deny_only'
const FORBIDDEN_PRODUCTION_LANE = 'microstructure_100x'

export const READY_DENY_ONLY_PRODUCTION_RISK_POLICY: ProductionRiskPreflightPolicyLike = {
  status: READY_DENY_ONLY_STATUS,
  mode: FAIL_CLOSED_DENY_ONLY_MODE,
  paperExecutionAllowedByThisArtifact: false,
  liveExecutionAllowedByThisArtifact: false,
  blockers: [],
  rules: [],
}

export function evaluateProductionRiskPreflight(
  input: ProductionRiskPreflightInput,
  policy: ProductionRiskPreflightPolicyLike | null | undefined,
): ProductionRiskPreflightResult {
  const auditId = buildAuditId(input)
  const policyReasonCodes = evaluatePolicyReadiness(policy)
  const staticReasonCodes = evaluateStaticGuards(input)
  const structuralReasonCodes = evaluateRequiredOrderContext(input)

  const policyRules = parsePolicyRules(policy)
  const matchedRules = policyRules.filter(rule => ruleMatchesInput(rule, input))
  const ruleDecision = reduceRuleDecision(matchedRules)

  const reasonCodes = uniqueStrings([
    ...policyReasonCodes,
    ...staticReasonCodes,
    ...structuralReasonCodes,
    ...ruleDecision.reasonCodes,
  ])

  if (reasonCodes.length > 0) {
    const nonPolicyDecision =
      staticReasonCodes.length > 0 ||
      structuralReasonCodes.length > 0 ||
      ruleDecision.decision === 'reject'
        ? 'reject'
        : ruleDecision.decision
    return {
      allowed: false,
      decision: policyReasonCodes.length > 0 ? 'reject' : nonPolicyDecision,
      reasonCodes,
      matchedRules: uniqueStrings([
        ...ruleDecision.matchedRules,
        ...(staticReasonCodes.includes(FORBIDDEN_PRODUCTION_LEVERAGE_REASON_CODE)
          ? ['static:deny_leverage_ge_100x']
          : []),
        ...(staticReasonCodes.includes(`production_forbidden_lane:${FORBIDDEN_PRODUCTION_LANE}`)
          ? [`static:deny_lane_${FORBIDDEN_PRODUCTION_LANE}`]
          : []),
      ]),
      maxWeightMultiplier: ruleDecision.maxWeightMultiplier,
      auditId,
    }
  }

  return {
    allowed: true,
    decision: 'allow',
    reasonCodes: [],
    matchedRules: [],
    maxWeightMultiplier: null,
    auditId,
  }
}

export function productionRiskPreflightError(
  result: ProductionRiskPreflightResult,
): string {
  if (
    result.reasonCodes.length === 1 &&
    result.reasonCodes[0] === FORBIDDEN_PRODUCTION_LEVERAGE_REASON_CODE
  ) {
    return buildForbiddenProductionLeverageError()
  }
  return [
    `SECURITY: production_risk_preflight_${result.decision}`,
    result.reasonCodes.length > 0 ? result.reasonCodes.join(';') : 'unknown',
    `auditId=${result.auditId}`,
  ].join(': ')
}

export function productionRiskPreflightOrderResult(
  result: ProductionRiskPreflightResult,
): CryptoOrderResult {
  return {
    success: false,
    error: productionRiskPreflightError(result),
    orderStatus: 'rejected',
  }
}

function evaluatePolicyReadiness(
  policy: ProductionRiskPreflightPolicyLike | null | undefined,
): string[] {
  if (!policy || typeof policy !== 'object') {
    return ['production_risk_policy_missing']
  }

  const status = stringOrNull(policy.status)
  const mode = stringOrNull(policy.mode)
  const blockers = stringArray(policy.blockers)
  const reasons = [
    ...(status !== READY_DENY_ONLY_STATUS
      ? [`production_risk_policy_not_ready:${status ?? 'missing'}`]
      : []),
    ...(mode !== FAIL_CLOSED_DENY_ONLY_MODE
      ? [`production_risk_policy_mode_invalid:${mode ?? 'missing'}`]
      : []),
    ...(policy.paperExecutionAllowedByThisArtifact === true ||
      policy.liveExecutionAllowedByThisArtifact === true
      ? ['production_risk_policy_must_not_authorize_execution']
      : []),
    ...blockers.map(blocker => `production_risk_policy:${blocker}`),
  ]
  return uniqueStrings(reasons)
}

function evaluateStaticGuards(input: ProductionRiskPreflightInput): string[] {
  const reasons: string[] = []
  if (isForbiddenProductionLeverage(input.leverage)) {
    reasons.push(FORBIDDEN_PRODUCTION_LEVERAGE_REASON_CODE)
  }
  if (normalizeString(input.lane) === FORBIDDEN_PRODUCTION_LANE) {
    reasons.push(`production_forbidden_lane:${FORBIDDEN_PRODUCTION_LANE}`)
  }
  return reasons
}

function evaluateRequiredOrderContext(input: ProductionRiskPreflightInput): string[] {
  if (input.riskReducing === true || input.requestedAction === 'shadow_only') {
    return []
  }
  const lane = normalizeString(input.lane)
  const reasons = [
    ...(!lane || lane === 'unknown'
      ? ['production_risk_preflight_unknown_lane']
      : []),
    ...(input.leverage == null ||
      typeof input.leverage !== 'number' ||
      !Number.isFinite(input.leverage)
      ? ['production_risk_preflight_unknown_leverage']
      : []),
  ]
  return uniqueStrings(reasons)
}

function parsePolicyRules(
  policy: ProductionRiskPreflightPolicyLike | null | undefined,
): ProductionRiskRuleLike[] {
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.rules)) {
    return []
  }
  return policy.rules
    .map(item => parsePolicyRule(item))
    .filter((item): item is ProductionRiskRuleLike => item != null)
}

function parsePolicyRule(value: unknown): ProductionRiskRuleLike | null {
  const record = asRecord(value)
  if (!record) return null
  const ruleId = stringOrNull(record.ruleId)
  const decision = parseRuleDecision(record.decision)
  const scopeRecord = asRecord(record.scope)
  if (!ruleId || !decision || !scopeRecord) return null
  return {
    ruleId,
    decision,
    scope: {
      lane: stringOrNull(scopeRecord.lane),
      symbol: stringOrNull(scopeRecord.symbol),
      side: stringOrNull(scopeRecord.side),
      minLeverage: numberOrNull(scopeRecord.minLeverage),
    },
    maxWeightMultiplier: numberOrNull(record.maxWeightMultiplier),
    reason: stringOrNull(record.reason),
    actionReason: stringArray(record.actionReason),
  }
}

function ruleMatchesInput(
  rule: ProductionRiskRuleLike,
  input: ProductionRiskPreflightInput,
): boolean {
  const lane = normalizeString(input.lane)
  const symbol = normalizeString(input.symbol)
  const sideMatches = normalizedSides(input.side)
  const hasScope =
    rule.scope.minLeverage != null ||
    rule.scope.lane != null ||
    rule.scope.symbol != null ||
    rule.scope.side != null

  if (!hasScope) return false
  if (rule.scope.minLeverage != null) {
    if (
      typeof input.leverage !== 'number' ||
      !Number.isFinite(input.leverage) ||
      input.leverage < rule.scope.minLeverage
    ) {
      return false
    }
  }
  if (rule.scope.lane != null && normalizeString(rule.scope.lane) !== lane) {
    return false
  }
  if (rule.scope.symbol != null && normalizeString(rule.scope.symbol) !== symbol) {
    return false
  }
  if (
    rule.scope.side != null &&
    !sideMatches.includes(normalizeString(rule.scope.side) ?? '')
  ) {
    return false
  }
  return true
}

function reduceRuleDecision(rules: ProductionRiskRuleLike[]): {
  decision: ProductionRiskPreflightDecision
  reasonCodes: string[]
  matchedRules: string[]
  maxWeightMultiplier: number | null
} {
  const blockingRules = rules.filter(rule => rule.decision !== 'allow')
  if (blockingRules.length === 0) {
    return {
      decision: 'allow',
      reasonCodes: [],
      matchedRules: [],
      maxWeightMultiplier: null,
    }
  }
  const ordered = [...blockingRules].sort(
    (left, right) => decisionSeverity(right.decision) - decisionSeverity(left.decision),
  )
  const top = ordered[0]
  const decision = top.decision === 'deny' ? 'reject' : top.decision
  return {
    decision,
    reasonCodes: uniqueStrings(
      ordered.flatMap(rule => [
        `production_risk_policy_rule:${rule.ruleId}:${rule.decision}`,
        ...(rule.reason ? [rule.reason] : []),
        ...rule.actionReason,
      ]),
    ),
    matchedRules: ordered.map(rule => rule.ruleId),
    maxWeightMultiplier:
      decision === 'downweight'
        ? Math.min(...ordered.map(rule => rule.maxWeightMultiplier ?? 1))
        : null,
  }
}

function parseRuleDecision(value: unknown): ProductionRiskPolicyRuleDecision | null {
  if (
    value === 'deny' ||
    value === 'cooldown' ||
    value === 'downweight' ||
    value === 'shadow_only' ||
    value === 'allow'
  ) {
    return value
  }
  return null
}

function decisionSeverity(decision: ProductionRiskPolicyRuleDecision): number {
  if (decision === 'deny') return 5
  if (decision === 'cooldown') return 4
  if (decision === 'shadow_only') return 3
  if (decision === 'downweight') return 2
  return 1
}

function buildAuditId(input: ProductionRiskPreflightInput): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify({
    lane: input.lane,
    symbol: input.symbol,
    side: input.side,
    leverage: input.leverage,
    requestedAction: input.requestedAction,
    decisionTime: input.decisionTime,
    sourcePath: input.sourcePath,
    riskReducing: input.riskReducing === true,
  }))
  return `prp_${hash.digest('hex').slice(0, 16)}`
}

function normalizedSides(value: string | null): string[] {
  const side = normalizeString(value)
  if (!side) return []
  if (side === 'buy') return ['buy', 'long']
  if (side === 'sell') return ['sell', 'short']
  return [side]
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}
