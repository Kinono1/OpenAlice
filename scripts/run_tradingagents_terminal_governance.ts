import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { buildTradingAgentsStageSnapshot } from './lib/tradingagents_stage_assessment.js'
import {
  DEFAULT_FAILURE_DIAGNOSIS_CONFIG,
  diagnoseTradingAgentsFailureMechanism,
} from './lib/tradingagents_failure_diagnosis.js'
import { summarizeTradingAgentsTerminalDecision } from './lib/tradingagents_terminal_decision.js'
import { materializeTradingAgentsTerminalArtifacts } from './materialize_tradingagents_terminal_artifacts.js'
import { readFile } from 'node:fs/promises'

interface CliArgs {
  validationRuns: string
  routeMatrix: string
  wfoSensitivity: string | null
  paradigmId: string
  analysisDir: string
  paradigmDir: string
  dateTag: string
  journalPath: string
  stageAssessmentOutput: string
  poolProfiles: string[]
}

export async function runTradingAgentsTerminalGovernance(args: CliArgs): Promise<{
  stageAssessmentPath: string
  diagnosisPaths: string[]
  terminalDecision: string
  statusJson: string
}> {
  const [validationRuns, routeMatrix, wfoSensitivity] = await Promise.all([
    readJson<Record<string, unknown>>(args.validationRuns),
    readJson<Record<string, unknown>>(args.routeMatrix),
    args.wfoSensitivity ? readJson<Record<string, unknown>>(args.wfoSensitivity) : Promise.resolve(null),
  ])

  const snapshot = buildTradingAgentsStageSnapshot({
    validationRuns,
    routeMatrix,
    wfoSensitivity,
  })
  const stageAssessmentPayload = {
    schemaVersion: 'tradingagents_stage_assessment.v1',
    generatedAt: new Date().toISOString(),
    paradigmId: args.paradigmId,
    sourceValidationRuns: resolve(args.validationRuns),
    sourceRouteMatrix: resolve(args.routeMatrix),
    sourceWfoSensitivity: args.wfoSensitivity ? resolve(args.wfoSensitivity) : null,
    currentStage: snapshot.currentStage,
    currentStageStatus: snapshot.currentStageStatus,
    stages: snapshot.stages,
    recommendation: snapshot.recommendation,
  }
  await mkdir(dirname(resolve(args.stageAssessmentOutput)), { recursive: true })
  await writeFile(resolve(args.stageAssessmentOutput), `${JSON.stringify(stageAssessmentPayload, null, 2)}\n`, 'utf-8')

  const diagnosisPaths: string[] = []
  const diagnoses = []
  for (const poolProfile of args.poolProfiles) {
    const diagnosis = diagnoseTradingAgentsFailureMechanism({
      paradigmId: args.paradigmId,
      poolProfile,
      validationRuns,
      routeMatrix,
      wfoSensitivity,
      preRegisteredConfig: DEFAULT_FAILURE_DIAGNOSIS_CONFIG,
      sourceValidationRuns: resolve(args.validationRuns),
      sourceRouteMatrix: resolve(args.routeMatrix),
      sourceWfoSensitivity: args.wfoSensitivity ? resolve(args.wfoSensitivity) : null,
    })
    const path = resolve(args.analysisDir, `tradingagents_btc_failure_diagnosis_${poolProfile}_${args.dateTag}.json`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(diagnosis, null, 2)}\n`, 'utf-8')
    diagnosisPaths.push(path)
    diagnoses.push(diagnosis)
  }

  const decisionPath = resolve(args.analysisDir, `tradingagents_btc_terminal_decision_${args.dateTag}.json`)
  const terminalDecision = summarizeTradingAgentsTerminalDecision({
    paradigmId: args.paradigmId,
    diagnoses,
    diagnosisInputs: diagnosisPaths,
  })
  await writeFile(decisionPath, `${JSON.stringify(terminalDecision, null, 2)}\n`, 'utf-8')

  const materialized = await materializeTradingAgentsTerminalArtifacts({
    diagnoses: diagnosisPaths,
    paradigmId: args.paradigmId,
    analysisDir: args.analysisDir,
    paradigmDir: args.paradigmDir,
    dateTag: args.dateTag,
    journalPath: args.journalPath,
  })

  return {
    stageAssessmentPath: resolve(args.stageAssessmentOutput),
    diagnosisPaths,
    terminalDecision: materialized.terminalDecision,
    statusJson: materialized.statusJson,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await runTradingAgentsTerminalGovernance(args)
  console.log(
    [
      `stageAssessment=${result.stageAssessmentPath}`,
      `diagnosisCount=${result.diagnosisPaths.length}`,
      `terminalDecision=${result.terminalDecision}`,
      `statusJson=${result.statusJson}`,
    ].join(' | '),
  )
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), 'utf-8')) as T
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const validationRuns = raw.get('validation-runs')
  const routeMatrix = raw.get('route-matrix')
  if (!validationRuns || !routeMatrix) {
    throw new Error('--validation-runs and --route-matrix are required.')
  }
  const poolProfiles = argv.filter((token, index) => argv[index - 1] === '--pool-profile')
  const analysisDir = raw.get('analysis-dir') ?? 'data/research/strategy/analysis'
  const dateTag = raw.get('date-tag') ?? new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return {
    validationRuns,
    routeMatrix,
    wfoSensitivity: raw.get('wfo-sensitivity') ?? null,
    paradigmId: raw.get('paradigm-id') ?? 'tradingagents_research_sidecar_v2',
    analysisDir,
    paradigmDir: raw.get('paradigm-dir') ?? 'data/research/strategy/paradigms/tradingagents',
    dateTag,
    journalPath: raw.get('journal-path') ?? 'data/research/strategy/execution_journal.jsonl',
    stageAssessmentOutput:
      raw.get('stage-assessment-output') ??
      `${analysisDir}/tradingagents_btc_stage_assessment_${dateTag}.json`,
    poolProfiles:
      poolProfiles.length > 0
        ? poolProfiles
        : ['baseline_guard_v1', 'baseline_robust_anchor_v1', 'baseline_independent_guard_v1'],
  }
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

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
