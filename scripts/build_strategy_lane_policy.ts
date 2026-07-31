import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

export type LanePolicyAction = 'block_new_orders' | 'shadow_only' | 'probation'

interface CliArgs {
  paperPnlPath: string
  stoplossRiskPolicyPath: string
  bestConfigPath: string
  releaseGateStatusPath: string
  outputPath: string | null
  json: boolean
}

interface LaneStatsInput {
  key: string
  count: number
  winRate: number
  totalPnlPct: number
  avgPnlPct: number
  profitFactor: number | null
  maxConsecutiveLosses: number
}

export interface StrategyLanePolicyItem {
  lane: string
  action: LanePolicyAction
  severity: 'critical' | 'high' | 'medium' | 'low'
  closedTrades: number
  winRate: number
  totalPnlPct: number
  avgPnlPct: number
  profitFactor: number | null
  maxConsecutiveLosses: number
  reasons: string[]
  requiredEvidenceBeforeRelaxation: string[]
  paperExecutionAllowed: false
  liveExecutionAllowed: false
  policyMutationAllowed: false
}

export interface StrategyLanePolicyReport {
  schemaVersion: 1
  generatedAt: string
  diagnosticOnly: true
  policyMutationAllowed: false
  paperExecutionAllowed: false
  liveExecutionAllowed: false
  inputs: {
    paperPnlPath: string
    stoplossRiskPolicyPath: string
    bestConfigPath: string
    releaseGateStatusPath: string
  }
  globalBlockers: string[]
  summary: {
    lanesReviewed: number
    blockNewOrders: number
    shadowOnly: number
    probation: number
    worstLane: string | null
    bestPositiveLowSampleLane: string | null
  }
  lanes: StrategyLanePolicyItem[]
  notes: string[]
}

const DEFAULT_PAPER_PNL_PATH = 'data/research/paper_pnl_diagnostics.latest.json'
const DEFAULT_STOPLOSS_RISK_POLICY_PATH = 'data/runtime/p1_trading_evidence/stoploss_risk_policy.latest.json'
const DEFAULT_BEST_CONFIG_PATH = 'data/research/best_config.json'
const DEFAULT_RELEASE_GATE_STATUS_PATH = 'data/runtime/release_gate_status.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/strategy_lane_policy.latest.json'

export function parseStrategyLanePolicyArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    paperPnlPath: raw.get('paperPnlPath') ?? raw.get('paperPnl') ?? DEFAULT_PAPER_PNL_PATH,
    stoplossRiskPolicyPath: raw.get('stoplossRiskPolicyPath') ??
      raw.get('stoplossRiskPolicy') ??
      DEFAULT_STOPLOSS_RISK_POLICY_PATH,
    bestConfigPath: raw.get('bestConfigPath') ?? raw.get('bestConfig') ?? DEFAULT_BEST_CONFIG_PATH,
    releaseGateStatusPath: raw.get('releaseGateStatusPath') ??
      raw.get('releaseGate') ??
      DEFAULT_RELEASE_GATE_STATUS_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runStrategyLanePolicy(args: CliArgs): Promise<StrategyLanePolicyReport> {
  const startedAt = new Date()
  const paperPnlPath = resolve(args.paperPnlPath)
  const stoplossRiskPolicyPath = resolve(args.stoplossRiskPolicyPath)
  const bestConfigPath = resolve(args.bestConfigPath)
  const releaseGateStatusPath = resolve(args.releaseGateStatusPath)
  const report = buildStrategyLanePolicyReport({
    paperPnlPath,
    paperPnl: await readJsonIfExists(paperPnlPath),
    stoplossRiskPolicyPath,
    stoplossRiskPolicy: await readJsonIfExists(stoplossRiskPolicyPath),
    bestConfigPath,
    bestConfig: await readJsonIfExists(bestConfigPath),
    releaseGateStatusPath,
    releaseGateStatus: await readJsonIfExists(releaseGateStatusPath),
    generatedAt: new Date().toISOString(),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'strategy_lane_policy',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.globalBlockers.length > 0 || report.summary.blockNewOrders > 0 ? 'warn' : 'pass',
      recordsIn: report.summary.lanesReviewed,
      recordsOut: report.summary.lanesReviewed,
      errorClass: report.globalBlockers.length > 0
        ? 'strategy_lane_global_blockers'
        : report.summary.blockNewOrders > 0
          ? 'strategy_lane_blocks_recommended'
          : null,
    })
  }

  return report
}

export function buildStrategyLanePolicyReport(input: {
  paperPnlPath: string
  paperPnl: unknown
  stoplossRiskPolicyPath: string
  stoplossRiskPolicy: unknown
  bestConfigPath: string
  bestConfig: unknown
  releaseGateStatusPath: string
  releaseGateStatus: unknown
  generatedAt?: string
}): StrategyLanePolicyReport {
  const paperPnlRoot = asRecord(input.paperPnl)
  const bestConfigRoot = asRecord(input.bestConfig)
  const releaseGateRoot = asRecord(input.releaseGateStatus)
  const stoplossRoot = asRecord(input.stoplossRiskPolicy)
  const laneStoplossBlocks = extractStoplossLaneBlocks(stoplossRoot)
  const lanes = readLaneStats(paperPnlRoot)
  const globalBlockers = buildGlobalBlockers({
    paperPnlRoot,
    bestConfigRoot,
    releaseGateRoot,
    stoplossRoot,
  })
  const evaluated = lanes.map(lane => evaluateLanePolicy({
    lane,
    laneStoplossBlocks,
    bestConfigRoot,
    releaseGateRoot,
  }))
  const sorted = evaluated.sort((left, right) =>
    actionRank(left.action) - actionRank(right.action) ||
    left.totalPnlPct - right.totalPnlPct ||
    right.closedTrades - left.closedTrades ||
    left.lane.localeCompare(right.lane),
  )
  const bestPositiveLowSample = sorted
    .filter(item => item.action === 'probation' && item.totalPnlPct > 0)
    .sort((left, right) => right.profitFactorValue - left.profitFactorValue || right.totalPnlPct - left.totalPnlPct)[0]

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    diagnosticOnly: true,
    policyMutationAllowed: false,
    paperExecutionAllowed: false,
    liveExecutionAllowed: false,
    inputs: {
      paperPnlPath: resolve(input.paperPnlPath),
      stoplossRiskPolicyPath: resolve(input.stoplossRiskPolicyPath),
      bestConfigPath: resolve(input.bestConfigPath),
      releaseGateStatusPath: resolve(input.releaseGateStatusPath),
    },
    globalBlockers,
    summary: {
      lanesReviewed: sorted.length,
      blockNewOrders: sorted.filter(item => item.action === 'block_new_orders').length,
      shadowOnly: sorted.filter(item => item.action === 'shadow_only').length,
      probation: sorted.filter(item => item.action === 'probation').length,
      worstLane: sorted.length > 0 ? [...sorted].sort((left, right) => left.totalPnlPct - right.totalPnlPct)[0].lane : null,
      bestPositiveLowSampleLane: bestPositiveLowSample?.lane ?? null,
    },
    lanes: sorted.map(({ profitFactorValue, ...item }) => item),
    notes: [
      'diagnosticOnly=true: this artifact recommends lane routing but does not mutate strategy parameters or place orders.',
      'block_new_orders means the lane should not open new paper/live orders until the required evidence is collected and reviewed.',
      'probation is not an approval; it means the lane has too little evidence for promotion even if historical PnL is positive.',
      'release gate, best_config, and cost-evidence failures still dominate all lane-level observations.',
    ],
  }
}

function evaluateLanePolicy(input: {
  lane: LaneStatsInput
  laneStoplossBlocks: Set<string>
  bestConfigRoot: Record<string, unknown> | null
  releaseGateRoot: Record<string, unknown> | null
}): StrategyLanePolicyItem & { profitFactorValue: number } {
  const reasons: string[] = []
  const requiredEvidence = [
    'cost_model_quarantine_false',
    'decision_time_cost_coverage_ge_95_pct',
    'prospective_accept_vs_skip_delta_after_cost_positive',
    'two_non_overlapping_live_only_windows_pf_ge_1',
    'release_gate_allows_paper_trading',
  ]
  let action: LanePolicyAction = 'probation'
  let severity: StrategyLanePolicyItem['severity'] = 'low'
  const pf = input.lane.profitFactor
  const pfValue = pf ?? 0
  const releaseAllowsPaper = readBool(input.releaseGateRoot?.allowPaperTrading) === true
  const bestConfigNoPassing = readString(input.bestConfigRoot?.status) === 'no_passing_config' ||
    input.bestConfigRoot?.selectedConfig === false ||
    input.bestConfigRoot?.config === null

  if (!releaseAllowsPaper) {
    reasons.push('release_gate_blocks_paper_trading')
  }
  if (input.lane.key.includes('100x')) {
    reasons.push('production_forbidden_leverage:100x')
  }
  if (input.laneStoplossBlocks.has(input.lane.key)) {
    reasons.push(`stoploss_policy_blocks_lane:${input.lane.key}`)
  }
  if (input.lane.key === 'cross_sectional' && bestConfigNoPassing) {
    reasons.push('cross_sectional_best_config_no_passing_config')
  }
  if (input.lane.count >= 30 && pfValue < 0.9 && input.lane.totalPnlPct < 0) {
    reasons.push(`material_negative_pf:${round(pfValue, 6)}<0.9`)
  } else if (input.lane.count >= 30 && pfValue < 1 && input.lane.totalPnlPct < 0) {
    reasons.push(`pf_below_break_even:${round(pfValue, 6)}<1`)
  }
  if (input.lane.count < 30) {
    reasons.push(`low_sample:${input.lane.count}<30`)
  }
  if (input.lane.totalPnlPct < 0) {
    reasons.push(`negative_total_pnl_pct:${round(input.lane.totalPnlPct, 6)}`)
  }
  if (input.lane.maxConsecutiveLosses >= 8) {
    reasons.push(`loss_streak_high:${input.lane.maxConsecutiveLosses}>=8`)
  }

  if (
    reasons.some(reason =>
      reason.startsWith('production_forbidden_leverage') ||
      reason.startsWith('stoploss_policy_blocks_lane') ||
      reason.startsWith('cross_sectional_best_config_no_passing_config') ||
      reason.startsWith('material_negative_pf'),
    )
  ) {
    action = 'block_new_orders'
    severity = reasons.some(reason => reason.startsWith('production_forbidden_leverage') || reason.startsWith('stoploss_policy_blocks_lane'))
      ? 'critical'
      : 'high'
  } else if (
    reasons.some(reason =>
      reason.startsWith('pf_below_break_even') ||
      reason.startsWith('negative_total_pnl_pct'),
    )
  ) {
    action = 'shadow_only'
    severity = 'medium'
  }

  return {
    lane: input.lane.key,
    action,
    severity,
    closedTrades: input.lane.count,
    winRate: round(input.lane.winRate, 6),
    totalPnlPct: round(input.lane.totalPnlPct, 6),
    avgPnlPct: round(input.lane.avgPnlPct, 6),
    profitFactor: input.lane.profitFactor == null ? null : round(input.lane.profitFactor, 6),
    profitFactorValue: pfValue,
    maxConsecutiveLosses: input.lane.maxConsecutiveLosses,
    reasons: uniqueStrings(reasons),
    requiredEvidenceBeforeRelaxation: requiredEvidence,
    paperExecutionAllowed: false,
    liveExecutionAllowed: false,
    policyMutationAllowed: false,
  }
}

function buildGlobalBlockers(input: {
  paperPnlRoot: Record<string, unknown> | null
  bestConfigRoot: Record<string, unknown> | null
  releaseGateRoot: Record<string, unknown> | null
  stoplossRoot: Record<string, unknown> | null
}): string[] {
  const blockers: string[] = []
  if (!input.paperPnlRoot) blockers.push('paper_pnl_diagnostics_missing')
  if (readString(input.bestConfigRoot?.status) === 'no_passing_config') blockers.push('best_config_no_passing_config')
  if (readBool(input.releaseGateRoot?.allowPaperTrading) !== true) blockers.push('release_gate_blocks_paper_trading')
  const costEvidence = asRecord(asRecord(input.paperPnlRoot?.coverage)?.costEvidence)
  if (readString(costEvidence?.status) !== 'ok') {
    blockers.push(`cost_evidence_not_ok:${readString(costEvidence?.status) ?? 'missing'}`)
  }
  const stoplossSummary = asRecord(input.stoplossRoot?.summary)
  if (readBool(stoplossSummary?.promotionBlocked) === true) blockers.push('stoploss_policy_promotion_blocked')
  return uniqueStrings(blockers)
}

function readLaneStats(root: Record<string, unknown> | null): LaneStatsInput[] {
  const raw = Array.isArray(root?.byLane) ? root.byLane : []
  return raw
    .map(asRecord)
    .filter(isRecordValue)
    .flatMap(row => {
      const key = readString(row.key)
      const count = readNumber(row.count)
      if (!key || count == null) return []
      return [{
        key,
        count,
        winRate: readNumber(row.winRate) ?? 0,
        totalPnlPct: readNumber(row.totalPnlPct) ?? 0,
        avgPnlPct: readNumber(row.avgPnlPct) ?? 0,
        profitFactor: readNumber(row.profitFactor),
        maxConsecutiveLosses: readNumber(row.maxConsecutiveLosses) ?? 0,
      }]
    })
}

function extractStoplossLaneBlocks(root: Record<string, unknown> | null): Set<string> {
  const recommendations = Array.isArray(root?.recommendations) ? root.recommendations : []
  return new Set(recommendations
    .map(asRecord)
    .filter(isRecordValue)
    .filter(item => readString(item.dimension) === 'lane' && readString(item.recommendedAction) === 'block')
    .map(item => readString(item.lane) ?? readString(item.key))
    .filter((value): value is string => value != null))
}

function actionRank(action: LanePolicyAction): number {
  if (action === 'block_new_orders') return 0
  if (action === 'shadow_only') return 1
  return 2
}

async function readJsonIfExists(path: string): Promise<unknown> {
  const resolved = resolve(path)
  if (!existsSync(resolved)) return null
  return JSON.parse(await readFile(resolved, 'utf-8'))
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = argv.filter(token => token !== '--')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      out.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = tokens[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(body, next)
      index += 1
    } else {
      out.set(body, 'true')
    }
  }
  return out
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return !normalized || normalized === 'null' || normalized === 'false' || normalized === 'none'
    ? null
    : raw
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isRecordValue(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value != null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function renderConsoleSummary(report: StrategyLanePolicyReport): string {
  return [
    `strategy lane policy: lanes=${report.summary.lanesReviewed}, block=${report.summary.blockNewOrders}, shadow=${report.summary.shadowOnly}, probation=${report.summary.probation}`,
    `globalBlockers=${report.globalBlockers.join('|') || 'none'}`,
    ...report.lanes.slice(0, 10).map(item =>
      `${item.action} | ${item.lane} | trades=${item.closedTrades} | pf=${item.profitFactor ?? 'null'} | pnl=${item.totalPnlPct} | reasons=${item.reasons.join(',')}`,
    ),
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseStrategyLanePolicyArgs(process.argv.slice(2))
  runStrategyLanePolicy(args)
    .then(report => {
      if (args.json) console.log(JSON.stringify(report, null, 2))
      else console.log(renderConsoleSummary(report))
    })
    .catch(error => {
      console.error('build_strategy_lane_policy failed:', error)
      process.exit(1)
    })
}
