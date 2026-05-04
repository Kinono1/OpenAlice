/**
 * Realtime paper-only shadow monitor.
 *
 * Runs the safe paper-shadow loop on a schedule, reads the latest decision
 * report, and writes monitor state plus local alert events. This never approves
 * live-money trading.
 *
 * Usage:
 *   pnpm paper:monitor
 *   pnpm paper:monitor:once
 *   pnpm paper:monitor -- --intervalMs 300000 --paperDataMode live_only
 */

import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  acquireRuntimeLock,
  type RuntimeLock,
} from '../src/runtime/runtime_lock.js'

const execFileAsync = promisify(execFile)

export type MonitorStatus = 'ok' | 'blocked' | 'alert' | 'error'
export type AlertSeverity = 'info' | 'warning' | 'critical'
export type MonitorPaperDataMode = 'auto' | 'live_only'

export interface MonitorCliArgs {
  intervalMs: number
  maxCycles: number | null
  once: boolean
  dryRun: boolean
  paperDataMode: MonitorPaperDataMode
  skipData: boolean
  skipOptimize: boolean
  skipValidation: boolean
  skipPaper: boolean
  skipSecondLevel: boolean
  requirePromotionV2: boolean
  timeoutMs: number
  statusPath: string
  eventsPath: string
  pidPath: string
  lockPath: string
  shadowSummaryPath: string
  paperDecisionPath: string
  promotionReadinessV2Path: string
  microstructureDecisionPath: string
}

export interface MonitorCommandPlan {
  command: string
  args: string[]
}

export interface MonitorCommandResult extends MonitorCommandPlan {
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  stdoutTail: string
  stderrTail: string
  error?: string
}

export interface MonitorAlert {
  severity: AlertSeverity
  code: string
  message: string
}

export interface MonitorMultiAccountProfileState {
  id: string
  label: string | null
  mode: string | null
  cadence: string | null
  timeframe: string | null
  strategyLane: string | null
  minDecisionIntervalMs: number | null
  leverage: number | null
  status: string | null
  proposedOrders: number
  executedTrades: number
  equity: number | null
  openPositions: number | null
  liquidationMovePctApprox: number | null
  estimatedRoundTripCostPctOfMargin: number | null
}

export interface MonitorState {
  generatedAt: string
  cycle: number
  pid: number
  status: MonitorStatus
  paperDataMode: MonitorPaperDataMode
  command: MonitorCommandResult
  alerts: MonitorAlert[]
  deliveryResults: Array<{
    channel: 'local_jsonl'
    delivered: boolean
    path: string
  }>
  safety: {
    activeAccountCount: number | null
    unsafeAccountCount: number | null
    warnings: string[]
  }
  decision: {
    status: string | null
    dataMode: string | null
    requiredBars: number | null
    blockReasons: string[]
    proposedOrders: number
    executedTrades: number
    promotionReady: boolean | null
    promotionReasons: string[]
    promotionV2: {
      finalVerdict: string | null
      required: boolean | null
      loadStatus: string | null
      humanReadableReason: string | null
    }
    liveOnlyBarsAvailable: number | null
    netEdgePct: number | null
    multiAccount: {
      enabled: boolean
      profiles: MonitorMultiAccountProfileState[]
    }
    secondLevel: {
      enabled: boolean
      profiles: MonitorMultiAccountProfileState[]
    }
  }
  paths: {
    statusPath: string
    eventsPath: string
    shadowSummaryPath: string
    paperDecisionPath: string
    promotionReadinessV2Path: string
    microstructureDecisionPath: string
  }
  notes: string[]
}

const DEFAULT_INTERVAL_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_STATUS_PATH = 'data/runtime/realtime_shadow_monitor.latest.json'
const DEFAULT_EVENTS_PATH = 'data/runtime/realtime_shadow_monitor.events.jsonl'
const DEFAULT_PID_PATH = 'data/runtime/realtime_shadow_monitor.pid'
const DEFAULT_LOCK_PATH = 'data/runtime/locks/realtime_shadow_monitor.lock'
const DEFAULT_SHADOW_SUMMARY_PATH = 'data/runtime/paper_shadow_loop.latest.json'
const DEFAULT_PAPER_DECISION_PATH = 'data/runtime/paper_decision.latest.json'
const DEFAULT_PROMOTION_READINESS_V2_PATH = 'data/runtime/strategy_promotion.latest.json'
const DEFAULT_MICROSTRUCTURE_DECISION_PATH = 'data/runtime/paper_microstructure_stress.latest.json'

export function parseMonitorArgs(argv: string[]): MonitorCliArgs {
  const raw = parseRawArgs(argv)
  const once = parseBool(raw.get('once'), false)
  const maxCycles = once
    ? 1
    : parseNullablePositiveInt(raw.get('maxCycles'), null, 'maxCycles')
  return {
    intervalMs: parsePositiveInt(raw.get('intervalMs'), DEFAULT_INTERVAL_MS, 'intervalMs'),
    maxCycles,
    once,
    dryRun: parseBool(raw.get('dryRun'), false),
    paperDataMode: parsePaperDataMode(raw.get('paperDataMode'), 'live_only'),
    skipData: parseBool(raw.get('skipData'), false),
    skipOptimize: parseBool(raw.get('skipOptimize'), true),
    skipValidation: parseBool(raw.get('skipValidation'), true),
    skipPaper: parseBool(raw.get('skipPaper'), true),
    skipSecondLevel: parseBool(raw.get('skipSecondLevel'), false),
    requirePromotionV2: parseBool(raw.get('requirePromotionV2'), true),
    timeoutMs: parsePositiveInt(raw.get('timeoutMs'), DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    statusPath: raw.get('statusPath') ?? DEFAULT_STATUS_PATH,
    eventsPath: raw.get('eventsPath') ?? DEFAULT_EVENTS_PATH,
    pidPath: raw.get('pidPath') ?? DEFAULT_PID_PATH,
    lockPath: raw.get('lockPath') ?? DEFAULT_LOCK_PATH,
    shadowSummaryPath: raw.get('shadowSummaryPath') ?? DEFAULT_SHADOW_SUMMARY_PATH,
    paperDecisionPath: raw.get('paperDecisionPath') ?? DEFAULT_PAPER_DECISION_PATH,
    promotionReadinessV2Path: raw.get('promotionReadinessV2Path') ?? DEFAULT_PROMOTION_READINESS_V2_PATH,
    microstructureDecisionPath: raw.get('microstructureDecisionPath') ?? DEFAULT_MICROSTRUCTURE_DECISION_PATH,
  }
}

export function buildMonitorCommand(args: MonitorCliArgs): MonitorCommandPlan {
  const commandArgs = [
    'pnpm',
    'paper:shadow-loop',
    '--',
    '--paperDataMode',
    args.paperDataMode,
    '--skipData',
    String(args.skipData),
    '--skipOptimize',
    String(args.skipOptimize),
    '--skipValidation',
    String(args.skipValidation),
    '--skipPaper',
    String(args.skipPaper),
    '--skipSecondLevel',
    String(args.skipSecondLevel),
    '--requirePromotionV2',
    String(args.requirePromotionV2),
    '--summaryPath',
    args.shadowSummaryPath,
    '--timeoutMs',
    String(args.timeoutMs),
  ]

  return {
    command: 'corepack',
    args: commandArgs,
  }
}

export function evaluateMonitorState(input: {
  generatedAt: string
  cycle: number
  pid: number
  paperDataMode: MonitorPaperDataMode
  command: MonitorCommandResult
  shadowSummary: unknown
  paperDecision: unknown
  promotionReadinessV2?: unknown
  microstructureDecision?: unknown
  statusPath: string
  eventsPath: string
  shadowSummaryPath: string
  paperDecisionPath: string
  promotionReadinessV2Path?: string
  microstructureDecisionPath?: string
}): MonitorState {
  const alerts: MonitorAlert[] = []
  const shadow = asRecord(input.shadowSummary)
  const decision = asRecord(input.paperDecision)
  const microstructureDecision = shouldUseMicrostructureDecision(input.command.args)
    ? asRecord(input.microstructureDecision)
    : null
  const safety = asRecord(shadow?.safety)
  const unsafeAccounts = Array.isArray(safety?.unsafeAccounts) ? safety.unsafeAccounts : []
  const safetyWarnings = Array.isArray(safety?.warnings)
    ? safety.warnings.filter((item): item is string => typeof item === 'string')
    : []
  const blockReasons = Array.isArray(decision?.blockReasons)
    ? decision.blockReasons.filter((item): item is string => typeof item === 'string')
    : []
  const profileSummaries = summarizeMultiAccountProfiles(decision)
  const secondLevelSummaries = summarizePaperProfileReport(microstructureDecision)
  const hasMultiAccount = profileSummaries.length > 0
  const baseProposedOrders = hasMultiAccount
    ? profileSummaries
      .filter(profile => profile.mode !== 'stress_only')
      .reduce((sum, profile) => sum + profile.proposedOrders, 0)
    : Array.isArray(decision?.proposedOrders) ? decision.proposedOrders.length : 0
  const baseExecutedTrades = hasMultiAccount
    ? profileSummaries
      .filter(profile => profile.mode !== 'stress_only')
      .reduce((sum, profile) => sum + profile.executedTrades, 0)
    : Array.isArray(decision?.executedTrades) ? decision.executedTrades.length : 0
  const secondLevelProposedOrders = secondLevelSummaries
    .filter(profile => profile.mode !== 'stress_only')
    .reduce((sum, profile) => sum + profile.proposedOrders, 0)
  const secondLevelExecutedTrades = secondLevelSummaries
    .filter(profile => profile.mode !== 'stress_only')
    .reduce((sum, profile) => sum + profile.executedTrades, 0)
  const proposedOrders = baseProposedOrders + secondLevelProposedOrders
  const executedTrades = baseExecutedTrades + secondLevelExecutedTrades
  const promotionReadiness = asRecord(decision?.promotionReadiness)
  const promotionV2FromDecision = asRecord(decision?.promotionV2)
  const promotionV2Readiness = asRecord(input.promotionReadinessV2) ?? null
  const promotionV2FinalVerdict =
    readString(promotionV2Readiness?.finalVerdict) ??
    readString(promotionV2FromDecision?.finalVerdict) ??
    null
  const promotionV2HumanReadableReason =
    readString(promotionV2Readiness?.humanReadableReason) ??
    readString(promotionV2FromDecision?.error) ??
    null
  const promotionReasons = Array.isArray(promotionReadiness?.reasons)
    ? promotionReadiness.reasons.filter((item): item is string => typeof item === 'string')
    : []

  if (input.command.status === 'failed') {
    alerts.push({
      severity: 'critical',
      code: 'shadow_loop_failed',
      message: input.command.error ?? 'paper shadow loop failed',
    })
  }
  if (shadow?.status === 'failed') {
    alerts.push({
      severity: 'critical',
      code: 'shadow_summary_failed',
      message: 'paper shadow loop summary status is failed',
    })
  }
  if (unsafeAccounts.length > 0) {
    alerts.push({
      severity: 'critical',
      code: 'unsafe_accounts',
      message: `${unsafeAccounts.length} unsafe account(s) detected`,
    })
  }
  if (input.paperDataMode !== 'live_only') {
    alerts.push({
      severity: 'warning',
      code: 'not_live_only',
      message: `monitor paperDataMode is ${input.paperDataMode}`,
    })
  }
  if (!decision) {
    alerts.push({
      severity: 'warning',
      code: 'missing_paper_decision',
      message: 'paper decision report is missing or invalid',
    })
  }
  if (blockReasons.some((reason) => reason.startsWith('news_hard_veto:'))) {
    alerts.push({
      severity: 'warning',
      code: 'news_hard_veto',
      message: 'formal/social risk gate is blocking paper decisions',
    })
  }
  if (proposedOrders > 0) {
    alerts.push({
      severity: 'warning',
      code: 'paper_orders_proposed',
      message: `${proposedOrders} paper order(s) proposed`,
    })
  }
  if (executedTrades > 0) {
    alerts.push({
      severity: 'warning',
      code: 'paper_trades_executed',
      message: `${executedTrades} local paper trade event(s) executed`,
    })
  }
  if (promotionReadiness?.ready === true) {
    alerts.push({
      severity: 'warning',
      code: 'promotion_ready_review_required',
      message: 'paper promotion readiness is true; manual review is required before any higher mode',
    })
  }
  if (promotionV2FinalVerdict === 'tiny_cap_candidate') {
    alerts.push({
      severity: 'warning',
      code: 'promotion_v2_tiny_cap_review_required',
      message: 'promotion v2.6 tiny-cap candidate requires manual review before any live allocation',
    })
  }
  if (promotionV2FinalVerdict === 'quarantined') {
    alerts.push({
      severity: 'critical',
      code: 'promotion_v2_quarantined',
      message: promotionV2HumanReadableReason ?? 'promotion v2.6 readiness is quarantined',
    })
  }

  const hasCritical = alerts.some((alert) => alert.severity === 'critical')
  const hasWarning = alerts.some((alert) => alert.severity === 'warning')
  const decisionStatus = readString(decision?.status)
  const status: MonitorStatus = hasCritical
    ? 'error'
    : hasWarning
      ? 'alert'
      : decisionStatus === 'blocked'
        ? 'blocked'
        : 'ok'

  return {
    generatedAt: input.generatedAt,
    cycle: input.cycle,
    pid: input.pid,
    status,
    paperDataMode: input.paperDataMode,
    command: input.command,
    alerts,
    deliveryResults: [{
      channel: 'local_jsonl',
      delivered: true,
      path: input.eventsPath,
    }],
    safety: {
      activeAccountCount: readNumber(safety?.activeAccountCount) ?? null,
      unsafeAccountCount: unsafeAccounts.length,
      warnings: safetyWarnings,
    },
    decision: {
      status: decisionStatus ?? null,
      dataMode: readString(decision?.dataMode) ?? null,
      requiredBars: readNumber(decision?.requiredBars) ?? null,
      blockReasons,
      proposedOrders,
      executedTrades,
      promotionReady: typeof promotionReadiness?.ready === 'boolean' ? promotionReadiness.ready : null,
      promotionReasons,
      promotionV2: {
        finalVerdict: promotionV2FinalVerdict,
        required: typeof promotionV2FromDecision?.required === 'boolean' ? promotionV2FromDecision.required : null,
        loadStatus: readString(promotionV2FromDecision?.loadStatus) ?? null,
        humanReadableReason: promotionV2HumanReadableReason,
      },
      liveOnlyBarsAvailable: readNumber(promotionReadiness?.liveOnlyBarsAvailable) ?? null,
      netEdgePct: readNumber(promotionReadiness?.netEdgePct) ?? null,
      multiAccount: {
        enabled: hasMultiAccount,
        profiles: profileSummaries,
      },
      secondLevel: {
        enabled: secondLevelSummaries.length > 0,
        profiles: secondLevelSummaries,
      },
    },
    paths: {
      statusPath: input.statusPath,
      eventsPath: input.eventsPath,
      shadowSummaryPath: input.shadowSummaryPath,
      paperDecisionPath: input.paperDecisionPath,
      promotionReadinessV2Path: input.promotionReadinessV2Path ?? DEFAULT_PROMOTION_READINESS_V2_PATH,
      microstructureDecisionPath: input.microstructureDecisionPath ?? DEFAULT_MICROSTRUCTURE_DECISION_PATH,
    },
    notes: [
      'paper-only realtime monitor',
      'uses live_only paper data mode by default',
      input.command.args.includes('true') && input.command.args[input.command.args.indexOf('--skipSecondLevel') + 1] === 'true'
        ? 'shadow loop skips second-level 1s public market data for this monitor'
        : 'shadow loop refreshes 5m and bounded 1s public market data when skipData=false',
      'does not approve live-money trading',
    ],
  }
}

function summarizeMultiAccountProfiles(decision: Record<string, unknown> | null): MonitorMultiAccountProfileState[] {
  const multiAccount = asRecord(decision?.multiAccount)
  const profiles = Array.isArray(multiAccount?.profiles) ? multiAccount.profiles : []
  return summarizeProfileRecords(profiles)
}

function shouldUseMicrostructureDecision(commandArgs: readonly string[]): boolean {
  return !commandHasBooleanArg(commandArgs, '--skipSecondLevel', true) &&
    !commandHasBooleanArg(commandArgs, '--requirePromotionV2', true)
}

function commandHasBooleanArg(commandArgs: readonly string[], key: string, value: boolean): boolean {
  const index = commandArgs.indexOf(key)
  if (index < 0) return false
  return commandArgs[index + 1] === String(value)
}

function summarizePaperProfileReport(report: Record<string, unknown> | null): MonitorMultiAccountProfileState[] {
  const profiles = Array.isArray(report?.profiles) ? report.profiles : []
  return summarizeProfileRecords(profiles)
}

function summarizeProfileRecords(profiles: unknown[]): MonitorMultiAccountProfileState[] {
  return profiles
    .map(profile => asRecord(profile))
    .filter((profile): profile is Record<string, unknown> => profile !== null)
    .map(profile => {
      const snapshot = asRecord(profile.accountSnapshot)
      const risk = asRecord(profile.risk)
      const equity = readNumber(snapshot?.equity) ?? readNumber(profile.equity) ?? null
      const openPositions = readNumber(snapshot?.openPositions) ?? readNumber(profile.openPositions) ?? null
      return {
        id: readString(profile.id) ?? '<unknown>',
        label: readString(profile.label) ?? null,
        mode: readString(profile.mode) ?? null,
        cadence: readString(profile.cadence) ?? null,
        timeframe: readString(profile.timeframe) ?? null,
        strategyLane: readString(profile.strategyLane) ?? null,
        minDecisionIntervalMs: readNumber(profile.minDecisionIntervalMs) ?? null,
        leverage: readNumber(profile.leverage) ?? null,
        status: readString(profile.status) ?? null,
        proposedOrders: Array.isArray(profile.proposedOrders) ? profile.proposedOrders.length : 0,
        executedTrades: Array.isArray(profile.executedTrades) ? profile.executedTrades.length : 0,
        equity,
        openPositions,
        liquidationMovePctApprox: readNumber(risk?.liquidationMovePctApprox) ?? null,
        estimatedRoundTripCostPctOfMargin: readNumber(risk?.estimatedRoundTripCostPctOfMargin) ?? null,
      }
    })
}

export async function runMonitorCycle(args: MonitorCliArgs, cycle: number): Promise<MonitorState> {
  const commandPlan = buildMonitorCommand(args)
  const command = args.dryRun
    ? {
      ...commandPlan,
      status: 'skipped' as const,
      durationMs: 0,
      stdoutTail: 'dry-run: command not executed',
      stderrTail: '',
    }
    : await runCommand(commandPlan, args.timeoutMs)

  const [shadowSummary, paperDecision, promotionReadinessV2, microstructureDecision] = await Promise.all([
    readJsonIfExists(args.shadowSummaryPath),
    readJsonIfExists(args.paperDecisionPath),
    readJsonIfExists(args.promotionReadinessV2Path),
    readJsonIfExists(args.microstructureDecisionPath),
  ])
  const state = evaluateMonitorState({
    generatedAt: new Date().toISOString(),
    cycle,
    pid: process.pid,
    paperDataMode: args.paperDataMode,
    command,
    shadowSummary,
    paperDecision,
    promotionReadinessV2,
    microstructureDecision,
    statusPath: resolve(args.statusPath),
    eventsPath: resolve(args.eventsPath),
    shadowSummaryPath: resolve(args.shadowSummaryPath),
    paperDecisionPath: resolve(args.paperDecisionPath),
    promotionReadinessV2Path: resolve(args.promotionReadinessV2Path),
    microstructureDecisionPath: resolve(args.microstructureDecisionPath),
  })

  await writeJson(args.statusPath, state)
  await appendJsonl(args.eventsPath, state)
  return state
}

async function main(): Promise<void> {
  const args = parseMonitorArgs(process.argv.slice(2))
  const lock = acquireMonitorLock(args.lockPath)
  if (!lock) {
    console.log(JSON.stringify({
      status: 'blocked',
      reason: 'realtime_shadow_monitor_already_running',
      lockPath: resolve(args.lockPath),
    }, null, 2))
    return
  }
  await writePid(args.pidPath)

  try {
    let stopRequested = false
    const stop = () => {
      stopRequested = true
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)

    let cycle = 0
    while (!stopRequested) {
      cycle += 1
      const state = await runMonitorCycle(args, cycle)
      console.log(JSON.stringify({
        status: state.status,
        cycle: state.cycle,
        generatedAt: state.generatedAt,
        statusPath: resolve(args.statusPath),
        eventsPath: resolve(args.eventsPath),
        alerts: state.alerts,
        decision: state.decision,
      }, null, 2))

      if (args.maxCycles !== null && cycle >= args.maxCycles) break
      await sleep(args.intervalMs)
    }
  } finally {
    lock.release()
  }
}

export function acquireMonitorLock(lockPath: string): RuntimeLock | null {
  return acquireRuntimeLock(resolve(lockPath), {
    purpose: 'realtime_shadow_monitor',
  })
}

async function runCommand(plan: MonitorCommandPlan, timeoutMs: number): Promise<MonitorCommandResult> {
  const startedAt = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(plan.command, plan.args, {
      cwd: process.cwd(),
      env: process.env,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    })
    return {
      ...plan,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
    }
  } catch (err) {
    const error = err as Error & { stdout?: string | Buffer; stderr?: string | Buffer }
    return {
      ...plan,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      stdoutTail: tail(toText(error.stdout)),
      stderrTail: tail(toText(error.stderr)),
      error: error.message,
    }
  }
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf-8'))
  } catch {
    return null
  }
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  const outPath = resolve(path)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}

async function appendJsonl(path: string, payload: unknown): Promise<void> {
  const outPath = resolve(path)
  await mkdir(dirname(outPath), { recursive: true })
  await appendFile(outPath, `${JSON.stringify(payload)}\n`, 'utf-8')
}

async function writePid(path: string): Promise<void> {
  const outPath = resolve(path)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${process.pid}\n`, 'utf-8')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const withoutPrefix = arg.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out.set(withoutPrefix, next)
      i++
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function parseNullablePositiveInt(value: string | undefined, fallback: number | null, name: string): number | null {
  if (value === undefined) return fallback
  return parsePositiveInt(value, 1, name)
}

function parsePaperDataMode(value: string | undefined, fallback: MonitorPaperDataMode): MonitorPaperDataMode {
  if (value === undefined) return fallback
  if (value === 'auto' || value === 'live_only') return value
  throw new Error(`paperDataMode must be auto or live_only, got ${value}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toText(value: string | Buffer | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : value.toString('utf-8')
}

function tail(text: string | undefined, maxLines = 80): string {
  if (!text) return ''
  const lines = text.trimEnd().split('\n')
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
