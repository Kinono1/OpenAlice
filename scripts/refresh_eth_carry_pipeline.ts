import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface CliArgs {
  ethFundingPath: string
  btcFundingPath: string
  lookbackBars: number
  trainBars: number
  testBars: number
  stepBars: number
  riskSimulationCount: number
  paperTargetBasisEquityUsd: number
  bundleName: string
  snapshotBaseDir: string
  publishRuntimeTargets: boolean
  dryRun: boolean
}

interface PipelinePlan {
  validation: {
    script: string
    args: string[]
  }
  shortBiasValidation: {
    script: string
    args: string[]
  }
  pairShadowValidation: {
    script: string
    args: string[]
  }
  bundle: {
    script: string
    args: string[]
  }
  status: {
    script: string
    args: string[]
  }
  publishRuntime?: {
    script: string
    args: string[]
  }
}

interface EthCarryPipelineResult {
  controlArtifactDir: string
  controlSummaryPath: string
  shadowArtifactDir: string
  shadowSummaryPath: string
  pairShadowArtifactDir: string
  pairShadowSummaryPath: string
  publishedArtifactDir: string
  bundleDir: string
  shadowComparisonPath: string
  statusSummaryPath: string
}

type ScriptRunner = (script: string, args: string[]) => Promise<string>

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const plan = buildPipelinePlan(args)
  if (args.dryRun) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }

  const pipelineResult = await refreshEthCarryPipeline(args, plan, runTsxScript)
  const outputPath = resolve(args.snapshotBaseDir, 'eth_carry_pipeline_refresh.json')
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(
    outputPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      pipelineResult,
    }, null, 2)}\n`,
    'utf-8',
  )

  console.log(outputPath)
}

async function refreshEthCarryPipeline(
  args: CliArgs,
  plan: PipelinePlan,
  runScript: ScriptRunner,
): Promise<EthCarryPipelineResult> {
  const controlSummaryPath = await runScript(plan.validation.script, plan.validation.args)
  const controlArtifactDir = dirname(controlSummaryPath)
  const shadowSummaryPath = await runScript(plan.shortBiasValidation.script, plan.shortBiasValidation.args)
  const shadowArtifactDir = dirname(shadowSummaryPath)
  const pairShadowSummaryPath = await runScript(plan.pairShadowValidation.script, plan.pairShadowValidation.args)
  const pairShadowArtifactDir = dirname(pairShadowSummaryPath)
  const shadowComparisonPath = resolve(args.snapshotBaseDir, 'eth_carry_shadow_comparison.json')
  const shadowComparison = await buildShadowComparison({
    controlSummaryPath,
    shadowSummaryPath,
  })
  await mkdir(dirname(shadowComparisonPath), { recursive: true })
  await writeFile(`${shadowComparisonPath}`, `${JSON.stringify(shadowComparison, null, 2)}\n`, 'utf-8')
  const publishedArtifactDir =
    shadowComparison.promotionDecision === 'promote_shadow'
      ? shadowArtifactDir
      : controlArtifactDir
  const bundleDir = await runScript(plan.bundle.script, [
    ...plan.bundle.args,
    '--artifactDir',
    publishedArtifactDir,
  ])
  const statusSummaryPath = await runScript(plan.status.script, [
    ...plan.status.args,
    '--validationRunsPath',
    resolve(bundleDir, 'strategy_validation_runs.json'),
    '--verdictPath',
    resolve(bundleDir, 'experiment_verdict.v2.json'),
    '--releaseGateStatusPath',
    resolve(bundleDir, 'release_gate_status.json'),
    '--registryPath',
    resolve(bundleDir, 'paper_champion_registry.json'),
    '--portfolioTargetPath',
    resolve(bundleDir, 'paper_portfolio_target.json'),
    '--controlArtifactDir',
    controlArtifactDir,
    '--shadowArtifactDir',
    shadowArtifactDir,
    '--pairShadowArtifactDir',
    pairShadowArtifactDir,
    '--shadowComparisonPath',
    shadowComparisonPath,
  ])
  if (plan.publishRuntime) {
    await runScript(plan.publishRuntime.script, [
      ...plan.publishRuntime.args,
      '--artifactDir',
      publishedArtifactDir,
      '--outputDir',
      bundleDir,
    ])
  }

  return {
    controlArtifactDir,
    controlSummaryPath,
    shadowArtifactDir,
    shadowSummaryPath,
    pairShadowArtifactDir,
    pairShadowSummaryPath,
    publishedArtifactDir,
    bundleDir,
    shadowComparisonPath,
    statusSummaryPath,
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    ethFundingPath:
      raw.get('ethFundingPath') ??
      'data/research/derivatives_history/okx_ETH_USDT_USDT_funding_history.json',
    btcFundingPath:
      raw.get('btcFundingPath') ??
      'data/research/derivatives_history/okx_BTC_USDT_USDT_funding_history.json',
    lookbackBars: parseIntArg(raw.get('lookbackBars'), 6000, 'lookbackBars'),
    trainBars: parseIntArg(raw.get('trainBars'), 3600, 'trainBars'),
    testBars: parseIntArg(raw.get('testBars'), 1200, 'testBars'),
    stepBars: parseIntArg(raw.get('stepBars'), 480, 'stepBars'),
    riskSimulationCount: parseIntArg(raw.get('riskSimulationCount'), 200, 'riskSimulationCount'),
    paperTargetBasisEquityUsd: parseNumberArg(
      raw.get('paperTargetBasisEquityUsd'),
      10_000,
      'paperTargetBasisEquityUsd',
    ),
    bundleName: raw.get('bundleName') ?? 'eth_carry_runtime_publish',
    snapshotBaseDir: raw.get('snapshotBaseDir') ?? 'data/runtime/eth_carry_status',
    publishRuntimeTargets: parseBoolArg(raw.get('publishRuntimeTargets'), false),
    dryRun: parseBoolArg(raw.get('dryRun'), true),
  }
}

function buildPipelinePlan(args: CliArgs): PipelinePlan {
  return {
    validation: {
      script: 'scripts/run_eth_carry_validation.ts',
      args: [
        '--ethFundingPath',
        args.ethFundingPath,
        '--btcFundingPath',
        args.btcFundingPath,
        '--lookbackBars',
        String(args.lookbackBars),
        '--trainBars',
        String(args.trainBars),
        '--testBars',
        String(args.testBars),
        '--stepBars',
        String(args.stepBars),
        '--riskSimulationCount',
        String(args.riskSimulationCount),
        '--paperTargetBasisEquityUsd',
        String(args.paperTargetBasisEquityUsd),
      ],
    },
    shortBiasValidation: {
      script: 'scripts/run_eth_carry_short_bias_validation.ts',
      args: [
        '--ethFundingPath',
        args.ethFundingPath,
        '--btcFundingPath',
        args.btcFundingPath,
        '--lookbackBars',
        String(args.lookbackBars),
        '--trainBars',
        String(args.trainBars),
        '--testBars',
        String(args.testBars),
        '--stepBars',
        String(args.stepBars),
        '--riskSimulationCount',
        String(args.riskSimulationCount),
        '--paperTargetBasisEquityUsd',
        String(args.paperTargetBasisEquityUsd),
      ],
    },
    pairShadowValidation: {
      script: 'scripts/run_eth_carry_short_bias_pair_shadow_validation.ts',
      args: [
        '--ethFundingPath',
        args.ethFundingPath,
        '--btcFundingPath',
        args.btcFundingPath,
        '--lookbackBars',
        String(args.lookbackBars),
        '--trainBars',
        String(args.trainBars),
        '--testBars',
        String(args.testBars),
        '--stepBars',
        String(args.stepBars),
        '--riskSimulationCount',
        String(args.riskSimulationCount),
      ],
    },
    bundle: {
      script: 'scripts/publish_eth_carry_runtime_bundle.ts',
      args: [
        '--bundleName',
        args.bundleName,
        '--publishRuntimeTargets',
        'false',
      ],
    },
    status: {
      script: 'scripts/refresh_eth_carry_runtime_status.ts',
      args: [
        '--snapshotBaseDir',
        args.snapshotBaseDir,
        '--basisEquityUsd',
        String(args.paperTargetBasisEquityUsd),
        '--applyNewsOverlayToDefaultTarget',
        'false',
      ],
    },
    publishRuntime: args.publishRuntimeTargets
      ? {
          script: 'scripts/publish_eth_carry_runtime_bundle.ts',
          args: [
            '--bundleName',
            args.bundleName,
            '--publishRuntimeTargets',
            'true',
          ],
        }
      : undefined,
  }
}

async function runTsxScript(script: string, args: string[]): Promise<string> {
  const cliPath = resolve('node_modules/tsx/dist/cli.mjs')
  const { stdout } = await execFileAsync(process.execPath, [cliPath, script, ...args], {
    cwd: process.cwd(),
  })
  return extractLastNonEmptyLine(stdout)
}

function extractLastNonEmptyLine(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines.at(-1)
  if (!last) {
    throw new Error('Expected script output path, got empty stdout.')
  }
  return last
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
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
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number.`)
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

export {
  buildPipelinePlan,
  buildShadowComparison,
  extractLastNonEmptyLine,
  parseArgs,
  refreshEthCarryPipeline,
  runTsxScript,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

interface SummaryLike {
  selectedParams: { id: string }
  selectedMetrics: {
    tradeCount: number
    netExpectancyPct: number
  }
  trades?: Array<{ netReturnPct: number; exitTime: number }>
  releaseGate: {
    allowPaperTrading: boolean
  }
  significance: {
    passed: boolean
    pboResult?: { pbo: number }
    pbo?: number
  }
  topCandidates?: Array<{
    recent90dTradeCount?: number
    errorRate?: number
    recent90dErrorRate?: number
    netExpectancyPct?: number
    tradeCount?: number
    pbo?: number
    dsrValue?: number
    wfoPassed?: boolean
    failedWindows?: number
      paper?: boolean
  }>
  selectionProtocol?: {
    finalHoldout?: {
      selectedCandidateId?: string
      metrics?: {
        tradeCount?: number
        netExpectancyPct?: number
      }
      trades?: Array<{ netReturnPct: number; exitTime: number }>
      releaseGate?: {
        allowPaperTrading?: boolean
      }
      significance?: {
        passed?: boolean
        pboResult?: { pbo: number }
        pbo?: number
      }
      summary?: {
        tradeCount?: number
        recent90dTradeCount?: number
        errorRate?: number
        recent90dErrorRate?: number
        netExpectancyPct?: number
        sharpe?: number
        pbo?: number
        dsrValue?: number
        wfoPassed?: boolean
        failedWindows?: number
        paper?: boolean
      }
    }
  }
}

async function buildShadowComparison(input: {
  controlSummaryPath: string
  shadowSummaryPath: string
}) {
  const control = JSON.parse(await readFile(input.controlSummaryPath, 'utf-8')) as SummaryLike
  const shadow = JSON.parse(await readFile(input.shadowSummaryPath, 'utf-8')) as SummaryLike
  const controlStage = resolveComparableSummaryStage(control)
  const shadowStage = resolveComparableSummaryStage(shadow)
  const shadowTop = shadowStage.summaryRow
  const controlErrorRate = computeSummaryErrorRate(controlStage.trades)
  const controlRecent90dErrorRate = computeSummaryRecentErrorRate(controlStage.trades, 90)
  const controlPbo = typeof controlStage.significance?.pbo === 'number'
    ? controlStage.significance.pbo
    : controlStage.significance?.pboResult?.pbo ?? null
  const reasonCodes: string[] = []
  const promote =
    shadowStage.releaseGate.allowPaperTrading === true &&
    shadowStage.significance.passed === true &&
    (shadowStage.metrics.tradeCount ?? 0) >= 20 &&
    (shadowTop?.recent90dTradeCount ?? 0) >= 5 &&
    typeof shadowTop?.errorRate === 'number' &&
    shadowTop.errorRate <= (controlErrorRate ?? 1) - 0.05 &&
    shadowStage.metrics.netExpectancyPct >= controlStage.metrics.netExpectancyPct + 0.005

  if (shadowStage.releaseGate.allowPaperTrading !== true) reasonCodes.push('SHADOW_RELEASE_GATE_BLOCKED')
  if (shadowStage.significance.passed !== true) reasonCodes.push('SHADOW_SIGNIFICANCE_NOT_PASSED')
  if ((shadowStage.metrics.tradeCount ?? 0) < 20) reasonCodes.push('SHADOW_TRADE_COUNT_TOO_LOW')
  if ((shadowTop?.recent90dTradeCount ?? 0) < 5) reasonCodes.push('SHADOW_RECENT90D_TOO_SPARSE')
  if (typeof shadowTop?.errorRate !== 'number' || shadowTop.errorRate > (controlErrorRate ?? 1) - 0.05) reasonCodes.push('SHADOW_ERROR_IMPROVEMENT_INSUFFICIENT')
  if (shadowStage.metrics.netExpectancyPct < controlStage.metrics.netExpectancyPct + 0.005) reasonCodes.push('SHADOW_EDGE_IMPROVEMENT_INSUFFICIENT')

  return {
    generatedAt: new Date().toISOString(),
    controlCandidateId: controlStage.candidateId,
    shadowChampionId: shadowStage.candidateId,
    promotionDecision: promote ? 'promote_shadow' : 'keep_control',
    reasonCodes,
    control: {
      tradeCount: controlStage.metrics.tradeCount,
      recent90dTradeCount: controlStage.summaryRow?.recent90dTradeCount ?? computeSummaryRecentTradeCount(controlStage.trades, 90),
      errorRate: controlErrorRate,
      recent90dErrorRate: controlRecent90dErrorRate,
      netExpectancyPct: controlStage.metrics.netExpectancyPct,
      pbo: controlPbo,
      paper: controlStage.releaseGate.allowPaperTrading,
    },
    shadow: shadowTop == null
      ? null
      : {
          tradeCount: shadowStage.metrics.tradeCount,
          recent90dTradeCount: shadowTop.recent90dTradeCount ?? null,
          errorRate: shadowTop.errorRate ?? null,
          recent90dErrorRate: shadowTop.recent90dErrorRate ?? null,
          netExpectancyPct: shadowStage.metrics.netExpectancyPct,
          sharpe: shadowTop.sharpe ?? null,
          pbo: shadowTop.pbo ?? null,
          dsrValue: shadowTop.dsrValue ?? null,
          wfoPassed: shadowTop.wfoPassed ?? null,
          failedWindows: shadowTop.failedWindows ?? null,
          paper: shadowTop.paper ?? null,
        },
    paths: {
      controlSummaryPath: resolve(input.controlSummaryPath),
      shadowSummaryPath: resolve(input.shadowSummaryPath),
    },
  }
}

function resolveComparableSummaryStage(summary: SummaryLike) {
  const finalHoldout = summary.selectionProtocol?.finalHoldout
  return {
    candidateId: finalHoldout?.selectedCandidateId ?? summary.selectedParams.id,
    metrics: {
      tradeCount: finalHoldout?.metrics?.tradeCount ?? summary.selectedMetrics.tradeCount,
      netExpectancyPct: finalHoldout?.metrics?.netExpectancyPct ?? summary.selectedMetrics.netExpectancyPct,
    },
    trades: finalHoldout?.trades ?? summary.trades,
    releaseGate: {
      allowPaperTrading: finalHoldout?.releaseGate?.allowPaperTrading ?? summary.releaseGate.allowPaperTrading,
    },
    significance: {
      passed: finalHoldout?.significance?.passed ?? summary.significance.passed,
      pboResult: finalHoldout?.significance?.pboResult ?? summary.significance.pboResult,
      pbo: finalHoldout?.significance?.pbo ?? summary.significance.pbo,
    },
    summaryRow: finalHoldout?.summary ?? summary.topCandidates?.[0] ?? null,
  }
}

function computeSummaryErrorRate(
  trades: SummaryLike['trades'],
): number | null {
  if (!Array.isArray(trades) || trades.length === 0) return null
  const wins = trades.filter((trade) => trade.netReturnPct > 0).length
  return (trades.length - wins) / trades.length
}

function computeSummaryRecentTradeCount(
  trades: SummaryLike['trades'],
  days: number,
): number | null {
  if (!Array.isArray(trades) || trades.length === 0) return null
  const maxExit = Math.max(...trades.map((trade) => trade.exitTime))
  return trades.filter((trade) => trade.exitTime >= maxExit - days * 24 * 3600).length
}

function computeSummaryRecentErrorRate(
  trades: SummaryLike['trades'],
  days: number,
): number | null {
  if (!Array.isArray(trades) || trades.length === 0) return null
  const maxExit = Math.max(...trades.map((trade) => trade.exitTime))
  const recent = trades.filter((trade) => trade.exitTime >= maxExit - days * 24 * 3600)
  return computeSummaryErrorRate(recent)
}
