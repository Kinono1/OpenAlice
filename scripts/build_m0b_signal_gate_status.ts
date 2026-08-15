import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type Status = 'pass' | 'fail'

interface CliArgs {
  outputPath: string | null
  json: boolean
  reportPath?: string | null
}

export interface M0bSignalGateStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: Status
  gateResults: {
    spearmanIC: { value: number | null; threshold: 0.03; pass: boolean }
    icir: { value: number | null; threshold: 0.3; pass: boolean }
    topBottomGross: { value: number | null; threshold: 0; pass: boolean }
    topBottomNet: { value: number | null; threshold: 0; pass: boolean }
    turnoverCost: { value: number | null; threshold: 0.5; pass: boolean }
    continuousDays: { value: number | null; threshold: 60; pass: boolean }
    negativeControl: { value: number | null; threshold: 0.03; pass: boolean }
  }
  allPassed: boolean
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

export interface TrainingReport {
  ic?: {
    spearmanRankIc: number
    effectiveNCorrected: boolean
    icir: number
    icirMethod: string
  }
  topBottomSpread?: {
    grossReturn: number
    netReturn: number
  }
  turnover?: {
    costPct: number
    grossEdgePct: number
  }
  continuousValidDays?: number
  negativeControl?: {
    shuffledLabelIc: number
  }
  wfo?: {
    foldCount: number
    meanIc: number
    passRate: number
    medianSpread: number
  }
}

const DEFAULT_REPORT_PATH = 'data/research/training_report.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/m0b_signal_gate_status.latest.json'

async function main(): Promise<void> {
  const args = parseM0bSignalGateStatusArgs(process.argv.slice(2))
  const report = await runM0bSignalGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseM0bSignalGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const args: CliArgs = {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
  const reportPath = raw.get('reportPath') ?? raw.get('report')
  if (reportPath !== undefined) args.reportPath = parseNullablePath(reportPath)
  return args
}

export async function runM0bSignalGateStatus(args: CliArgs): Promise<M0bSignalGateStatus> {
  const startedAt = new Date()
  const generatedAt = new Date().toISOString()
  const trainingData = await readJsonIfExists(args.reportPath ?? DEFAULT_REPORT_PATH) as TrainingReport | null
  const report = buildM0bSignalGateStatus(generatedAt, trainingData)
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'm0b_signal_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.allPassed ? 'pass' : 'fail',
      recordsIn: 1,
      recordsOut: 1,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export function buildM0bSignalGateStatus(
  generatedAt: string,
  report: TrainingReport | null,
): M0bSignalGateStatus {
  if (!report) {
    return {
      schemaVersion: 1,
      generatedAt,
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'fail',
      gateResults: {
        spearmanIC: { value: null, threshold: 0.03, pass: false },
        icir: { value: null, threshold: 0.3, pass: false },
        topBottomGross: { value: null, threshold: 0, pass: false },
        topBottomNet: { value: null, threshold: 0, pass: false },
        turnoverCost: { value: null, threshold: 0.5, pass: false },
        continuousDays: { value: null, threshold: 60, pass: false },
        negativeControl: { value: null, threshold: 0.03, pass: false },
      },
      allPassed: false,
      blockers: ['training_report_missing'],
      nextActions: ['Run training pipeline to produce data/research/training_report.json before gate evaluation.'],
      safetyNotes: [
        'This artifact validates M0b signal-quality conditions only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
        'M0b is a pure research gate; execution-allowed flags are false at all times.',
      ],
    }
  }

  const spearmanIC = readNumber(report.ic?.spearmanRankIc)
  const spearmanIcPass = spearmanIC != null && spearmanIC > 0.03

  const icir = readNumber(report.ic?.icir)
  const icirPass = icir != null && icir > 0.3

  const topBottomGross = readNumber(report.topBottomSpread?.grossReturn)
  const topBottomGrossPass = topBottomGross != null && topBottomGross > 0

  const topBottomNet = readNumber(report.topBottomSpread?.netReturn)
  const topBottomNetPass = topBottomNet != null && topBottomNet > 0

  const turnoverCostPct = readNumber(report.turnover?.costPct)
  const grossEdgePct = readNumber(report.turnover?.grossEdgePct)
  let turnoverCostConstraint: number | null = null
  let turnoverCostPass = false
  if (turnoverCostPct != null && grossEdgePct != null && grossEdgePct > 0) {
    turnoverCostConstraint = turnoverCostPct / grossEdgePct
    turnoverCostPass = turnoverCostConstraint < 0.5
  }

  const continuousDays = readNumber(report.continuousValidDays)
  const continuousDaysPass = continuousDays != null && continuousDays >= 60

  const negativeControlIc = readNumber(report.negativeControl?.shuffledLabelIc)
  const negativeControlPass = negativeControlIc != null && negativeControlIc <= 0.03

  const allCheckResults = [
    { name: 'spearmanIC', value: spearmanIC, threshold: 0.03 as const, pass: spearmanIcPass },
    { name: 'icir', value: icir, threshold: 0.3 as const, pass: icirPass },
    { name: 'topBottomGross', value: topBottomGross, threshold: 0 as const, pass: topBottomGrossPass },
    { name: 'topBottomNet', value: topBottomNet, threshold: 0 as const, pass: topBottomNetPass },
    { name: 'turnoverCost', value: turnoverCostConstraint, threshold: 0.5 as const, pass: turnoverCostPass },
    { name: 'continuousDays', value: continuousDays, threshold: 60 as const, pass: continuousDaysPass },
    { name: 'negativeControl', value: negativeControlIc, threshold: 0.03 as const, pass: negativeControlPass },
  ]

  const blockers = allCheckResults
    .filter(r => !r.pass)
    .map(r => `${r.name}_failed:value=${r.value != null ? r.value.toFixed(6) : 'null'}_threshold=${r.threshold}`)

  const allPassed = blockers.length === 0

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: allPassed ? 'pass' : 'fail',
    gateResults: {
      spearmanIC: { value: spearmanIC, threshold: 0.03, pass: spearmanIcPass },
      icir: { value: icir, threshold: 0.3, pass: icirPass },
      topBottomGross: { value: topBottomGross, threshold: 0, pass: topBottomGrossPass },
      topBottomNet: { value: topBottomNet, threshold: 0, pass: topBottomNetPass },
      turnoverCost: { value: turnoverCostConstraint, threshold: 0.5, pass: turnoverCostPass },
      continuousDays: { value: continuousDays, threshold: 60, pass: continuousDaysPass },
      negativeControl: { value: negativeControlIc, threshold: 0.03, pass: negativeControlPass },
    },
    allPassed,
    blockers,
    nextActions: allPassed
      ? ['M0b signal gate passed. Proceed to M1 research kill gate when WFO-Lite evidence is ready.']
      : ['Fix failing M0b conditions before proceeding to M1 gates.'],
    safetyNotes: [
      'This artifact validates M0b signal-quality conditions only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'M0b is a pure research gate; execution-allowed flags are false at all times.',
    ],
  }
}

async function readJsonIfExists(path: string): Promise<unknown> {
  const resolved = resolve(path)
  if (!existsSync(resolved)) return null
  return JSON.parse(await readFile(resolved, 'utf-8'))
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i += 1
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function renderConsoleSummary(report: M0bSignalGateStatus): string {
  return [
    `M0b signal gate status: ${report.status}`,
    `allPassed=${report.allPassed}`,
    `spearmanIC=${report.gateResults.spearmanIC.value ?? 'null'} icir=${report.gateResults.icir.value ?? 'null'} topBottomGross=${report.gateResults.topBottomGross.value ?? 'null'} topBottomNet=${report.gateResults.topBottomNet.value ?? 'null'}`,
    `turnoverCost=${report.gateResults.turnoverCost.value != null ? report.gateResults.turnoverCost.value.toFixed(4) : 'null'} continuousDays=${report.gateResults.continuousDays.value ?? 'null'} negativeControl=${report.gateResults.negativeControl.value ?? 'null'}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_m0b_signal_gate_status failed:', error)
    process.exit(1)
  })
}
