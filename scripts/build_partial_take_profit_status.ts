import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { computePartialTakeProfit } from '../src/domain/strategy/risk/partial-take-profit.js'

type Status = 'pass' | 'blocked'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

export interface PartialTakeProfitStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: Status
  checks: {
    longFirstTrancheCloseFraction: number
    longFirstTrancheCloseQuantity: number
    longIncrementalCloseFraction: number
    shortFirstTrancheCloseFraction: number
    notTriggeredCloseFraction: number
    levelCount: number
    totalConfiguredCloseFraction: number
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/partial_take_profit_status.latest.json'
const LEVELS = [
  { id: 'tp_1r', rewardMultiple: 1, closeFraction: 0.5 },
  { id: 'tp_2r', rewardMultiple: 2, closeFraction: 0.25 },
]

async function main(): Promise<void> {
  const args = parsePartialTakeProfitStatusArgs(process.argv.slice(2))
  const report = await runPartialTakeProfitStatus(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parsePartialTakeProfitStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runPartialTakeProfitStatus(args: CliArgs): Promise<PartialTakeProfitStatus> {
  const startedAt = new Date()
  const report = buildPartialTakeProfitStatus(new Date().toISOString())
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'partial_take_profit_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : 'fail',
      recordsIn: 4,
      recordsOut: 1,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export function buildPartialTakeProfitStatus(
  generatedAt = new Date().toISOString(),
): PartialTakeProfitStatus {
  const longFirst = computePartialTakeProfit({
    side: 'long',
    entryPrice: 100,
    currentPrice: 112,
    stopLossPrice: 90,
    originalQuantity: 10,
    levels: LEVELS,
  })
  const longIncremental = computePartialTakeProfit({
    side: 'long',
    entryPrice: 100,
    currentPrice: 125,
    stopLossPrice: 90,
    originalQuantity: 10,
    alreadyClosedFraction: 0.5,
    levels: LEVELS,
  })
  const shortFirst = computePartialTakeProfit({
    side: 'short',
    entryPrice: 100,
    currentPrice: 88,
    stopLossPrice: 110,
    originalQuantity: 20,
    levels: LEVELS,
  })
  const notTriggered = computePartialTakeProfit({
    side: 'long',
    entryPrice: 100,
    currentPrice: 104,
    stopLossPrice: 90,
    originalQuantity: 10,
    levels: LEVELS,
  })

  const totalConfiguredCloseFraction = LEVELS.reduce(
    (sum, level) => sum + level.closeFraction,
    0,
  )
  const blockers = [
    ...(longFirst.closeFraction === 0.5 && longFirst.closeQuantity === 5
      ? []
      : ['long_first_tranche_not_50pct']),
    ...(longIncremental.closeFraction === 0.25
      ? []
      : ['long_incremental_second_tranche_not_25pct']),
    ...(shortFirst.closeFraction === 0.5
      ? []
      : ['short_first_tranche_not_50pct']),
    ...(notTriggered.closeFraction === 0
      ? []
      : ['not_triggered_case_closed_position']),
    ...(totalConfiguredCloseFraction <= 1
      ? []
      : ['configured_close_fraction_gt_1']),
  ]

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: blockers.length === 0 ? 'pass' : 'blocked',
    checks: {
      longFirstTrancheCloseFraction: longFirst.closeFraction,
      longFirstTrancheCloseQuantity: longFirst.closeQuantity,
      longIncrementalCloseFraction: longIncremental.closeFraction,
      shortFirstTrancheCloseFraction: shortFirst.closeFraction,
      notTriggeredCloseFraction: notTriggered.closeFraction,
      levelCount: LEVELS.length,
      totalConfiguredCloseFraction,
    },
    blockers,
    nextActions: blockers.length === 0
      ? [
          'Wire this helper into paper/shadow exit simulation only after route-cost/slippage telemetry is available.',
          'Validate partial exits against prospective outcomes before treating this as promotion evidence.',
        ]
      : [
          'Fix partial take-profit tranche logic before integrating it with any paper or live execution path.',
        ],
    safetyNotes: [
      'This artifact validates an exit primitive only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'Partial take-profit status is not profitability proof and does not replace WFO/FDR/PIT/prospective/paper telemetry gates.',
    ],
  }
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

function renderConsoleSummary(report: PartialTakeProfitStatus): string {
  return [
    `Partial take-profit status: ${report.status}`,
    `longFirst=${report.checks.longFirstTrancheCloseFraction}`,
    `longIncremental=${report.checks.longIncrementalCloseFraction}`,
    `shortFirst=${report.checks.shortFirstTrancheCloseFraction}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_partial_take_profit_status failed:', error)
    process.exit(1)
  })
}
