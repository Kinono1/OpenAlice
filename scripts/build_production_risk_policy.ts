/**
 * Build a deny-only production risk policy from P1 stop-loss diagnostics.
 *
 * This artifact is a one-way brake. It can deny, cooldown, downweight, or
 * mark candidates shadow-only, but it never authorizes paper/live execution.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

const DEFAULT_STOPLOSS_POLICY_PATH = 'data/runtime/p1_trading_evidence/stoploss_risk_policy.latest.json'
const DEFAULT_GATE_EFFECTIVENESS_PATH = 'data/runtime/p1_trading_evidence/gate_effectiveness_report.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/production_risk_policy.latest.json'

type UnknownRecord = Record<string, unknown>

export interface ProductionRiskPolicyArgs {
  stoplossRiskPolicyPath: string
  gateEffectivenessPath: string
  stoplossRiskPolicyManifestPath: string
  gateEffectivenessManifestPath: string
  outputPath: string
  json: boolean
}

export type ProductionRiskDecision = 'deny' | 'cooldown' | 'downweight' | 'shadow_only' | 'allow'

export interface ProductionRiskPolicyRule {
  ruleId: string
  sourceRuleKey: string | null
  sourceAction: string | null
  scope: {
    lane: string | null
    symbol: string | null
    side: string | null
    minLeverage: number | null
  }
  decision: ProductionRiskDecision
  maxWeightMultiplier: number | null
  reason: string
  actionReason: string[]
  source: 'p1_stoploss_risk_policy_v1' | 'static_production_leverage_guard'
  relaxationRequires: string[]
}

export interface ProductionRiskPolicy {
  schemaVersion: 1
  policyVersion: 'production_risk_policy_v1'
  generatedAt: string
  mode: 'fail_closed_deny_only'
  tradingBehaviorChanged: false
  paperExecutionAllowedByThisArtifact: false
  liveExecutionAllowedByThisArtifact: false
  policyMutationAllowed: false
  historicalEvidenceMutationAllowed: false
  sourceEvidenceTrustRequired: 'pass'
  sourceEvidenceTrustObserved: 'pass' | 'quarantine' | 'fail' | 'missing' | 'mixed'
  status: 'blocked' | 'ready_deny_only'
  blockers: string[]
  sourceArtifacts: {
    stoplossRiskPolicyPath: string
    gateEffectivenessPath: string
    stoplossRiskPolicyManifestPath: string
    gateEffectivenessManifestPath: string
  }
  sourceSummaries: {
    stoplossRiskPolicyStatus: string | null
    stoplossPolicyVersion: string | null
    stoplossSummary: UnknownRecord | null
    gateStatus: string | null
    gateStatusBasis: string | null
    acceptedClosedTrades: number | null
    acceptedWithPredictedCost: number | null
    acceptedMissingPredictedCost: number | null
    acceptVsSkipNetDeltaPct: number | null
  }
  ruleCounts: Record<ProductionRiskDecision, number>
  denyRuleCount: number
  cooldownRuleCount: number
  downweightRuleCount: number
  shadowOnlyRuleCount: number
  topDenyRules: string[]
  rules: ProductionRiskPolicyRule[]
  notes: string[]
}

export interface ProductionRiskCandidate {
  lane?: string | null
  symbol?: string | null
  side?: string | null
  leverage?: number | null
}

export interface ProductionRiskEvaluation {
  allowed: boolean
  decision: ProductionRiskDecision
  maxWeightMultiplier: number | null
  reasons: string[]
  matchedRules: string[]
  paperExecutionAllowedByThisDecision: false
  liveExecutionAllowedByThisDecision: false
}

export function parseProductionRiskPolicyArgs(argv: string[]): ProductionRiskPolicyArgs {
  const raw = parseRawArgs(argv)
  const stoplossRiskPolicyPath = raw.get('stoplossRiskPolicyPath') ?? DEFAULT_STOPLOSS_POLICY_PATH
  const gateEffectivenessPath = raw.get('gateEffectivenessPath') ?? DEFAULT_GATE_EFFECTIVENESS_PATH
  return {
    stoplossRiskPolicyPath,
    gateEffectivenessPath,
    stoplossRiskPolicyManifestPath: raw.get('stoplossRiskPolicyManifestPath') ?? `${stoplossRiskPolicyPath}.manifest.json`,
    gateEffectivenessManifestPath: raw.get('gateEffectivenessManifestPath') ?? `${gateEffectivenessPath}.manifest.json`,
    outputPath: raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH,
    json: parseBool(raw.get('json'), false),
  }
}

export function buildProductionRiskPolicy(input: {
  stoplossRiskPolicy: UnknownRecord | null
  gateEffectiveness: UnknownRecord | null
  stoplossRiskPolicyManifest: UnknownRecord | null
  gateEffectivenessManifest: UnknownRecord | null
  paths: ProductionRiskPolicy['sourceArtifacts']
  generatedAt?: string
}): ProductionRiskPolicy {
  const sourceEvidenceTrustObserved = combineSourceTrust([
    sourceTrust(input.stoplossRiskPolicyManifest),
    sourceTrust(input.gateEffectivenessManifest),
  ])
  const stoplossStatus = stringOrNull(input.stoplossRiskPolicy?.status)
  const gateStatus = stringOrNull(input.gateEffectiveness?.gateStatus)
  const gateStatusBasis = stringOrNull(input.gateEffectiveness?.gateStatusBasis)
  const rules = buildProductionRiskRules(input.stoplossRiskPolicy)
  const blockers = [
    ...(input.stoplossRiskPolicy == null ? ['stoploss_risk_policy_missing'] : []),
    ...(input.gateEffectiveness == null ? ['gate_effectiveness_missing'] : []),
    ...(sourceEvidenceTrustObserved !== 'pass' ? [`source_evidence_not_trusted:${sourceEvidenceTrustObserved}`] : []),
    ...(stoplossStatus !== 'clear' ? [`p1_stoploss_risk_policy_not_clear:${stoplossStatus ?? 'missing'}`] : []),
    ...(gateStatus !== 'useful' ? [`p1_gate_effectiveness_not_useful:${gateStatus ?? 'missing'}`] : []),
    ...(gateStatusBasis !== 'cost_adjusted_accept_vs_skip_net_delta' ? [`p1_gate_not_cost_adjusted:${gateStatusBasis ?? 'missing'}`] : []),
  ]
  const ruleCounts = countRules(rules)

  return {
    schemaVersion: 1,
    policyVersion: 'production_risk_policy_v1',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: 'fail_closed_deny_only',
    tradingBehaviorChanged: false,
    paperExecutionAllowedByThisArtifact: false,
    liveExecutionAllowedByThisArtifact: false,
    policyMutationAllowed: false,
    historicalEvidenceMutationAllowed: false,
    sourceEvidenceTrustRequired: 'pass',
    sourceEvidenceTrustObserved,
    status: blockers.length > 0 ? 'blocked' : 'ready_deny_only',
    blockers,
    sourceArtifacts: input.paths,
    sourceSummaries: {
      stoplossRiskPolicyStatus: stoplossStatus,
      stoplossPolicyVersion: stringOrNull(input.stoplossRiskPolicy?.policyVersion),
      stoplossSummary: asRecord(input.stoplossRiskPolicy?.summary),
      gateStatus,
      gateStatusBasis,
      acceptedClosedTrades: numberOrNull(asRecord(input.gateEffectiveness?.costAdjusted)?.acceptedClosedTrades),
      acceptedWithPredictedCost: numberOrNull(asRecord(input.gateEffectiveness?.costAdjusted)?.acceptedWithPredictedCost),
      acceptedMissingPredictedCost: numberOrNull(asRecord(input.gateEffectiveness?.costAdjusted)?.acceptedMissingPredictedCost),
      acceptVsSkipNetDeltaPct: numberOrNull(asRecord(input.gateEffectiveness?.costAdjusted)?.acceptVsSkipNetDeltaPct),
    },
    ruleCounts,
    denyRuleCount: ruleCounts.deny,
    cooldownRuleCount: ruleCounts.cooldown,
    downweightRuleCount: ruleCounts.downweight,
    shadowOnlyRuleCount: ruleCounts.shadow_only,
    topDenyRules: rules.filter(rule => rule.decision === 'deny').slice(0, 20).map(rule => rule.ruleId),
    rules,
    notes: [
      'This policy is deny-only. It can only restrict candidates and cannot authorize paper or live orders.',
      'sourceEvidenceTrust must pass before any relaxation is considered; quarantine evidence keeps the policy blocked.',
      'Downweight rules are future allocator caps only and do not grant execution permission.',
      '100x leverage is hard-denied regardless of signal confidence or allocator intent.',
    ],
  }
}

export function evaluateProductionRiskPolicy(
  candidate: ProductionRiskCandidate,
  policy: ProductionRiskPolicy | null,
): ProductionRiskEvaluation {
  if (!policy) {
    return denyEvaluation('missing_production_risk_policy', [])
  }
  const matched = policy.rules.filter(rule => ruleMatchesCandidate(rule, candidate))
  if (matched.length === 0) {
    return {
      allowed: true,
      decision: 'allow',
      maxWeightMultiplier: null,
      reasons: [],
      matchedRules: [],
      paperExecutionAllowedByThisDecision: false,
      liveExecutionAllowedByThisDecision: false,
    }
  }
  const ordered = [...matched].sort(compareDecisionSeverity)
  const decision = ordered[0].decision
  const reasons = ordered.flatMap(rule => [rule.reason, ...rule.actionReason])
  const maxWeightMultiplier = decision === 'downweight'
    ? Math.min(...ordered.map(rule => rule.maxWeightMultiplier ?? 1))
    : null
  return {
    allowed: decision === 'allow' || decision === 'downweight',
    decision,
    maxWeightMultiplier,
    reasons: [...new Set(reasons)],
    matchedRules: ordered.map(rule => rule.ruleId),
    paperExecutionAllowedByThisDecision: false,
    liveExecutionAllowedByThisDecision: false,
  }
}

export async function runProductionRiskPolicy(args: ProductionRiskPolicyArgs): Promise<ProductionRiskPolicy> {
  const startedAt = new Date()
  const paths = {
    stoplossRiskPolicyPath: resolve(args.stoplossRiskPolicyPath),
    gateEffectivenessPath: resolve(args.gateEffectivenessPath),
    stoplossRiskPolicyManifestPath: resolve(args.stoplossRiskPolicyManifestPath),
    gateEffectivenessManifestPath: resolve(args.gateEffectivenessManifestPath),
  }
  const policy = buildProductionRiskPolicy({
    stoplossRiskPolicy: await readJsonIfExists(paths.stoplossRiskPolicyPath),
    gateEffectiveness: await readJsonIfExists(paths.gateEffectivenessPath),
    stoplossRiskPolicyManifest: await readJsonIfExists(paths.stoplossRiskPolicyManifestPath),
    gateEffectivenessManifest: await readJsonIfExists(paths.gateEffectivenessManifestPath),
    paths,
  })
  const outputPath = resolve(args.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8')
  await writeEvidenceManifestForArtifact({
    job: 'production_risk_policy',
    artifactPath: outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: 0,
    businessStatus: policy.status === 'ready_deny_only' ? 'pass' : 'warn',
    recordsIn: policy.rules.length,
    recordsOut: policy.rules.length,
    errorClass: policy.status === 'ready_deny_only' ? null : 'production_risk_policy_blocked',
  })
  if (args.json) console.log(JSON.stringify(policy, null, 2))
  return policy
}

function buildProductionRiskRules(stoplossRiskPolicy: UnknownRecord | null): ProductionRiskPolicyRule[] {
  const rules: ProductionRiskPolicyRule[] = [denyLeverage100xRule()]
  const recommendations = Array.isArray(stoplossRiskPolicy?.recommendations)
    ? stoplossRiskPolicy.recommendations.filter(isRecord)
    : []
  for (const item of recommendations) {
    const sourceAction = stringOrNull(item.recommendedAction)
    const decision = mapStoplossActionToDecision(sourceAction)
    if (decision == null || decision === 'allow') continue
    const dimension = stringOrNull(item.dimension)
    const key = stringOrNull(item.key)
    rules.push({
      ruleId: `stoploss_${dimension ?? 'unknown'}_${sanitizeRuleId(key ?? 'unknown')}_${decision}`,
      sourceRuleKey: key,
      sourceAction,
      scope: scopeFromStoplossItem(item),
      decision,
      maxWeightMultiplier: decision === 'downweight' ? 0.5 : null,
      reason: `p1_stoploss_${sourceAction ?? decision}`,
      actionReason: stringArray(item.actionReason),
      source: 'p1_stoploss_risk_policy_v1',
      relaxationRequires: stringArray(item.requiredEvidenceBeforeRelaxation),
    })
  }
  return dedupeRules(rules)
}

function denyLeverage100xRule(): ProductionRiskPolicyRule {
  return {
    ruleId: 'deny_leverage_ge_100x',
    sourceRuleKey: null,
    sourceAction: 'block',
    scope: {
      lane: null,
      symbol: null,
      side: null,
      minLeverage: 100,
    },
    decision: 'deny',
    maxWeightMultiplier: null,
    reason: 'production_forbidden_leverage',
    actionReason: ['production_forbidden_leverage:100x'],
    source: 'static_production_leverage_guard',
    relaxationRequires: [
      'clean_evidence_manifest_and_dirty_worktree_pass',
      'cost_model_quarantine_false',
      'prospective_accept_vs_skip_delta_after_cost_positive',
      'stoploss_cluster_below_threshold_in_two_non_overlapping_windows',
    ],
  }
}

function mapStoplossActionToDecision(action: string | null): ProductionRiskDecision | null {
  if (action === 'block') return 'deny'
  if (action === 'cooldown') return 'cooldown'
  if (action === 'downweight') return 'downweight'
  if (action === 'shadow_only') return 'shadow_only'
  if (action === 'allow') return 'allow'
  return null
}

function scopeFromStoplossItem(item: UnknownRecord): ProductionRiskPolicyRule['scope'] {
  const dimension = stringOrNull(item.dimension)
  const key = stringOrNull(item.key)
  return {
    lane: stringOrNull(item.lane) ?? (dimension === 'lane' ? key : null),
    symbol: stringOrNull(item.symbol) ?? (dimension === 'symbol' ? key : null),
    side: stringOrNull(item.side) ?? (dimension === 'side' ? key : null),
    minLeverage: null,
  }
}

function ruleMatchesCandidate(rule: ProductionRiskPolicyRule, candidate: ProductionRiskCandidate): boolean {
  if (rule.scope.minLeverage != null && (candidate.leverage ?? 0) >= rule.scope.minLeverage) return true
  if (rule.scope.lane != null && rule.scope.lane !== candidate.lane) return false
  if (rule.scope.symbol != null && rule.scope.symbol !== candidate.symbol) return false
  if (rule.scope.side != null && rule.scope.side !== candidate.side) return false
  return rule.scope.lane != null || rule.scope.symbol != null || rule.scope.side != null
}

function compareDecisionSeverity(left: ProductionRiskPolicyRule, right: ProductionRiskPolicyRule): number {
  return decisionSeverity(right.decision) - decisionSeverity(left.decision)
}

function decisionSeverity(decision: ProductionRiskDecision): number {
  if (decision === 'deny') return 5
  if (decision === 'cooldown') return 4
  if (decision === 'shadow_only') return 3
  if (decision === 'downweight') return 2
  return 1
}

function countRules(rules: ProductionRiskPolicyRule[]): Record<ProductionRiskDecision, number> {
  return {
    deny: rules.filter(rule => rule.decision === 'deny').length,
    cooldown: rules.filter(rule => rule.decision === 'cooldown').length,
    downweight: rules.filter(rule => rule.decision === 'downweight').length,
    shadow_only: rules.filter(rule => rule.decision === 'shadow_only').length,
    allow: rules.filter(rule => rule.decision === 'allow').length,
  }
}

function combineSourceTrust(values: Array<ProductionRiskPolicy['sourceEvidenceTrustObserved']>): ProductionRiskPolicy['sourceEvidenceTrustObserved'] {
  if (values.some(value => value === 'missing')) return 'missing'
  const unique = [...new Set(values)]
  if (unique.length === 1) return unique[0]
  if (unique.includes('fail')) return 'fail'
  return 'mixed'
}

function sourceTrust(manifest: UnknownRecord | null): ProductionRiskPolicy['sourceEvidenceTrustObserved'] {
  if (!manifest) return 'missing'
  const trust = stringOrNull(manifest.evidenceTrust)
  if (trust === 'pass' || trust === 'quarantine' || trust === 'fail') return trust
  return 'missing'
}

function denyEvaluation(reason: string, matchedRules: string[]): ProductionRiskEvaluation {
  return {
    allowed: false,
    decision: 'deny',
    maxWeightMultiplier: null,
    reasons: [reason],
    matchedRules,
    paperExecutionAllowedByThisDecision: false,
    liveExecutionAllowedByThisDecision: false,
  }
}

function dedupeRules(rules: ProductionRiskPolicyRule[]): ProductionRiskPolicyRule[] {
  const seen = new Set<string>()
  const out: ProductionRiskPolicyRule[] = []
  for (const rule of rules) {
    if (seen.has(rule.ruleId)) continue
    seen.add(rule.ruleId)
    out.push(rule)
  }
  return out
}

async function readJsonIfExists(path: string): Promise<UnknownRecord | null> {
  if (!existsSync(path)) return null
  try {
    return asRecord(JSON.parse(await readFile(path, 'utf-8')))
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
    } else {
      out.set(key, next)
      index += 1
    }
  }
  return out
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return value === 'true' || value === '1' || value === 'yes'
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function isRecord(value: unknown): value is UnknownRecord {
  return asRecord(value) != null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sanitizeRuleId(value: string): string {
  return value.replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 120)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  runProductionRiskPolicy(parseProductionRiskPolicyArgs(process.argv.slice(2))).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
