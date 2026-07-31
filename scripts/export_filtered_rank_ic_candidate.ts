import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

interface CliArgs {
  filterSweepPath: string
  outputPath: string | null
  json: boolean
}

interface FilteredRankIcCandidateReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  sourceFilterSweepPath: string
  dataDir: string
  symbolsLoaded: string[]
  commonPeriods: number | null
  dataCadence: Record<string, unknown>
  executionShape: Record<string, unknown>
  configsEvaluated: number
  selectedFilter: {
    id: string
    description: string
    thresholds: Record<string, unknown>
    generatedFrom: string
  } | null
  best: Record<string, unknown> | null
  wfo: Record<string, unknown>
  topConfigs: Record<string, unknown>[]
  bestByFactor: Array<{ factor: string; best: Record<string, unknown> | null }>
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_FILTER_SWEEP_PATH = 'data/research/rank_ic_regime_filter_sweep.live_accumulated_fwd72.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/cross_sectional_rank_ic.filtered_candidate.latest.json'

async function main(): Promise<void> {
  const args = parseFilteredRankIcExportArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runFilteredRankIcCandidateExport(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'filtered_rank_ic_candidate_export',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.best ? 'warn' : 'fail',
      recordsIn: report.configsEvaluated,
      recordsOut: report.best ? 1 : 0,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseFilteredRankIcExportArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    filterSweepPath: raw.get('filterSweepPath') ?? raw.get('input') ?? DEFAULT_FILTER_SWEEP_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runFilteredRankIcCandidateExport(args: CliArgs): Promise<FilteredRankIcCandidateReport> {
  const filterSweepPath = resolve(args.filterSweepPath)
  const root = asRecord(await readJsonIfExists(filterSweepPath))
  const report = buildFilteredRankIcCandidateReport({
    filterSweepPath,
    filterSweep: root,
    generatedAt: new Date().toISOString(),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildFilteredRankIcCandidateReport(input: {
  filterSweepPath: string
  filterSweep: Record<string, unknown> | null
  generatedAt?: string
}): FilteredRankIcCandidateReport {
  const root = input.filterSweep
  const bestCandidate = asRecord(root?.bestDiagnosticCandidate)
  const baseline = asRecord(root?.baseline)
  const selected = bestCandidate ?? baseline
  const config = asRecord(root?.config)
  const summary = asRecord(selected?.summary)
  const wfo = asRecord(selected?.wfo)
  const filter = asRecord(selected?.filter)
  const factor = readString(config?.factor) ?? 'unknown_factor'
  const best = selected && config && summary
    ? {
        lookbackHours: readNumber(config.lookbackHours),
        secondaryLookbackHours: readNumber(config.secondaryLookbackHours),
        forwardHours: readNumber(config.forwardHours),
        lookbackBars: readNumber(config.lookbackBars),
        secondaryLookbackBars: readNumber(config.secondaryLookbackBars),
        forwardBars: readNumber(config.forwardBars),
        mtfWeight: readNumber(config.mtfWeight),
        factor,
        observations: readNumber(summary.observations),
        periods: readNumber(summary.periods),
        meanIc: readNumber(summary.meanIc),
        icIr: readNumber(summary.icIr),
        winRate: readNumber(summary.winRate),
        passed: readBool(summary.passed) === true,
        averageLongShortSpreadPct: readNumber(summary.averageLongShortSpreadPct),
        longShortWinRate: readNumber(summary.longShortWinRate),
        signalPeriods: readNumber(summary.signalPeriods),
        filterId: readString(filter?.id),
        filterGeneratedFrom: readString(filter?.generatedFrom),
      }
    : null
  const blockers = buildBlockers(root, bestCandidate, best, selected)
  const dataCadence = {
    barMinutes: readNumber(root?.barMinutes),
    promotionTimeframe: '1h_required',
    nonHourlyDiagnosticOnly: readNumber(root?.barMinutes) !== 60,
    lookbackUnit: 'hours',
    filterDiagnosticOnly: true,
  }
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    sourceFilterSweepPath: resolve(input.filterSweepPath),
    dataDir: readString(root?.dataDir) ?? '',
    symbolsLoaded: readStringArray(root?.symbolsLoaded),
    commonPeriods: readNumber(asRecord(root?.dataAlignment)?.loadedCommonPeriods),
    dataCadence,
    executionShape: {
      mode: 'paper',
      source: 'filtered_rank_ic_candidate_export',
    },
    configsEvaluated: Array.isArray(root?.candidates) ? root.candidates.length : 0,
    selectedFilter: filter
      ? {
          id: readString(filter.id) ?? 'unknown_filter',
          description: readString(filter.description) ?? '',
          thresholds: asRecord(filter.thresholds) ?? {},
          generatedFrom: readString(filter.generatedFrom) ?? 'unknown',
        }
      : null,
    best,
    wfo: {
      status: readString(wfo?.status) ?? 'missing',
      testedConfig: best,
      selectionSource: bestCandidate ? 'filtered_regime_sweep_best_diagnostic' : 'filtered_regime_sweep_baseline_fallback',
      windowCount: readNumber(wfo?.windowCount) ?? 0,
      passedWindows: readNumber(wfo?.passedWindows) ?? 0,
      failedWindows: readNumber(wfo?.failedWindows) ?? 0,
      failedWindowRatio: readNumber(wfo?.failedWindowRatio),
      failWindowRatioThreshold: readNumber(wfo?.failWindowRatioThreshold),
      directionStable: readBool(wfo?.directionStable) === true,
      windows: Array.isArray(wfo?.windows) ? wfo.windows : [],
      blockers: readStringArray(wfo?.blockers),
    },
    topConfigs: best ? [best] : [],
    bestByFactor: [{ factor, best }],
    blockers,
    nextActions: [
      'Keep paper/live disabled; this exported candidate is a route-cost-compatible diagnostic view only.',
      'If route-cost remains interesting, implement the filter in a dedicated research RankIC run and validate it on future/live-only out-of-sample windows.',
      'Do not use this artifact as promotion evidence until complete trial ledger, BY FDR, PIT, WFO, runtime fee, and paper execution gates pass.',
    ],
    notes: [
      'This file reshapes a regime-filter sweep candidate into the RankIC report fields consumed by route-cost validation.',
      'The selected filter was generated in-sample and is explicitly not promotion-grade.',
      'No best_config, release gate, paper account, or live execution policy is mutated by this artifact.',
    ],
  }
}

function buildBlockers(
  root: Record<string, unknown> | null,
  bestCandidate: Record<string, unknown> | null,
  best: Record<string, unknown> | null,
  selected: Record<string, unknown> | null,
): string[] {
  const blockers = [
    'research_only_not_promotion_evidence',
    'filtered_candidate_in_sample_overfit_risk',
    'not_promotion_grade_wfo_validated',
    'not_trial_ledger_fdr_validated',
    'not_route_cost_validated',
    'not_paper_execution_evidence',
  ]
  if (!root) blockers.push('filter_sweep_missing_or_invalid')
  if (!selected) blockers.push('filter_sweep_candidate_missing')
  if (!best) blockers.push('filtered_rank_ic_best_missing')
  if (!bestCandidate) blockers.push('no_improved_wfo_filter_candidate')
  const selectedWarnings = readStringArray(selected?.warnings)
  blockers.push(...selectedWarnings.map(warning => `filter_warning:${warning}`))
  const wfoStatus = readString(asRecord(selected?.wfo)?.status)
  if (wfoStatus !== 'pass') blockers.push(`rank_ic_wfo_status:${wfoStatus ?? 'missing'}`)
  return uniqueStrings(blockers)
}

function renderConsoleSummary(report: FilteredRankIcCandidateReport): string {
  return [
    `filtered rank-ic candidate export: best=${report.best ? report.selectedFilter?.id ?? 'baseline' : 'none'}, wfo=${readString(report.wfo.status) ?? 'missing'}`,
    `gross=${report.best?.averageLongShortSpreadPct ?? null}, periods=${report.best?.periods ?? null}, signals=${report.best?.signalPeriods ?? null}`,
    `blockers=${report.blockers.slice(0, 10).join('|')}`,
  ].join('\n')
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

function parseNullablePath(raw: string | undefined): string | null {
  if (!raw) return null
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'null' || normalized === 'none' || normalized === 'false') return null
  return raw
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase())
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf-8'))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
