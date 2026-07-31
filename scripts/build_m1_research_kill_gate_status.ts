import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type { TrainingReport } from './build_m0b_signal_gate_status.js'

type Status = 'pass' | 'fail'

interface CliArgs {
  outputPath: string | null
  json: boolean
  reportPath?: string | null
}

export interface M1ResearchKillGateStatus {
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
    wfoFoldCount: { value: number | null; threshold: 3; pass: boolean }
    wfoMeanIc: { value: number | null; threshold: 0; pass: boolean }
    wfoPassRate: { value: number | null; threshold: 0.3; pass: boolean }
    wfoMedianSpread: { value: number | null; threshold: 0; pass: boolean }
  }
  allPassed: boolean
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_REPORT_PATH = 'data/research/training_report.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/m1_research_kill_gate_status.latest.json'

async function main(): Promise<void> {
  const args = parseM1ResearchKillGateStatusArgs(process.argv.slice(2))
  const report = await runM1ResearchKillGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseM1ResearchKillGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const args: CliArgs = {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
  const reportPath = raw.get('reportPath') ?? raw.get('report')
  if (reportPath !== undefined) args.reportPath = parseNullablePath(reportPath)
  return args
}

export async function runM1ResearchKillGateStatus(args: CliArgs): Promise<M1ResearchKillGateStatus> {
  const startedAt = new Date()
  const generatedAt = new Date().toISOString()
  const trainingData = await readJsonIfExists(args.reportPath ?? DEFAULT_REPORT_PATH) as TrainingReport | null
  const report = buildM1ResearchKillGateStatus(generatedAt, trainingData)
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'm1_research_kill_gate_status',
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

export function buildM1ResearchKillGateStatus(
  generatedAt: string,
  report: TrainingReport | null,
): M1ResearchKillGateStatus {
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
        wfoFoldCount: { value: null, threshold: 3, pass: false },
        wfoMeanIc: { value: null, threshold: 0, pass: false },
        wfoPassRate: { value: null, threshold: 0.3, pass: false },
        wfoMedianSpread: { value: null, threshold: 0, pass: false },
      },
      allPassed: false,
      blockers: ['training_report_missing'],
      nextActions: ['Run training pipeline with WFO-Lite to produce data/research/training_report.json before M1 gate evaluation.'],
      safetyNotes: [
        'This artifact validates M1 WFO-Lite conditions only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
        'M1 is a pure research kill gate; execution-allowed flags are false at all times.',
      ],
    }
  }

  const wfo = report.wfo

  const wfoFoldCount = readNumber(wfo?.foldCount)
  const wfoFoldCountPass = wfoFoldCount != null && wfoFoldCount >= 3

  const wfoMeanIc = readNumber(wfo?.meanIc)
  const wfoMeanIcPass = wfoMeanIc != null && wfoMeanIc > 0

  const wfoPassRate = readNumber(wfo?.passRate)
  const wfoPassRatePass = wfoPassRate != null && wfoPassRate > 0.3

  const wfoMedianSpread = readNumber(wfo?.medianSpread)
  const wfoMedianSpreadPass = wfoMedianSpread != null && wfoMedianSpread > 0

  const allCheckResults = [
    { name: 'wfoFoldCount', value: wfoFoldCount, threshold: 3 as const, pass: wfoFoldCountPass },
    { name: 'wfoMeanIc', value: wfoMeanIc, threshold: 0 as const, pass: wfoMeanIcPass },
    { name: 'wfoPassRate', value: wfoPassRate, threshold: 0.3 as const, pass: wfoPassRatePass },
    { name: 'wfoMedianSpread', value: wfoMedianSpread, threshold: 0 as const, pass: wfoMedianSpreadPass },
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
      wfoFoldCount: { value: wfoFoldCount, threshold: 3, pass: wfoFoldCountPass },
      wfoMeanIc: { value: wfoMeanIc, threshold: 0, pass: wfoMeanIcPass },
      wfoPassRate: { value: wfoPassRate, threshold: 0.3, pass: wfoPassRatePass },
      wfoMedianSpread: { value: wfoMedianSpread, threshold: 0, pass: wfoMedianSpreadPass },
    },
    allPassed,
    blockers,
    nextActions: allPassed
      ? ['M1 research kill gate passed. Proceed to subsequent gates in the research-evidence pipeline.']
      : ['Fix failing M1 WFO-Lite conditions before proceeding in the pipeline.'],
    safetyNotes: [
      'This artifact validates M1 WFO-Lite conditions only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'M1 is a pure research kill gate; execution-allowed flags are false at all times.',
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

function renderConsoleSummary(report: M1ResearchKillGateStatus): string {
  return [
    `M1 research kill gate status: ${report.status}`,
    `allPassed=${report.allPassed}`,
    `wfoFoldCount=${report.gateResults.wfoFoldCount.value ?? 'null'} wfoMeanIc=${report.gateResults.wfoMeanIc.value ?? 'null'} wfoPassRate=${report.gateResults.wfoPassRate.value ?? 'null'} wfoMedianSpread=${report.gateResults.wfoMedianSpread.value ?? 'null'}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_m1_research_kill_gate_status failed:', error)
    process.exit(1)
  })
}
