import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeReleaseGateStatus } from '../src/runtime/release_gate_status.js'

type StrategyName =
  | 'trend'
  | 'regimeTrend'
  | 'meanReversion'
  | 'factorMeanReversion'
  | 'shockFade'
  | 'breakout'
  | 'ensemble'
  | 'enhancedCarry'
  | 'liquidationAftermath'
type GateProfile = 'stage1' | 'stage2' | 'hard'
type PartitionMode = 'none' | 'exchange' | 'exchange_regime'
type RegimeScheme = 'rule_v1' | 'kmeans_v1'
type Readiness = 'ready_for_paper' | 'candidate_needs_iteration' | 'not_ready'

interface CliArgs {
  dryRun: boolean
  trainingRoot: string
  objectiveMetric: string
  objectiveMode: 'auto' | 'max' | 'min'
  topSymbols: number
  minRows: number
  strategies: StrategyName[]
  lookbackBars: number
  feeRate: number
  slippageBps: number
  latencyBars: number
  trainBars: number
  testBars: number
  stepBars: number
  skipInsufficientSymbols: boolean
  gateProfile: GateProfile
  partitionMode: PartitionMode
  regimeScheme: RegimeScheme
  minSignificancePassRatio: number
  maxMeanPbo: number
  minMeanDsrProbability: number
  enforceSignificanceHardGate: boolean
  maxScoreWhenHardGateFails: number
  runUnitTests: boolean
  output: string
}

interface CleanSummarySymbol {
  symbol: string
  rows: number
  path: string
  baseSymbol?: string
  sourceBucket?: string | null
  exchange?: string | null
  partitionId?: string
  latestRegimeLabel?: string
}

interface RetrainResultRow {
  symbol: string
  rows: number
  objectiveMetric?: string
  objectiveMode?: string
  objectiveScore?: number | null
  selectedModel?: string
  metrics?: Record<string, number | null | undefined>
  regimeSummary?: Record<string, unknown>
}

interface ValidationRunRecord {
  symbol: string
  csvPath: string
  strategy: StrategyName
  outputPath: string
  exitCode: number
  stdout: string
  stderr: string
  report?: Record<string, any>
  error?: string
}

interface GateDefaults {
  minSignificancePassRatio: number
  maxMeanPbo: number
  minMeanDsrProbability: number
  enforceSignificanceHardGate: boolean
  maxScoreWhenHardGateFails: number
}

interface ScoreInput {
  meanAccuracyLift: number
  positiveLiftRatio: number
  paperPassRatio: number
  livePassRatio: number
  significancePassRatio: number
  meanPbo: number
  meanDsrProbability: number
  avgSharpe: number
  runUnitTests: boolean
  unitTestsPassed: boolean
  minSignificancePassRatio: number
  maxMeanPbo: number
  minMeanDsrProbability: number
  enforceSignificanceHardGate: boolean
  maxScoreWhenHardGateFails: number
}

interface ScoreResult {
  score: number
  rawScore: number
  readiness: Readiness
  hardGateApplied: boolean
  hardGateFailures: string[]
  components: Array<{ name: string; weight: number; value: number }>
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = argv.filter((token) => token !== '--')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith('--')) continue
    const withoutPrefix = token.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const key = withoutPrefix
    const next = tokens[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
  }
  return out
}

function parseIntArg(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

function parseNumberArg(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`)
  }
  return value
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function parseStrategies(raw: string | undefined): StrategyName[] {
  const value = raw ?? 'trend,meanReversion,breakout,ensemble'
  const out: StrategyName[] = []
  for (const item of value.split(',')) {
    const strategy = item.trim() as StrategyName
    if (
      strategy === 'trend' ||
      strategy === 'regimeTrend' ||
      strategy === 'meanReversion' ||
      strategy === 'factorMeanReversion' ||
      strategy === 'shockFade' ||
      strategy === 'breakout' ||
      strategy === 'ensemble' ||
      strategy === 'enhancedCarry' ||
      strategy === 'liquidationAftermath'
    ) {
      out.push(strategy)
    }
  }
  if (!out.length) {
    throw new Error(`No valid strategies in --strategies "${value}".`)
  }
  return [...new Set(out)]
}

function parseGateProfile(raw: string | undefined): GateProfile {
  const value = (raw ?? 'hard').trim().toLowerCase()
  return value === 'stage1' || value === 'stage2' || value === 'hard' ? value : 'hard'
}

function parsePartitionMode(raw: string | undefined): PartitionMode {
  const value = (raw ?? 'none').trim().toLowerCase()
  return value === 'exchange' || value === 'exchange_regime' || value === 'none'
    ? value
    : 'none'
}

function parseRegimeScheme(raw: string | undefined): RegimeScheme {
  const value = (raw ?? 'rule_v1').trim().toLowerCase()
  return value === 'rule_v1' || value === 'kmeans_v1' ? value : 'rule_v1'
}

function gateDefaults(profile: GateProfile): GateDefaults {
  if (profile === 'stage1') {
    return {
      minSignificancePassRatio: 0.05,
      maxMeanPbo: 0.75,
      minMeanDsrProbability: 0.2,
      enforceSignificanceHardGate: false,
      maxScoreWhenHardGateFails: 100,
    }
  }
  if (profile === 'stage2') {
    return {
      minSignificancePassRatio: 0.2,
      maxMeanPbo: 0.6,
      minMeanDsrProbability: 0.35,
      enforceSignificanceHardGate: true,
      maxScoreWhenHardGateFails: 70,
    }
  }
  return {
    minSignificancePassRatio: 0.6,
    maxMeanPbo: 0.2,
    minMeanDsrProbability: 0.5,
    enforceSignificanceHardGate: true,
    maxScoreWhenHardGateFails: 55,
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const objectiveModeRaw = (raw.get('objectiveMode') ?? 'auto').trim().toLowerCase()
  const objectiveMode: 'auto' | 'max' | 'min' =
    objectiveModeRaw === 'max' || objectiveModeRaw === 'min' ? objectiveModeRaw : 'auto'
  const gateProfile = parseGateProfile(raw.get('gateProfile') ?? raw.get('gate-profile'))
  const partitionMode = parsePartitionMode(raw.get('partitionMode') ?? raw.get('partition-mode'))
  const regimeScheme = parseRegimeScheme(raw.get('regimeScheme') ?? raw.get('regime-scheme'))
  const defaults = gateDefaults(gateProfile)
  return {
    dryRun: parseBoolArg(raw.get('dryRun'), true),
    trainingRoot: raw.get('trainingRoot') ?? 'data/training-data/full-v1',
    objectiveMetric: raw.get('objectiveMetric') ?? 'accuracyLift',
    objectiveMode,
    topSymbols: parseIntArg(raw.get('topSymbols'), 8, 'topSymbols'),
    minRows: parseIntArg(raw.get('minRows'), 220, 'minRows'),
    strategies: parseStrategies(raw.get('strategies')),
    lookbackBars: parseIntArg(raw.get('lookbackBars'), 3000, 'lookbackBars'),
    feeRate: parseNumberArg(raw.get('feeRate'), 0.0006, 'feeRate'),
    slippageBps: parseNumberArg(raw.get('slippageBps'), 8, 'slippageBps'),
    latencyBars: parseIntArg(raw.get('latencyBars'), 1, 'latencyBars'),
    trainBars: parseIntArg(raw.get('trainBars'), 365, 'trainBars'),
    testBars: parseIntArg(raw.get('testBars'), 90, 'testBars'),
    stepBars: parseIntArg(raw.get('stepBars'), 90, 'stepBars'),
    skipInsufficientSymbols: parseBoolArg(raw.get('skipInsufficientSymbols'), true),
    gateProfile,
    partitionMode,
    regimeScheme,
    minSignificancePassRatio: parseNumberArg(
      raw.get('minSignificancePassRatio'),
      defaults.minSignificancePassRatio,
      'minSignificancePassRatio',
    ),
    maxMeanPbo: parseNumberArg(raw.get('maxMeanPbo'), defaults.maxMeanPbo, 'maxMeanPbo'),
    minMeanDsrProbability: parseNumberArg(
      raw.get('minMeanDsrProbability'),
      defaults.minMeanDsrProbability,
      'minMeanDsrProbability',
    ),
    enforceSignificanceHardGate: parseBoolArg(
      raw.get('enforceSignificanceHardGate'),
      defaults.enforceSignificanceHardGate,
    ),
    maxScoreWhenHardGateFails: parseNumberArg(
      raw.get('maxScoreWhenHardGateFails'),
      defaults.maxScoreWhenHardGateFails,
      'maxScoreWhenHardGateFails',
    ),
    runUnitTests: parseBoolArg(raw.get('runUnitTests'), false),
    output:
      raw.get('output') ??
      `logs/research/openalice_completion_${new Date().toISOString().replaceAll(':', '-')}.json`,
  }
}

function objectiveMode(metric: string, mode: 'auto' | 'max' | 'min'): 'max' | 'min' {
  if (mode !== 'auto') return mode
  return metric === 'maePct' || metric === 'rmsePct' ? 'min' : 'max'
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

function resolveWalkForwardWindows(
  availableBars: number,
  requestedTrain: number,
  requestedTest: number,
  requestedStep: number,
): { trainBars: number; testBars: number; stepBars: number } | null {
  const minTrainBars = 64
  const minTestBars = 64
  let trainBars = requestedTrain
  let testBars = requestedTest
  let stepBars = requestedStep

  if (trainBars + testBars <= availableBars && trainBars >= minTrainBars) {
    return { trainBars, testBars, stepBars: Math.max(1, Math.min(stepBars, testBars)) }
  }

  testBars = Math.max(minTestBars, Math.floor(availableBars * 0.2))
  trainBars = Math.max(minTrainBars, Math.floor(availableBars * 0.6))
  if (trainBars + testBars > availableBars) {
    trainBars = Math.max(minTrainBars, availableBars - testBars - 1)
  }
  if (trainBars + testBars > availableBars || trainBars < minTrainBars || testBars < minTestBars) {
    return null
  }
  stepBars = Math.max(1, Math.min(requestedStep, testBars))
  return { trainBars, testBars, stepBars }
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0
}

function normalizePct(value: number, low = -100, high = 1000): number | null {
  return Number.isFinite(value) ? clamp(value, low, high) : null
}

function normalizeSharpe(value: number): number | null {
  return Number.isFinite(value) ? clamp(value, -10, 10) : null
}

function getMetricScore(row: RetrainResultRow, objectiveMetric: string): number | null {
  const direct = Number(row.objectiveScore)
  if (Number.isFinite(direct)) return direct
  const metricValue = Number(row.metrics?.[objectiveMetric])
  return Number.isFinite(metricValue) ? metricValue : null
}

function getCurrentRegime(row: RetrainResultRow): string | null {
  const regime = row.regimeSummary?.currentRegime
  return typeof regime === 'string' && regime.trim().length > 0 ? regime : null
}

function splitSymbolKey(symbolKey: string): { baseSymbol: string; sourceBucket: string | null } {
  const marker = '::'
  const idx = symbolKey.indexOf(marker)
  if (idx < 0) {
    return { baseSymbol: symbolKey, sourceBucket: null }
  }
  return {
    baseSymbol: symbolKey.slice(0, idx),
    sourceBucket: symbolKey.slice(idx + marker.length) || null,
  }
}

function resolvePartitionId(
  partitionMode: PartitionMode,
  sourceBucket: string | null,
  latestRegimeLabel: string | null,
): string {
  if (partitionMode === 'none') return 'all'
  const exchange = sourceBucket ?? 'unknown'
  if (partitionMode === 'exchange') return exchange
  const regime = latestRegimeLabel ?? 'unknown'
  return `${exchange}__${regime}`
}

function evaluateCompletionScore(input: ScoreInput): ScoreResult {
  const liftScore = clamp((input.meanAccuracyLift + 0.05) / 0.1, 0, 1)
  const sharpeScore = clamp((input.avgSharpe + 0.5) / 1.5, 0, 1)
  const pboScore = clamp(
    (input.maxMeanPbo - input.meanPbo) / Math.max(input.maxMeanPbo, 1e-9),
    0,
    1,
  )
  const dsrScore = clamp(
    (input.meanDsrProbability - input.minMeanDsrProbability) /
      Math.max(1 - input.minMeanDsrProbability, 1e-9),
    0,
    1,
  )

  const components: Array<{ name: string; weight: number; value: number }> = [
    { name: 'ml_lift', weight: 0.22, value: liftScore },
    { name: 'ml_positive_lift_ratio', weight: 0.13, value: input.positiveLiftRatio },
    { name: 'strategy_paper_pass', weight: 0.2, value: input.paperPassRatio },
    { name: 'strategy_live_pass', weight: 0.15, value: input.livePassRatio },
    { name: 'strategy_sharpe', weight: 0.1, value: sharpeScore },
    { name: 'significance_pass_ratio', weight: 0.1, value: input.significancePassRatio },
    { name: 'significance_pbo', weight: 0.05, value: pboScore },
    { name: 'significance_dsr_probability', weight: 0.05, value: dsrScore },
  ]
  if (input.runUnitTests) {
    components.push({
      name: 'unit_tests',
      weight: 0.1,
      value: input.unitTestsPassed ? 1 : 0,
    })
  }
  const totalWeight = components.reduce((sum, component) => sum + component.weight, 0)
  const rawScore = clamp(
    (100 * components.reduce((sum, component) => sum + component.weight * component.value, 0)) /
      Math.max(totalWeight, 1e-9),
    0,
    100,
  )

  const hardGateFailures: string[] = []
  if (input.significancePassRatio < input.minSignificancePassRatio) {
    hardGateFailures.push(
      `significancePassRatio=${input.significancePassRatio.toFixed(3)} < ${input.minSignificancePassRatio.toFixed(3)}`,
    )
  }
  if (input.meanPbo > input.maxMeanPbo) {
    hardGateFailures.push(`meanPbo=${input.meanPbo.toFixed(3)} > ${input.maxMeanPbo.toFixed(3)}`)
  }
  if (input.meanDsrProbability < input.minMeanDsrProbability) {
    hardGateFailures.push(
      `meanDsrProbability=${input.meanDsrProbability.toFixed(3)} < ${input.minMeanDsrProbability.toFixed(3)}`,
    )
  }

  const hardGateApplied = input.enforceSignificanceHardGate && hardGateFailures.length > 0
  let score = rawScore
  if (hardGateApplied) {
    score = Math.min(score, input.maxScoreWhenHardGateFails)
  }

  let readiness: Readiness = 'not_ready'
  if (!hardGateApplied) {
    if (score >= 80 && input.paperPassRatio >= 0.7 && input.meanAccuracyLift > 0) {
      readiness = 'ready_for_paper'
    } else if (score >= 65 && input.paperPassRatio >= 0.5) {
      readiness = 'candidate_needs_iteration'
    }
  }

  return { score, rawScore, readiness, hardGateApplied, hardGateFailures, components }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      resolvePromise({ code: 1, stdout, stderr: `${stderr}\n${String(error)}`.trim() })
    })
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: 'openalice_completion',
      command: 'run_openalice_completion',
      executionMode: {
        dryRun: true,
        readsTrainingArtifacts: false,
        runsValidationPipeline: false,
        runsUnitTests: false,
        writesCompletionReport: false,
        writesReleaseGateStatus: false,
        promotionEligible: false,
      },
      output: args.output,
      optIn: {
        runCompletion: '--dryRun false',
      },
    }, null, 2))
    return
  }

  const minSignificancePassRatio = clamp(args.minSignificancePassRatio, 0, 1)
  const maxMeanPbo = clamp(args.maxMeanPbo, 0, 1)
  const minMeanDsrProbability = clamp(args.minMeanDsrProbability, 0, 1)
  const maxScoreWhenHardGateFails = clamp(args.maxScoreWhenHardGateFails, 0, 100)
  const cwd = resolve('.')
  const trainingRoot = resolve(args.trainingRoot)
  const cleanSummaryPath = resolve(trainingRoot, 'clean', 'summary.json')
  const retrainSummaryPath = resolve(trainingRoot, 'retrain', 'summary.json')
  const retrainResultsPath = resolve(trainingRoot, 'retrain', 'results.json')

  for (const path of [cleanSummaryPath, retrainSummaryPath, retrainResultsPath]) {
    if (!(await fileExists(path))) {
      throw new Error(`Missing required training artifact: ${path}`)
    }
  }

  const cleanSummary = JSON.parse(await readFile(cleanSummaryPath, 'utf-8')) as {
    symbols: CleanSummarySymbol[]
  }
  const retrainSummary = JSON.parse(await readFile(retrainSummaryPath, 'utf-8')) as Record<string, any>
  const retrainResults = JSON.parse(await readFile(retrainResultsPath, 'utf-8')) as RetrainResultRow[]

  const metric = args.objectiveMetric
  const mode = objectiveMode(metric, args.objectiveMode)
  const symbolToCsv = new Map<string, string>()
  const symbolMetaBySymbol = new Map<
    string,
    {
      baseSymbol: string
      sourceBucket: string | null
      partitionId: string
      latestRegimeLabel: string | null
    }
  >()

  for (const row of cleanSummary.symbols ?? []) {
    if (!row?.symbol || !row?.path) continue
    symbolToCsv.set(row.symbol, resolve(row.path))
    const split = splitSymbolKey(row.symbol)
    const sourceBucket = row.sourceBucket ?? split.sourceBucket
    const latestRegimeLabel =
      typeof row.latestRegimeLabel === 'string' ? row.latestRegimeLabel : null
    const partitionId =
      row.partitionId ??
      resolvePartitionId(args.partitionMode, sourceBucket, latestRegimeLabel)
    symbolMetaBySymbol.set(row.symbol, {
      baseSymbol: row.baseSymbol ?? split.baseSymbol,
      sourceBucket,
      partitionId,
      latestRegimeLabel,
    })
  }

  const retrainBySymbol = new Map(retrainResults.map((row) => [row.symbol, row]))
  const ranked = [...retrainResults]
    .map((row) => ({
      row,
      score: getMetricScore(row, metric),
      csvPath: symbolToCsv.get(row.symbol),
    }))
    .filter((item) => item.csvPath && Number(item.row.rows) >= args.minRows)
    .sort((left, right) => {
      const leftScore = left.score
      const rightScore = right.score
      if (leftScore == null && rightScore == null) return 0
      if (leftScore == null) return 1
      if (rightScore == null) return -1
      return mode === 'max' ? rightScore - leftScore : leftScore - rightScore
    })

  const selectedRaw = ranked.slice(0, args.topSymbols).map((item) => {
    const split = splitSymbolKey(item.row.symbol)
    const meta = symbolMetaBySymbol.get(item.row.symbol)
    const sourceBucket = meta?.sourceBucket ?? split.sourceBucket
    const latestRegimeLabel = meta?.latestRegimeLabel ?? getCurrentRegime(item.row)
    const partitionId =
      meta?.partitionId ?? resolvePartitionId(args.partitionMode, sourceBucket, latestRegimeLabel)
    return {
      symbol: item.row.symbol,
      baseSymbol: meta?.baseSymbol ?? split.baseSymbol,
      sourceBucket,
      latestRegimeLabel,
      partitionId,
      rows: item.row.rows,
      score: item.score,
      selectedModel: item.row.selectedModel ?? 'ensemble',
      csvPath: item.csvPath!,
    }
  })

  const selected = selectedRaw.filter((entry) => {
    if (!args.skipInsufficientSymbols) return true
    const availableBars = Math.min(args.lookbackBars, Math.max(0, Number(entry.rows) || 0))
    return resolveWalkForwardWindows(availableBars, args.trainBars, args.testBars, args.stepBars) != null
  })
  if (!selected.length) {
    throw new Error('No symbols selected for completion validation.')
  }

  const runsDir = resolve('logs/research/completion_runs', new Date().toISOString().replaceAll(':', '-'))
  await mkdir(runsDir, { recursive: true })

  const runRecords: ValidationRunRecord[] = []
  const totalRuns = selected.length * args.strategies.length
  let runIndex = 0

  for (const entry of selected) {
    for (const strategy of args.strategies) {
      runIndex += 1
      const symbolSlug = entry.symbol.replace(/[^A-Za-z0-9._-]+/g, '_')
      const outputPath = resolve(runsDir, `${symbolSlug}.${strategy}.json`)
      const availableBars = Math.min(args.lookbackBars, Math.max(0, Number(entry.rows) || 0))
      const windows = resolveWalkForwardWindows(
        availableBars,
        args.trainBars,
        args.testBars,
        args.stepBars,
      )
      if (!windows) {
        runRecords.push({
          symbol: entry.symbol,
          csvPath: entry.csvPath,
          strategy,
          outputPath,
          exitCode: 1,
          stdout: '',
          stderr: '',
          error: `insufficient_bars_for_wfo (available=${availableBars})`,
        })
        continue
      }

      console.log(`[${runIndex}/${totalRuns}] validate strategy=${strategy} symbol=${entry.symbol}`)
      const proc = await runProcess(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/run_validation_pipeline.ts',
          '--inputCsv',
          entry.csvPath,
          '--symbol',
          entry.symbol,
          '--strategy',
          strategy,
          '--lookbackBars',
          String(args.lookbackBars),
          '--feeRate',
          String(args.feeRate),
          '--slippageBps',
          String(args.slippageBps),
          '--latencyBars',
          String(args.latencyBars),
          '--trainBars',
          String(windows.trainBars),
          '--testBars',
          String(windows.testBars),
          '--stepBars',
          String(windows.stepBars),
          '--writeReleaseGateStatus',
          'false',
          '--output',
          outputPath,
        ],
        cwd,
      )

      let report: Record<string, any> | undefined
      let error: string | undefined
      if (await fileExists(outputPath)) {
        try {
          report = JSON.parse(await readFile(outputPath, 'utf-8')) as Record<string, any>
        } catch (err) {
          error = `invalid_report_json: ${String(err)}`
        }
      } else {
        error = `missing_report_file (exitCode=${proc.code})`
      }
      if (proc.code !== 0 && proc.code !== 2 && !error) {
        error = `validation_process_failed_exit_${proc.code}`
      }

      runRecords.push({
        symbol: entry.symbol,
        csvPath: entry.csvPath,
        strategy,
        outputPath,
        exitCode: proc.code,
        stdout: proc.stdout,
        stderr: proc.stderr,
        report,
        error,
      })
    }
  }

  let unitTests: {
    executed: boolean
    exitCode?: number
    passed?: boolean
    stdout?: string
    stderr?: string
  } = { executed: false }

  if (args.runUnitTests) {
    console.log('running unit tests: pnpm test')
    const proc = await runProcess('pnpm', ['test'], cwd)
    unitTests = {
      executed: true,
      exitCode: proc.code,
      passed: proc.code === 0,
      stdout: proc.stdout,
      stderr: proc.stderr,
    }
  }

  const successRuns = runRecords.filter((run) => !!run.report && !run.error)
  const paperPassCount = successRuns.filter((run) => run.report?.releaseGate?.allowPaperTrading === true).length
  const livePassCount = successRuns.filter((run) => run.report?.releaseGate?.allowLiveTrading === true).length
  const paperPassRatio = successRuns.length ? paperPassCount / successRuns.length : 0
  const livePassRatio = successRuns.length ? livePassCount / successRuns.length : 0
  const significancePassCount = successRuns.filter((run) => run.report?.significance?.passed === true).length
  const significancePassRatio = successRuns.length ? significancePassCount / successRuns.length : 0
  const meanPbo = mean(
    successRuns
      .map((run) => Number(run.report?.significance?.pbo))
      .filter((value) => Number.isFinite(value))
      .map((value) => clamp(value, 0, 1)),
  )
  const meanDsrProbability = mean(
    successRuns
      .map((run) => Number(run.report?.significance?.dsrProbability))
      .filter((value) => Number.isFinite(value))
      .map((value) => clamp(value, 0, 1)),
  )
  const avgSharpe = mean(
    successRuns
      .map((run) => normalizeSharpe(Number(run.report?.selectedMetrics?.sharpe)))
      .filter((value): value is number => value != null),
  )
  const avgReturnPct = mean(
    successRuns
      .map((run) => normalizePct(Number(run.report?.selectedMetrics?.totalReturnPct)))
      .filter((value): value is number => value != null),
  )
  const avgMaxDrawdownPct = mean(
    successRuns
      .map((run) => normalizePct(Number(run.report?.selectedMetrics?.maxDrawdownPct), 0, 100))
      .filter((value): value is number => value != null),
  )

  const strategyBreakdown: Record<
    string,
    { runs: number; paperPass: number; livePass: number; avgSharpe: number; avgReturnPct: number }
  > = {}
  for (const strategy of args.strategies) {
    const subset = successRuns.filter((run) => run.strategy === strategy)
    strategyBreakdown[strategy] = {
      runs: subset.length,
      paperPass: subset.filter((run) => run.report?.releaseGate?.allowPaperTrading).length,
      livePass: subset.filter((run) => run.report?.releaseGate?.allowLiveTrading).length,
      avgSharpe: mean(
        subset
          .map((run) => normalizeSharpe(Number(run.report?.selectedMetrics?.sharpe)))
          .filter((value): value is number => value != null),
      ),
      avgReturnPct: mean(
        subset
          .map((run) => normalizePct(Number(run.report?.selectedMetrics?.totalReturnPct)))
          .filter((value): value is number => value != null),
      ),
    }
  }

  const meanAccuracyLift = Number(retrainSummary.meanAccuracyLift ?? 0)
  const positiveLiftRatio = clamp(Number(retrainSummary.positiveLiftRatio ?? 0), 0, 1)
  const overallScore = evaluateCompletionScore({
    meanAccuracyLift,
    positiveLiftRatio,
    paperPassRatio,
    livePassRatio,
    significancePassRatio,
    meanPbo,
    meanDsrProbability,
    avgSharpe,
    runUnitTests: args.runUnitTests,
    unitTestsPassed: !!unitTests.passed,
    minSignificancePassRatio,
    maxMeanPbo,
    minMeanDsrProbability,
    enforceSignificanceHardGate: args.enforceSignificanceHardGate,
    maxScoreWhenHardGateFails,
  })

  const selectedModelCounts = selected.reduce((acc, row) => {
    const model = row.selectedModel || 'ensemble'
    acc[model] = (acc[model] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)

  const recommendations: string[] = []
  if (meanAccuracyLift <= 0) {
    recommendations.push('ML objective has non-positive mean lift; improve feature/model objective alignment.')
  }
  if (positiveLiftRatio < 0.5) {
    recommendations.push('Positive-lift symbol ratio is low; add regime filters and per-symbol model routing.')
  }
  if (paperPassRatio < 0.6) {
    recommendations.push('Strategy release-gate pass ratio is low; retune params with stricter candidate selection.')
  }
  if (significancePassRatio < minSignificancePassRatio) {
    recommendations.push(`Significance pass ratio is below threshold (${significancePassRatio.toFixed(3)} < ${minSignificancePassRatio.toFixed(3)}).`)
  }
  if (meanPbo > maxMeanPbo) {
    recommendations.push(`Mean PBO is too high (${meanPbo.toFixed(3)} > ${maxMeanPbo.toFixed(3)}), indicating likely overfitting.`)
  }
  if (meanDsrProbability < minMeanDsrProbability) {
    recommendations.push(`Mean DSR probability is too low (${meanDsrProbability.toFixed(3)} < ${minMeanDsrProbability.toFixed(3)}).`)
  }
  if (args.enforceSignificanceHardGate && overallScore.hardGateFailures.length > 0) {
    recommendations.push(`Significance hard gate active; readiness forced to not_ready. Reasons: ${overallScore.hardGateFailures.join('; ')}`)
  }
  if (args.runUnitTests && !unitTests.passed) {
    recommendations.push('Unit tests are failing; stabilize code quality gate before deployment.')
  }
  if (!recommendations.length) {
    recommendations.push('Current setup passes baseline completion gates; continue paper trading and drift monitoring.')
  }

  const report = {
    generatedAt: new Date().toISOString(),
    input: {
      trainingRoot,
      objectiveMetric: metric,
      objectiveMode: mode,
      topSymbols: args.topSymbols,
      minRows: args.minRows,
      strategies: args.strategies,
      lookbackBars: args.lookbackBars,
      costs: {
        feeRate: args.feeRate,
        slippageBps: args.slippageBps,
        latencyBars: args.latencyBars,
      },
      walkForward: {
        trainBars: args.trainBars,
        testBars: args.testBars,
        stepBars: args.stepBars,
      },
      experiment: {
        gateProfile: args.gateProfile,
        partitionMode: args.partitionMode,
        regimeScheme: args.regimeScheme,
      },
      significanceGate: {
        minSignificancePassRatio,
        maxMeanPbo,
        minMeanDsrProbability,
        enforceHardGate: args.enforceSignificanceHardGate,
        maxScoreWhenHardGateFails,
      },
      runUnitTests: args.runUnitTests,
    },
    selectedSymbols: selected,
    selectedSymbolsMeta: {
      requestedTopSymbols: args.topSymbols,
      selectedBeforeFilter: selectedRaw.length,
      selectedAfterFilter: selected.length,
      droppedByInsufficientBars: selectedRaw.length - selected.length,
    },
    ml: {
      summaryPath: retrainSummaryPath,
      trainedSymbols: Number(retrainSummary.trainedSymbols ?? 0),
      errorSymbols: Number(retrainSummary.errorSymbols ?? 0),
      meanDirectionAccuracy: Number(retrainSummary.meanDirectionAccuracy ?? 0),
      meanBaselineDirectionAccuracy: Number(retrainSummary.meanBaselineDirectionAccuracy ?? 0),
      meanAccuracyLift,
      positiveLiftRatio,
      selectedModelCounts,
    },
    strategyValidation: {
      runsRequested: totalRuns,
      runsCompleted: runRecords.length,
      successfulRuns: successRuns.length,
      erroredRuns: runRecords.filter((run) => !!run.error).length,
      paperPassCount,
      livePassCount,
      paperPassRatio,
      livePassRatio,
      significancePassCount,
      significancePassRatio,
      meanPbo,
      meanDsrProbability,
      avgSharpe,
      avgReturnPct,
      avgMaxDrawdownPct,
      strategyBreakdown,
    },
    unitTests,
    completion: {
      score: Number(overallScore.score.toFixed(2)),
      rawScore: Number(overallScore.rawScore.toFixed(2)),
      readiness: overallScore.readiness,
      hardGateApplied: overallScore.hardGateApplied,
      hardGateFailures: overallScore.hardGateFailures,
      components: overallScore.components,
      recommendations,
    },
    runRecords,
  }

  const outputPath = resolve(args.output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')

  const aggregatedFailedChecks: string[] = []
  if (paperPassRatio < 0.7) aggregatedFailedChecks.push('paper_pass_ratio')
  if (meanAccuracyLift <= 0) aggregatedFailedChecks.push('ml_accuracy_lift')
  if (significancePassRatio < minSignificancePassRatio) aggregatedFailedChecks.push('significance_pass_ratio')
  if (meanPbo > maxMeanPbo) aggregatedFailedChecks.push('mean_pbo')
  if (meanDsrProbability < minMeanDsrProbability) aggregatedFailedChecks.push('mean_dsr_probability')

  const aggregatedWarningChecks: string[] = []
  if (paperPassRatio >= 0.5 && paperPassRatio < 0.7) aggregatedWarningChecks.push('paper_pass_ratio')
  if (positiveLiftRatio < 0.5) aggregatedWarningChecks.push('positive_lift_ratio')

  const allowPaper = overallScore.readiness === 'ready_for_paper' || overallScore.readiness === 'candidate_needs_iteration'
  const allowLive = overallScore.readiness === 'ready_for_paper'

  await writeReleaseGateStatus(
    {
      checks: [],
      failedChecks: aggregatedFailedChecks,
      warningChecks: aggregatedWarningChecks,
      hardFail: overallScore.hardGateApplied,
      allowPaperTrading: allowPaper,
      allowLiveTrading: allowLive,
    },
    {
      sourceReportPath: outputPath,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  )

  console.log(
    [
      `completionReport=${outputPath}`,
      `score=${report.completion.score}`,
      `readiness=${report.completion.readiness}`,
      `paperPass=${paperPassCount}/${successRuns.length}`,
      `livePass=${livePassCount}/${successRuns.length}`,
      `significancePass=${significancePassCount}/${successRuns.length}`,
      `meanPbo=${meanPbo.toFixed(3)}`,
      `meanDsrProb=${meanDsrProbability.toFixed(3)}`,
      `hardGate=${report.completion.hardGateApplied}`,
      `gateProfile=${args.gateProfile}`,
      `partitionMode=${args.partitionMode}`,
      `erroredRuns=${report.strategyValidation.erroredRuns}`,
    ].join(' | '),
  )
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error('run_openalice_completion failed:', err)
    process.exit(1)
  })
}

export {
  main,
  parseArgs,
}
