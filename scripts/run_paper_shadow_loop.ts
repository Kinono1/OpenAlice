/**
 * Safe paper-shadow loop.
 *
 * This is the one-command path for improving strategy evidence without
 * allowing live-money execution. It refuses unsafe active accounts, refreshes
 * public market data, runs the optimizer/validators, then advances the local
 * paper account.
 *
 * Usage:
 *   pnpm paper:shadow-loop
 *   pnpm paper:shadow-loop -- --paperDataMode live_only
 *   pnpm paper:shadow-loop -- --skipData true
 *   pnpm paper:shadow-loop -- --dryRun true
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  buildPaperEvidenceReport,
  DEFAULT_MAX_REPORT_AGE_SECONDS,
  DEFAULT_PAPER_EVIDENCE_ROOT,
  writePaperEvidenceReport,
  type PaperEvidenceWriteResult,
} from '../src/runtime/paper_evidence_ledger.js'

const execFileAsync = promisify(execFile)

export interface UnsafeAccount {
  id: string
  type: string
  reason: string
}

export interface AccountSafetyReport {
  activeAccountCount: number
  safeAccountCount: number
  unsafeAccounts: UnsafeAccount[]
  warnings: string[]
}

export type PaperShadowDataMode = 'auto' | 'live_only'

export interface CliArgs {
  accountConfigPath: string
  summaryPath: string
  dryRun: boolean
  allowUnsafeAccounts: boolean
  skipData: boolean
  skipOptimize: boolean
  skipValidation: boolean
  skipPaper: boolean
  skipSecondLevel: boolean
  requirePromotionV2: boolean
  paperDataMode: PaperShadowDataMode
  paperEvidenceRoot: string
  paperEvidenceMaxAgeSeconds: number
  timeoutMs: number
}

interface StepPlan {
  id: string
  command: string
  args: string[]
  skipped?: boolean
  skipReason?: string
}

interface StepResult {
  id: string
  command: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  stdoutTail?: string
  stderrTail?: string
  error?: string
}

interface PaperShadowSummary {
  generatedAt: string
  dryRun: boolean
  paperDataMode: PaperShadowDataMode
  safety: AccountSafetyReport
  steps: StepResult[]
  status: 'passed' | 'failed'
  notes: string[]
}

export interface PaperShadowLoopExecutionResult {
  summary: PaperShadowSummary
  paperEvidence: PaperEvidenceWriteResult
}

const DEFAULT_ACCOUNT_CONFIG_PATH = 'data/config/accounts.json'
const DEFAULT_SUMMARY_PATH = 'data/runtime/paper_shadow_loop.latest.json'
const DEFAULT_TIMEOUT_MS = 10 * 60_000

export function evaluateAccountSafety(rawAccounts: unknown): AccountSafetyReport {
  const warnings: string[] = []
  if (!Array.isArray(rawAccounts)) {
    return {
      activeAccountCount: 0,
      safeAccountCount: 0,
      unsafeAccounts: [{
        id: '<accounts-file>',
        type: '<invalid>',
        reason: 'accounts config is not an array',
      }],
      warnings,
    }
  }

  const unsafeAccounts: UnsafeAccount[] = []
  let activeAccountCount = 0
  let safeAccountCount = 0

  for (const item of rawAccounts) {
    if (!isRecord(item)) {
      unsafeAccounts.push({
        id: '<unknown>',
        type: '<invalid>',
        reason: 'account entry is not an object',
      })
      continue
    }

    const enabled = item.enabled !== false
    if (!enabled) continue

    activeAccountCount++
    const id = readString(item.id) ?? '<missing-id>'
    const type = readString(item.type) ?? '<missing-type>'
    const brokerConfig = isRecord(item.brokerConfig) ? item.brokerConfig : {}
    const cryptoExecution = isRecord(item.cryptoExecution)
      ? item.cryptoExecution
      : undefined
    const executionMode = cryptoExecution ? readString(cryptoExecution.mode) : undefined
    if (executionMode && executionMode !== 'paper_only') {
      unsafeAccounts.push({
        id,
        type,
        reason: `cryptoExecution.mode must remain paper_only, got ${executionMode}`,
      })
      continue
    }

    if (type === 'mock') {
      safeAccountCount++
      continue
    }

    if (type === 'ccxt') {
      const sandbox = readBoolean(brokerConfig.sandbox) === true
      const demoTrading = readBoolean(brokerConfig.demoTrading) === true
      if (sandbox || demoTrading) {
        safeAccountCount++
      } else {
        unsafeAccounts.push({
          id,
          type,
          reason: 'ccxt account must set brokerConfig.sandbox=true or brokerConfig.demoTrading=true',
        })
      }
      continue
    }

    if (type === 'alpaca') {
      if (readBoolean(brokerConfig.paper) !== false) {
        safeAccountCount++
      } else {
        unsafeAccounts.push({
          id,
          type,
          reason: 'alpaca account has brokerConfig.paper=false',
        })
      }
      continue
    }

    if (type === 'ibkr') {
      if (readBoolean(brokerConfig.paper) !== false) {
        safeAccountCount++
      } else {
        unsafeAccounts.push({
          id,
          type,
          reason: 'ibkr account has brokerConfig.paper=false',
        })
      }
      continue
    }

    unsafeAccounts.push({
      id,
      type,
      reason: 'unknown broker type cannot be proven paper/demo safe',
    })
  }

  if (activeAccountCount === 0) {
    warnings.push('no active private broker account configured; running public-data and local-paper loop only')
  }

  return {
    activeAccountCount,
    safeAccountCount,
    unsafeAccounts,
    warnings,
  }
}

export function buildStepPlan(args: CliArgs): StepPlan[] {
  return [
    {
      id: 'accumulate_live_data',
      command: 'corepack',
      args: ['pnpm', 'data:accumulate'],
      skipped: args.skipData,
      skipReason: 'skipData=true',
    },
    {
      id: 'accumulate_5m_data',
      command: 'corepack',
      args: ['pnpm', 'data:accumulate-5m'],
      skipped: args.skipData,
      skipReason: 'skipData=true',
    },
    {
      id: 'accumulate_1s_data',
      command: 'corepack',
      args: ['pnpm', 'data:accumulate-1s'],
      skipped: args.skipData || args.skipSecondLevel,
      skipReason: args.skipSecondLevel ? 'skipSecondLevel=true' : 'skipData=true',
    },
    {
      id: 'paper_microstructure_stress_1s',
      command: 'corepack',
      args: buildUngatedPaperLaneArgs('paper:microstructure-stress', args),
      skipped: args.skipPaper || args.skipSecondLevel || args.requirePromotionV2,
      skipReason: args.requirePromotionV2
        ? 'requirePromotionV2=true and paper:microstructure-stress is not v2-gated'
        : args.skipSecondLevel
          ? 'skipSecondLevel=true'
          : 'skipPaper=true',
    },
    {
      id: 'paper_volume_breakout_5m',
      command: 'corepack',
      args: buildUngatedPaperLaneArgs('paper:volume-breakout', args),
      skipped: args.skipPaper || args.requirePromotionV2,
      skipReason: args.requirePromotionV2
        ? 'requirePromotionV2=true and paper:volume-breakout is not v2-gated'
        : 'skipPaper=true',
    },
    {
      id: 'continuous_improvement',
      command: 'corepack',
      args: ['pnpm', 'improve:loop'],
      skipped: args.skipOptimize,
      skipReason: 'skipOptimize=true',
    },
    {
      id: 'new_strategy_validation',
      command: 'corepack',
      args: ['pnpm', 'validate:new-strategies'],
      skipped: args.skipValidation,
      skipReason: 'skipValidation=true',
    },
    {
      id: 'paper_cross_sectional',
      command: 'corepack',
      args: buildPaperCrossSectionalArgs(args),
      skipped: args.skipPaper,
      skipReason: 'skipPaper=true',
    },
    {
      id: 'promotion_v2_publish',
      command: 'corepack',
      args: ['pnpm', 'promotion:v2:publish'],
      skipped: args.skipPaper,
      skipReason: 'skipPaper=true',
    },
  ]
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await ensureDemoTemplate()

  const accountsRaw = await readJson(args.accountConfigPath, [])
  const safety = evaluateAccountSafety(accountsRaw)
  if (safety.unsafeAccounts.length > 0 && !args.allowUnsafeAccounts) {
    const summary: PaperShadowSummary = {
      generatedAt: new Date().toISOString(),
      dryRun: args.dryRun,
      paperDataMode: args.paperDataMode,
      safety,
      steps: [],
      status: 'failed',
      notes: [
        'unsafe active accounts detected; refusing to run paper-shadow loop',
        'set sandbox/demo/paper account flags or disable the account before retrying',
      ],
    }
    await writeSummaryAndPaperEvidence(args, summary)
    throw new Error(
      `unsafe active accounts: ${safety.unsafeAccounts.map((account) => `${account.id}:${account.reason}`).join('; ')}`,
    )
  }

  const plan = buildStepPlan(args)
  const execution = await executePaperShadowLoopPlan({
    args,
    safety,
    plan,
    runStepFn: runStep,
    writeEvidenceFn: writeSummaryAndPaperEvidence,
  })
  const summary = execution.summary
  const paperEvidence = execution.paperEvidence

  console.log(JSON.stringify({
    status: summary.status,
    summaryPath: resolve(args.summaryPath),
    paperEvidence: {
      reportId: paperEvidence.ledgerEntry.reportId,
      reportPath: paperEvidence.reportPath,
      ledgerPath: paperEvidence.ledgerPath,
      latestPointerPath: paperEvidence.latestPointerPath,
      freshnessStatus: paperEvidence.ledgerEntry.freshnessStatus,
    },
    safety,
    steps: summary.steps.map((step) => ({
      id: step.id,
      status: step.status,
      durationMs: step.durationMs,
      error: step.error,
    })),
  }, null, 2))

  if (summary.status === 'failed') {
    process.exitCode = 1
  }
}

export async function executePaperShadowLoopPlan(input: {
  args: CliArgs
  safety: AccountSafetyReport
  plan: StepPlan[]
  runStepFn?: (step: StepPlan, timeoutMs: number) => Promise<StepResult>
  writeEvidenceFn?: (
    args: Pick<CliArgs, 'summaryPath' | 'paperEvidenceRoot' | 'paperEvidenceMaxAgeSeconds'>,
    summary: PaperShadowSummary,
  ) => Promise<PaperEvidenceWriteResult>
}): Promise<PaperShadowLoopExecutionResult> {
  const runStepImpl = input.runStepFn ?? runStep
  const writeEvidenceImpl = input.writeEvidenceFn ?? writeSummaryAndPaperEvidence
  const steps: StepResult[] = []
  let paperEvidence: PaperEvidenceWriteResult | null = null

  if (input.args.dryRun) {
    for (const step of input.plan) {
      steps.push({
        id: step.id,
        command: formatCommand(step.command, step.args),
        status: step.skipped ? 'skipped' : 'passed',
        durationMs: 0,
        stdoutTail: step.skipped ? step.skipReason : 'dry-run: command not executed',
      })
    }
  } else {
    const promotionStep = input.plan.find((step) => step.id === 'promotion_v2_publish')
    if (promotionStep && !promotionStep.skipped) {
      for (const step of input.plan.filter((item) => item.id !== promotionStep.id)) {
        steps.push(await runStepImpl(step, input.args.timeoutMs))
      }
      const prePromotionFailed = steps.some((step) => step.status === 'failed')
      paperEvidence = await writeEvidenceImpl(input.args, buildPaperShadowSummary({
        args: input.args,
        safety: input.safety,
        steps,
        failed: prePromotionFailed,
        notes: [
          ...paperShadowSummaryNotes(input.args),
          'current-run paper evidence was sealed before promotion_v2_publish',
        ],
      }))
      steps.push(await runStepImpl(promotionStep, input.args.timeoutMs))
    } else {
      for (const step of input.plan) {
        steps.push(await runStepImpl(step, input.args.timeoutMs))
      }
    }
  }

  const failed = steps.some((step) => step.status === 'failed')
  const summary = buildPaperShadowSummary({
    args: input.args,
    safety: input.safety,
    steps,
    failed,
    notes: paperShadowSummaryNotes(input.args),
  })
  paperEvidence = await writeEvidenceImpl(input.args, summary)
  return { summary, paperEvidence }
}

function buildPaperShadowSummary(input: {
  args: CliArgs
  safety: AccountSafetyReport
  steps: StepResult[]
  failed: boolean
  notes: string[]
}): PaperShadowSummary {
  return {
    generatedAt: new Date().toISOString(),
    dryRun: input.args.dryRun,
    paperDataMode: input.args.paperDataMode,
    safety: input.safety,
    steps: input.steps,
    status: input.failed ? 'failed' : 'passed',
    notes: input.notes,
  }
}

function paperShadowSummaryNotes(args: Pick<CliArgs, 'skipSecondLevel'>): string[] {
  return [
    'this loop never approves live-money trading',
    args.skipSecondLevel
      ? 'second-level 1s data and microstructure paper trading are skipped for this run'
      : 'low-leverage profiles refresh 5m minute data and high-leverage profiles refresh bounded 1s paper data',
    'promotion v2.6 artifacts are published only after the current paper evidence report is sealed',
    'private demo/testnet credentials should be configured only in data/config/accounts.json',
  ]
}

async function runStep(step: StepPlan, timeoutMs: number): Promise<StepResult> {
  const startedAt = Date.now()
  const commandText = formatCommand(step.command, step.args)
  if (step.skipped) {
    return {
      id: step.id,
      command: commandText,
      status: 'skipped',
      durationMs: 0,
      stdoutTail: step.skipReason,
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(step.command, step.args, {
      cwd: process.cwd(),
      env: process.env,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    })
    return {
      id: step.id,
      command: commandText,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
    }
  } catch (err) {
    const error = err as Error & { stdout?: string | Buffer; stderr?: string | Buffer }
    return {
      id: step.id,
      command: commandText,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      stdoutTail: tail(toText(error.stdout)),
      stderrTail: tail(toText(error.stderr)),
      error: error.message,
    }
  }
}

export function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    accountConfigPath: raw.get('accountConfigPath') ?? DEFAULT_ACCOUNT_CONFIG_PATH,
    summaryPath: raw.get('summaryPath') ?? DEFAULT_SUMMARY_PATH,
    dryRun: parseBool(raw.get('dryRun'), false),
    allowUnsafeAccounts: parseBool(raw.get('allowUnsafeAccounts'), false),
    skipData: parseBool(raw.get('skipData'), false),
    skipOptimize: parseBool(raw.get('skipOptimize'), false),
    skipValidation: parseBool(raw.get('skipValidation'), false),
    skipPaper: parseBool(raw.get('skipPaper'), true),
    skipSecondLevel: parseBool(raw.get('skipSecondLevel'), false),
    requirePromotionV2: parseBool(raw.get('requirePromotionV2'), true),
    paperDataMode: parsePaperDataMode(raw.get('paperDataMode'), 'auto'),
    paperEvidenceRoot: raw.get('paperEvidenceRoot') ?? DEFAULT_PAPER_EVIDENCE_ROOT,
    paperEvidenceMaxAgeSeconds: parsePositiveInt(
      raw.get('paperEvidenceMaxAgeSeconds'),
      DEFAULT_MAX_REPORT_AGE_SECONDS,
      'paperEvidenceMaxAgeSeconds',
    ),
    timeoutMs: parsePositiveInt(raw.get('timeoutMs'), DEFAULT_TIMEOUT_MS, 'timeoutMs'),
  }
}

function buildPaperCrossSectionalArgs(args: Pick<CliArgs, 'paperDataMode' | 'requirePromotionV2' | 'skipSecondLevel'>): string[] {
  const command = ['pnpm', 'paper:cross-sectional']
  const paperArgs: string[] = []
  if (args.paperDataMode !== 'auto') {
    paperArgs.push('--dataMode', args.paperDataMode)
  }
  if (args.requirePromotionV2) {
    paperArgs.push('--requirePromotionV2', 'true')
  }
  if (args.skipSecondLevel) {
    paperArgs.push('--skipSecondLevel', 'true')
  }
  return paperArgs.length > 0 ? [...command, '--', ...paperArgs] : command
}

function buildUngatedPaperLaneArgs(scriptName: string, args: Pick<CliArgs, 'requirePromotionV2'>): string[] {
  const command = ['pnpm', scriptName]
  return args.requirePromotionV2 ? command : [...command, '--', '--allowUngatedPaperLane', 'true']
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

function parsePaperDataMode(value: string | undefined, fallback: PaperShadowDataMode): PaperShadowDataMode {
  if (value === undefined) return fallback
  if (value === 'auto' || value === 'live_only') return value
  throw new Error(`paperDataMode must be auto or live_only, got ${value}`)
}

async function readJson(path: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return fallback
  }
}

async function writeSummary(path: string, summary: PaperShadowSummary): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8')
}

export async function writeSummaryAndPaperEvidence(
  args: Pick<CliArgs, 'summaryPath' | 'paperEvidenceRoot' | 'paperEvidenceMaxAgeSeconds'>,
  summary: PaperShadowSummary,
): Promise<PaperEvidenceWriteResult> {
  await writeSummary(args.summaryPath, summary)
  const report = buildPaperEvidenceReport({
    summary,
    summaryPath: args.summaryPath,
    paperDecisionPath: 'data/runtime/paper_decision.latest.json',
    paperDecision: await readJson('data/runtime/paper_decision.latest.json', null),
    now: new Date(),
    maxAllowedAgeSeconds: args.paperEvidenceMaxAgeSeconds,
  })
  return writePaperEvidenceReport({
    report,
    root: args.paperEvidenceRoot,
  })
}

async function ensureDemoTemplate(): Promise<void> {
  const templatePath = 'data/config/accounts.demo.template.json'
  const template = [
    {
      id: 'bybit-demo',
      label: 'Bybit Demo Paper-Only',
      type: 'ccxt',
      enabled: false,
      guards: [],
      brokerConfig: {
        exchange: 'bybit',
        sandbox: false,
        demoTrading: true,
        apiKey: '<BYBIT_DEMO_API_KEY>',
        apiSecret: '<BYBIT_DEMO_API_SECRET>',
        options: {
          options: {
            defaultType: 'swap',
          },
        },
      },
      cryptoExecution: {
        mode: 'paper_only',
        enableCryptoDispatcher: true,
        requireDecisionTicket: false,
        ticketTtlMs: 600000,
        idempotencyTtlMs: 1800000,
        killSwitchDefaultPolicy: 'block_new_only',
        killSwitchStatePath: 'data/runtime/kill-switch.sqlite',
        operationTimeoutMs: 30000,
      },
    },
  ]
  await mkdir(dirname(templatePath), { recursive: true })
  await writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, 'utf-8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ')
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
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
