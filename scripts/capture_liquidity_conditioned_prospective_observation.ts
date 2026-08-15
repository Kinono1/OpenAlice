import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { appendJsonlSync } from '../src/runtime/runtime_events.js'
import { defaultPaperUniverseSymbols, paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'

type LiquidityBucket = 'all' | 'low' | 'mid' | 'high'
type FactorDirection = 'momentum' | 'reversal'

interface CliArgs {
  factorReportPath: string
  dataDir: string
  ledgerPath: string
  outputPath: string | null
  candidateId: string | null
  maxCandidates: number
  symbols: string[]
  barMinutes: number | null
  maxRows: number | null
  minUniverseSize: number
  minBucketAssets: number
  topBottomFraction: number
  dryRun: boolean
  json: boolean
}

interface Candle {
  time: number
  close: number
  volume: number
}

interface AssetSeries {
  symbol: string
  candles: Candle[]
}

interface AssetAtDecision {
  symbol: string
  time: number
  currentPrice: number
  lookbackReturnPct: number
  factorValue: number
  dailyVolumeUsd: number
}

interface LiquidityCandidate {
  configId: string
  liquidityBucket: LiquidityBucket
  factor: FactorDirection
  lookbackHours: number
  forwardHours: number
  lookbackBars: number
  forwardBars: number
  routeCostPct: number
  netAfterRouteCostPct: number | null
  meanIc: number | null
  icIr: number | null
  averageLongShortSpreadPct: number | null
  longShortWinRate: number | null
  candidateVerdict: string | null
  wfo: {
    status: string | null
    failedWindowRatio: number | null
    failedWindowRatioThreshold: number | null
    passedWindows: number | null
    windowCount: number | null
  }
  blockers: string[]
}

interface LiquiditySignalLeg {
  symbol: string
  side: 'long' | 'short'
  currentPrice: number
  lookbackReturnPct: number
  factorValue: number
  dailyVolumeUsd: number
  rank: number
}

interface LiquidityRankSnapshot {
  symbol: string
  currentPrice: number
  lookbackReturnPct: number
  factorValue: number
  dailyVolumeUsd: number
  rank: number
  bucket: LiquidityBucket
}

export interface LiquidityConditionedProspectiveObservationEvent {
  schemaVersion: 1
  eventType: 'liquidity_conditioned_prospective_decision_open'
  researchOnly: true
  prospectiveOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  observationId: string
  candidateId: string
  strategyFamily: 'liquidity_conditioned_momentum_reversal'
  strategy: string
  decisionTime: string
  decisionBarTime: number
  labelDueTime: string
  labelDueBarTime: number
  labelDelayHours: number
  dataWatermark: string
  dataDir: string
  config: {
    liquidityBucket: LiquidityBucket
    factor: FactorDirection
    lookbackHours: number
    forwardHours: number
    lookbackBars: number
    forwardBars: number
    routeCostPct: number
    topBottomFraction: number
    minUniverseSize: number
    minBucketAssets: number
    barMinutes: number
  }
  liquiditySnapshot: {
    metric: 'trailing_24h_daily_volume_usd'
    totalAssetsAtDecision: number
    bucketAssetsAtDecision: number
    bucket: LiquidityBucket
    minBucketAssets: number
    lowEnd: number | null
    highStart: number | null
    minBucketVolumeUsd: number | null
    maxBucketVolumeUsd: number | null
  }
  signalPair: {
    long: LiquiditySignalLeg
    short: LiquiditySignalLeg
    labelStatus: 'pending_future_close'
  } | null
  rankSnapshot: LiquidityRankSnapshot[]
  currentEvidence: {
    candidateVerdict: string | null
    wfoStatus: string | null
    wfoFailedWindowRatio: number | null
    wfoPassedWindows: number | null
    wfoWindowCount: number | null
    meanIc: number | null
    icIr: number | null
    averageLongShortSpreadPct: number | null
    longShortWinRate: number | null
    netAfterManualRouteCostPct: number | null
    routeCostSource: string | null
    routeCostRuntimeVerified: boolean | null
  }
  blockers: string[]
  notes: string[]
}

export interface LiquidityConditionedProspectiveObservationCaptureReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  prospectiveOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  dryRun: boolean
  inputs: {
    factorReportPath: string
    dataDir: string
    ledgerPath: string
    outputPath: string | null
    candidateId: string | null
    maxCandidates: number
    barMinutes: number | null
    maxRows: number | null
  }
  status: 'captured' | 'skipped_duplicate' | 'blocked'
  appendResult: {
    appended: boolean
    reason: 'dry_run' | 'duplicate_observation_id' | 'blocked' | 'appended'
    observationId: string | null
  }
  appendResults: Array<{
    candidateId: string | null
    appended: boolean
    reason: 'dry_run' | 'duplicate_observation_id' | 'blocked' | 'appended'
    observationId: string | null
  }>
  counts: {
    symbolsLoaded: number
    existingLedgerEvents: number
    candidatesEvaluated: number
    observationsBuilt: number
    signalPairsOpened: number
    appendedObservations: number
    duplicateObservations: number
    blockedObservations: number
  }
  observation: LiquidityConditionedProspectiveObservationEvent | null
  observations: LiquidityConditionedProspectiveObservationEvent[]
  blockers: string[]
  notes: string[]
}

const DEFAULT_FACTOR_REPORT_PATH = 'data/research/liquidity_conditioned_factor_report.live_accumulated.latest.json'
const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_LEDGER_PATH = 'data/research/liquidity_conditioned_prospective_observations.live_accumulated.jsonl'
const DEFAULT_OUTPUT_PATH = 'data/research/liquidity_conditioned_prospective_observation_capture.live_accumulated.latest.json'

async function main(): Promise<void> {
  const args = parseLiquidityConditionedProspectiveObservationCaptureArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runLiquidityConditionedProspectiveObservationCapture(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'liquidity_conditioned_prospective_observation_capture',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked' ? 'fail' : 'warn',
      recordsIn: report.counts.symbolsLoaded,
      recordsOut: report.counts.appendedObservations,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseLiquidityConditionedProspectiveObservationCaptureArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    factorReportPath: raw.get('factorReportPath') ?? raw.get('report') ?? DEFAULT_FACTOR_REPORT_PATH,
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    candidateId: normalizeNullableString(raw.get('candidateId')),
    maxCandidates: parsePositiveInteger(raw.get('maxCandidates'), 1, 'maxCandidates'),
    symbols: parseSymbols(raw.get('symbols')),
    barMinutes: parseNullablePositiveInteger(raw.get('barMinutes'), null, 'barMinutes'),
    maxRows: parseNullablePositiveInteger(raw.get('maxRows'), null, 'maxRows'),
    minUniverseSize: parsePositiveInteger(raw.get('minUniverseSize'), 20, 'minUniverseSize'),
    minBucketAssets: parsePositiveInteger(raw.get('minBucketAssets'), 5, 'minBucketAssets'),
    topBottomFraction: parseFraction(raw.get('topBottomFraction'), 0.2, 'topBottomFraction'),
    dryRun: parseBool(raw.get('dryRun'), true),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runLiquidityConditionedProspectiveObservationCapture(
  args: CliArgs,
): Promise<LiquidityConditionedProspectiveObservationCaptureReport> {
  const factorReportPath = resolve(args.factorReportPath)
  const dataDir = resolve(args.dataDir)
  const ledgerPath = resolve(args.ledgerPath)
  const reportJson = asRecord(await readJsonIfExists(factorReportPath))
  const symbols = args.symbols.length > 0 ? args.symbols : readSymbolsFromReport(reportJson)
  const barMinutes = args.barMinutes ?? readNumber(asRecord(reportJson?.dataCadence)?.barMinutes) ?? 60
  const assets = await loadAssets(dataDir, symbols, args.maxRows, timeframeForBarMinutes(barMinutes))
  const existingLedger = readLiquidityConditionedProspectiveObservationLedger(ledgerPath)
  const report = buildLiquidityConditionedProspectiveObservationCaptureReport({
    factorReportPath,
    dataDir,
    ledgerPath,
    outputPath: args.outputPath ? resolve(args.outputPath) : null,
    factorReport: reportJson,
    assets,
    existingLedger,
    args: {
      ...args,
      barMinutes,
    },
    generatedAt: new Date().toISOString(),
  })

  if (!args.dryRun && report.status !== 'blocked') {
    let appendedObservations = 0
    report.appendResults = report.appendResults.map((result, index) => {
      const observation = report.observations[index]
      if (!observation || result.reason !== 'appended') return result
      appendJsonlSync(ledgerPath, observation)
      appendedObservations += 1
      return {
        ...result,
        appended: true,
      }
    })
    report.appendResult = report.appendResults.find(result => result.appended) ?? report.appendResult
    report.counts.appendedObservations = appendedObservations
    if (report.appendResult.appended) {
      report.appendResult = {
        ...report.appendResult,
        appended: true,
      }
    }
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildLiquidityConditionedProspectiveObservationCaptureReport(input: {
  factorReportPath: string
  dataDir: string
  ledgerPath: string
  outputPath: string | null
  factorReport: Record<string, unknown> | null
  assets: AssetSeries[]
  existingLedger: LiquidityConditionedProspectiveObservationEvent[]
  args: Pick<CliArgs, 'candidateId' | 'maxCandidates' | 'barMinutes' | 'maxRows' | 'minUniverseSize' | 'minBucketAssets' | 'topBottomFraction' | 'dryRun'>
  generatedAt?: string
}): LiquidityConditionedProspectiveObservationCaptureReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const candidates = extractCandidates(input.factorReport, input.args.candidateId, input.args.maxCandidates)
  const barMinutes = input.args.barMinutes ?? readNumber(asRecord(input.factorReport?.dataCadence)?.barMinutes) ?? 60
  const routeCost = asRecord(input.factorReport?.routeCost)
  const existingIds = new Set(input.existingLedger.map(event => event.observationId))
  const blockers = buildBaseBlockers(input.factorReport, candidates, input.assets, input.args.minUniverseSize)
  const observations = blockers.length === 0
    ? candidates.map(candidate => buildObservation({
        factorReport: input.factorReport!,
        candidate,
        assets: input.assets,
        dataDir: input.dataDir,
        args: {
          barMinutes,
          minUniverseSize: input.args.minUniverseSize,
          minBucketAssets: input.args.minBucketAssets,
          topBottomFraction: input.args.topBottomFraction,
        },
        routeCostSource: readString(routeCost?.source),
        routeCostRuntimeVerified: readBool(routeCost?.runtimeVerified),
      }))
    : []
  if (observations.length === 0 && blockers.length === 0) blockers.push('liquidity_conditioned_prospective_observation_not_built')
  blockers.push(...observations.flatMap(observation => observation.blockers))
  const appendResults = observations.map(observation => {
    const blocked = observation.blockers.some(isHardBlocker)
    const duplicate = existingIds.has(observation.observationId)
    const reason = blocked
      ? 'blocked'
      : duplicate
        ? 'duplicate_observation_id'
        : input.args.dryRun
          ? 'dry_run'
          : 'appended'
    return {
      candidateId: observation.candidateId,
      appended: false,
      reason,
      observationId: observation.observationId,
    }
  })
  const status: LiquidityConditionedProspectiveObservationCaptureReport['status'] = blockers.some(isHardBlocker)
    ? observations.length > 0 && appendResults.some(result => result.reason !== 'blocked')
      ? 'captured'
      : 'blocked'
    : appendResults.length > 0 && appendResults.every(result => result.reason === 'duplicate_observation_id')
      ? 'skipped_duplicate'
      : 'captured'
  const primaryAppendResult = appendResults.find(result => result.reason === 'appended' || result.reason === 'dry_run') ??
    appendResults[0] ?? {
      candidateId: null,
      appended: false,
      reason: status === 'blocked' ? 'blocked' : 'duplicate_observation_id',
      observationId: null,
    }

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    dryRun: input.args.dryRun,
    inputs: {
      factorReportPath: resolve(input.factorReportPath),
      dataDir: resolve(input.dataDir),
      ledgerPath: resolve(input.ledgerPath),
      outputPath: input.outputPath ? resolve(input.outputPath) : null,
      candidateId: input.args.candidateId,
      maxCandidates: input.args.maxCandidates,
      barMinutes,
      maxRows: input.args.maxRows,
    },
    status,
    appendResult: {
      appended: false,
      reason: primaryAppendResult.reason,
      observationId: primaryAppendResult.observationId,
    },
    appendResults,
    counts: {
      symbolsLoaded: input.assets.length,
      existingLedgerEvents: input.existingLedger.length,
      candidatesEvaluated: candidates.length,
      observationsBuilt: observations.length,
      signalPairsOpened: observations.filter(observation => observation.signalPair != null).length,
      appendedObservations: 0,
      duplicateObservations: appendResults.filter(result => result.reason === 'duplicate_observation_id').length,
      blockedObservations: appendResults.filter(result => result.reason === 'blocked').length,
    },
    observation: observations[0] ?? null,
    observations,
    blockers: uniqueStrings(blockers),
    notes: [
      'This capture is research-only prospective evidence collection for the liquidity-conditioned pivot; it does not place, propose, or authorize orders.',
      'Liquidity bucket assignment uses decision-time trailing 24h dollar volume only.',
      'Duplicate observation ids are skipped so scheduled capture can run idempotently on the same decision bar.',
      'Multiple captured candidates on the same decision bar are correlated research observations; they must not be counted as independent promotion-grade windows.',
    ],
  }
}

function buildObservation(input: {
  factorReport: Record<string, unknown>
  candidate: LiquidityCandidate
  assets: AssetSeries[]
  dataDir: string
  args: {
    barMinutes: number
    minUniverseSize: number
    minBucketAssets: number
    topBottomFraction: number
  }
  routeCostSource: string | null
  routeCostRuntimeVerified: boolean | null
}): LiquidityConditionedProspectiveObservationEvent {
  const commonPeriods = input.assets.length > 0 ? Math.min(...input.assets.map(asset => asset.candles.length)) : 0
  const index = commonPeriods - 1
  const current = input.assets[0]?.candles[index]
  const runtimeStatsBySymbol = buildDailyVolumeUsdBySymbol(input.assets, input.args.barMinutes)
  const rows = buildAssetsAtDecision({
    assets: input.assets,
    runtimeStatsBySymbol,
    index,
    lookbackBars: input.candidate.lookbackBars,
    factor: input.candidate.factor,
  })
  const bucketSelection = selectLiquidityBucket(rows, input.candidate.liquidityBucket)
  const minBucketAssets = input.candidate.liquidityBucket === 'all'
    ? input.args.minUniverseSize
    : input.args.minBucketAssets
  const rankSnapshot = [...bucketSelection.rows]
    .sort((left, right) => right.factorValue - left.factorValue || right.dailyVolumeUsd - left.dailyVolumeUsd)
    .map((row, rankIndex) => ({
      symbol: row.symbol,
      currentPrice: row.currentPrice,
      lookbackReturnPct: round(row.lookbackReturnPct, 10),
      factorValue: round(row.factorValue, 10),
      dailyVolumeUsd: round(row.dailyVolumeUsd, 4),
      rank: rankIndex + 1,
      bucket: input.candidate.liquidityBucket,
    }))
  const pair = selectSignalPair(rankSnapshot)
  const labelDelayHours = input.candidate.forwardHours
  const labelDueBarTime = (current?.time ?? 0) + labelDelayHours * 60 * 60 * 1_000
  const blockers = [
    'liquidity_conditioned_prospective_observation_not_execution_evidence',
    'paper_live_execution_disabled',
    'future_label_pending',
  ]
  if (rows.length < input.args.minUniverseSize) {
    blockers.push(`assets_at_decision_low:${rows.length}<${input.args.minUniverseSize}`)
  }
  if (bucketSelection.rows.length < minBucketAssets) {
    blockers.push(`bucket_assets_at_decision_low:${bucketSelection.rows.length}<${minBucketAssets}`)
  }
  if (!pair) blockers.push('decision_signal_pair_missing')
  if (input.candidate.wfo.status !== 'pass') blockers.push(`liquidity_conditioned_wfo_status:${input.candidate.wfo.status ?? 'missing'}`)
  const failedWindowRatio = input.candidate.wfo.failedWindowRatio
  const failedWindowRatioThreshold = input.candidate.wfo.failedWindowRatioThreshold
  if (
    failedWindowRatio != null &&
    failedWindowRatioThreshold != null &&
    failedWindowRatio > failedWindowRatioThreshold
  ) {
    blockers.push(`liquidity_conditioned_wfo_failed_window_ratio:${failedWindowRatio}>${failedWindowRatioThreshold}`)
  }
  if (input.routeCostRuntimeVerified !== true) blockers.push('runtime_fee_not_verified')
  if (input.routeCostRuntimeVerified !== true) blockers.push('route_cost_manual_not_runtime_verified')
  blockers.push('not_trial_ledger_fdr_validated')
  blockers.push('not_pit_audit_validated')
  blockers.push('not_paper_execution_evidence')

  const candidateId = input.candidate.configId
  const observationId = buildObservationId({
    candidateId,
    decisionBarTime: current?.time ?? 0,
    longSymbol: pair?.long.symbol ?? 'no_long',
    shortSymbol: pair?.short.symbol ?? 'no_short',
  })

  return {
    schemaVersion: 1,
    eventType: 'liquidity_conditioned_prospective_decision_open',
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId,
    candidateId,
    strategyFamily: 'liquidity_conditioned_momentum_reversal',
    strategy: `${input.candidate.liquidityBucket}_${input.candidate.factor}`,
    decisionTime: current ? new Date(current.time).toISOString() : '',
    decisionBarTime: current?.time ?? 0,
    labelDueTime: new Date(labelDueBarTime).toISOString(),
    labelDueBarTime,
    labelDelayHours,
    dataWatermark: current ? new Date(current.time).toISOString() : '',
    dataDir: resolve(input.dataDir),
    config: {
      liquidityBucket: input.candidate.liquidityBucket,
      factor: input.candidate.factor,
      lookbackHours: input.candidate.lookbackHours,
      forwardHours: input.candidate.forwardHours,
      lookbackBars: input.candidate.lookbackBars,
      forwardBars: input.candidate.forwardBars,
      routeCostPct: input.candidate.routeCostPct,
      topBottomFraction: input.args.topBottomFraction,
      minUniverseSize: input.args.minUniverseSize,
      minBucketAssets: input.args.minBucketAssets,
      barMinutes: input.args.barMinutes,
    },
    liquiditySnapshot: {
      metric: 'trailing_24h_daily_volume_usd',
      totalAssetsAtDecision: rows.length,
      bucketAssetsAtDecision: bucketSelection.rows.length,
      bucket: input.candidate.liquidityBucket,
      minBucketAssets,
      lowEnd: bucketSelection.lowEnd,
      highStart: bucketSelection.highStart,
      minBucketVolumeUsd: bucketSelection.rows.length > 0
        ? round(Math.min(...bucketSelection.rows.map(row => row.dailyVolumeUsd)), 4)
        : null,
      maxBucketVolumeUsd: bucketSelection.rows.length > 0
        ? round(Math.max(...bucketSelection.rows.map(row => row.dailyVolumeUsd)), 4)
        : null,
    },
    signalPair: pair,
    rankSnapshot,
    currentEvidence: {
      candidateVerdict: input.candidate.candidateVerdict,
      wfoStatus: input.candidate.wfo.status,
      wfoFailedWindowRatio: input.candidate.wfo.failedWindowRatio,
      wfoPassedWindows: input.candidate.wfo.passedWindows,
      wfoWindowCount: input.candidate.wfo.windowCount,
      meanIc: input.candidate.meanIc,
      icIr: input.candidate.icIr,
      averageLongShortSpreadPct: input.candidate.averageLongShortSpreadPct,
      longShortWinRate: input.candidate.longShortWinRate,
      netAfterManualRouteCostPct: input.candidate.netAfterRouteCostPct,
      routeCostSource: input.routeCostSource,
      routeCostRuntimeVerified: input.routeCostRuntimeVerified,
    },
    blockers: uniqueStrings(blockers),
    notes: [
      'This is an open prospective decision observation, not a paper order and not a live order.',
      'Settlement must use future rows that arrive after decisionTime.',
      'Manual route-cost net is diagnostic until OKX runtime fees are verified.',
    ],
  }
}

function selectSignalPair(ranks: LiquidityRankSnapshot[]): LiquidityConditionedProspectiveObservationEvent['signalPair'] {
  if (ranks.length < 2) return null
  const long = ranks[0]
  const short = ranks[ranks.length - 1]
  if (!long || !short || long.symbol === short.symbol) return null
  return {
    long: {
      symbol: long.symbol,
      side: 'long',
      currentPrice: long.currentPrice,
      lookbackReturnPct: long.lookbackReturnPct,
      factorValue: long.factorValue,
      dailyVolumeUsd: long.dailyVolumeUsd,
      rank: long.rank,
    },
    short: {
      symbol: short.symbol,
      side: 'short',
      currentPrice: short.currentPrice,
      lookbackReturnPct: short.lookbackReturnPct,
      factorValue: short.factorValue,
      dailyVolumeUsd: short.dailyVolumeUsd,
      rank: short.rank,
    },
    labelStatus: 'pending_future_close',
  }
}

function extractCandidates(report: Record<string, unknown> | null, candidateId: string | null, maxCandidates: number): LiquidityCandidate[] {
  if (!report) return []
  const rawCandidates = [
    asRecord(report.best),
    ...(Array.isArray(report.topConfigs) ? report.topConfigs.map(asRecord) : []),
  ].filter(isRecordValue)
  const seen = new Set<string>()
  const deduped = rawCandidates.filter(candidate => {
    const id = readString(candidate.configId)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
  const selected = candidateId
    ? deduped.filter(candidate => readString(candidate.configId) === candidateId)
    : deduped.slice(0, maxCandidates)
  return selected.map(parseCandidate).filter((candidate): candidate is LiquidityCandidate => candidate != null)
}

function parseCandidate(raw: Record<string, unknown>): LiquidityCandidate | null {
  if (!raw) return null
  const liquidityBucket = readLiquidityBucket(raw.liquidityBucket)
  const factor = readFactorDirection(raw.factor)
  const lookbackHours = readNumber(raw.lookbackHours)
  const forwardHours = readNumber(raw.forwardHours)
  const lookbackBars = readNumber(raw.lookbackBars)
  const forwardBars = readNumber(raw.forwardBars)
  const routeCostPct = readNumber(raw.routeCostPct)
  const configId = readString(raw.configId)
  if (
    !configId ||
    !liquidityBucket ||
    !factor ||
    lookbackHours == null ||
    forwardHours == null ||
    lookbackBars == null ||
    forwardBars == null ||
    routeCostPct == null
  ) return null
  const wfo = asRecord(raw.wfo)
  return {
    configId,
    liquidityBucket,
    factor,
    lookbackHours,
    forwardHours,
    lookbackBars,
    forwardBars,
    routeCostPct,
    netAfterRouteCostPct: readNumber(raw.netAfterRouteCostPct),
    meanIc: readNumber(raw.meanIc),
    icIr: readNumber(raw.icIr),
    averageLongShortSpreadPct: readNumber(raw.averageLongShortSpreadPct),
    longShortWinRate: readNumber(raw.longShortWinRate),
    candidateVerdict: readString(raw.candidateVerdict),
    wfo: {
      status: readString(wfo?.status),
      failedWindowRatio: readNumber(wfo?.failedWindowRatio),
      failedWindowRatioThreshold: readNumber(wfo?.failWindowRatioThreshold),
      passedWindows: readNumber(wfo?.passedWindows),
      windowCount: readNumber(wfo?.windowCount),
    },
    blockers: readStringArray(raw.blockers),
  }
}

function buildBaseBlockers(
  report: Record<string, unknown> | null,
  candidates: LiquidityCandidate[],
  assets: AssetSeries[],
  minUniverseSize: number,
): string[] {
  const blockers: string[] = []
  if (!report) blockers.push('liquidity_conditioned_factor_report_missing')
  if (report && report.researchOnly !== true) blockers.push('liquidity_conditioned_factor_report_not_research_only')
  if (candidates.length === 0) blockers.push('liquidity_conditioned_candidate_missing')
  if (assets.length < minUniverseSize) blockers.push(`loaded_universe_too_small:${assets.length}<${minUniverseSize}`)
  if (assets.length > 0 && Math.min(...assets.map(asset => asset.candles.length)) <= 1) {
    blockers.push('loaded_assets_have_insufficient_rows')
  }
  return blockers
}

function buildAssetsAtDecision(input: {
  assets: AssetSeries[]
  runtimeStatsBySymbol: Map<string, number[]>
  index: number
  lookbackBars: number
  factor: FactorDirection
}): AssetAtDecision[] {
  const rows: AssetAtDecision[] = []
  for (const asset of input.assets) {
    const current = asset.candles[input.index]
    const lookback = asset.candles[input.index - input.lookbackBars]
    const dailyVolumeUsd = input.runtimeStatsBySymbol.get(asset.symbol)?.[input.index]
    if (!current || !lookback || dailyVolumeUsd == null) continue
    if (current.close <= 0 || lookback.close <= 0 || dailyVolumeUsd <= 0) continue
    const lookbackReturnPct = (current.close / lookback.close - 1) * 100
    rows.push({
      symbol: asset.symbol,
      time: current.time,
      currentPrice: current.close,
      lookbackReturnPct,
      factorValue: input.factor === 'momentum' ? lookbackReturnPct : -lookbackReturnPct,
      dailyVolumeUsd,
    })
  }
  return rows
}

function selectLiquidityBucket(
  rows: AssetAtDecision[],
  bucket: LiquidityBucket,
): { rows: AssetAtDecision[]; lowEnd: number | null; highStart: number | null } {
  if (bucket === 'all') return { rows, lowEnd: null, highStart: null }
  const sorted = [...rows].sort((left, right) => left.dailyVolumeUsd - right.dailyVolumeUsd)
  const lowEnd = Math.ceil(sorted.length / 3)
  const highStart = Math.floor(sorted.length * 2 / 3)
  if (bucket === 'low') return { rows: sorted.slice(0, lowEnd), lowEnd, highStart }
  if (bucket === 'mid') return { rows: sorted.slice(lowEnd, highStart), lowEnd, highStart }
  return { rows: sorted.slice(highStart), lowEnd, highStart }
}

function buildDailyVolumeUsdBySymbol(assets: AssetSeries[], barMinutes: number): Map<string, number[]> {
  const dailyBars = hoursToBars(24, barMinutes)
  return new Map(assets.map(asset => [asset.symbol, buildDailyVolumeUsd(asset.candles, dailyBars)]))
}

function buildDailyVolumeUsd(candles: Candle[], dailyBars: number): number[] {
  const prefix = [0]
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    const volumeUsd = candle.close > 0 && candle.volume > 0 ? candle.close * candle.volume : 0
    prefix.push(prefix[index] + volumeUsd)
  }
  return candles.map((_candle, index) => {
    const start = Math.max(0, index - dailyBars + 1)
    return prefix[index + 1] - prefix[start]
  })
}

async function loadAssets(
  dataDir: string,
  symbols: string[],
  maxRows: number | null,
  timeframe: PaperUniverseTimeframe,
): Promise<AssetSeries[]> {
  const assets: AssetSeries[] = []
  for (const symbol of symbols) {
    const path = join(dataDir, paperSymbolToCsvFile(symbol, timeframe))
    if (!existsSync(path)) continue
    const candles = await loadCandles(path, maxRows)
    if (candles.length > 0) assets.push({ symbol, candles })
  }
  return alignByTailLength(assets)
}

async function loadCandles(path: string, maxRows: number | null): Promise<Candle[]> {
  const raw = await readFile(path, 'utf-8')
  const lines = raw.trim().split('\n').filter(Boolean)
  if (lines.length <= 1) return []
  const header = lines[0].split(',')
  const timeIndex = header.indexOf('timestamp')
  const closeIndex = header.indexOf('close')
  const volumeIndex = header.indexOf('volume')
  const dataLines = maxRows == null ? lines.slice(1) : lines.slice(Math.max(1, lines.length - maxRows))
  return dataLines.map(line => {
    const cols = line.split(',')
    return {
      time: Number(cols[timeIndex]),
      close: Number(cols[closeIndex]),
      volume: Number(cols[volumeIndex]),
    }
  })
    .filter(candle => candle.time > 0 && [candle.close, candle.volume].every(Number.isFinite))
    .sort((left, right) => left.time - right.time)
}

function alignByTailLength(assets: AssetSeries[]): AssetSeries[] {
  if (assets.length === 0) return []
  const minLength = Math.min(...assets.map(asset => asset.candles.length))
  return assets
    .filter(asset => asset.candles.length >= minLength && minLength > 0)
    .map(asset => ({
      symbol: asset.symbol,
      candles: asset.candles.slice(asset.candles.length - minLength),
    }))
}

function readLiquidityConditionedProspectiveObservationLedger(path: string): LiquidityConditionedProspectiveObservationEvent[] {
  if (!existsSync(path)) return []
  const events: LiquidityConditionedProspectiveObservationEvent[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed?.eventType === 'liquidity_conditioned_prospective_decision_open') events.push(parsed)
    } catch {
      // Ignore malformed research-ledger rows to keep scheduled capture idempotent.
    }
  }
  return events
}

function buildObservationId(input: {
  candidateId: string
  decisionBarTime: number
  longSymbol: string
  shortSymbol: string
}): string {
  return createHash('sha256')
    .update(`${input.candidateId}|${input.decisionBarTime}|${input.longSymbol}|${input.shortSymbol}`)
    .digest('hex')
    .slice(0, 24)
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf-8'))
}

function readSymbolsFromReport(report: Record<string, unknown> | null): string[] {
  const symbolsLoaded = Array.isArray(report?.symbolsLoaded)
    ? report.symbolsLoaded.map(readString).filter((value): value is string => Boolean(value))
    : []
  return symbolsLoaded.length > 0 ? symbolsLoaded : defaultPaperUniverseSymbols()
}

function isHardBlocker(blocker: string): boolean {
  return [
    'missing',
    'not_research_only',
    'candidate_missing',
    'universe_too_small',
    'insufficient_rows',
    'assets_at_decision_low',
    'bucket_assets_at_decision_low',
    'decision_signal_pair_missing',
    'not_built',
  ].some(fragment => blocker.includes(fragment))
}

function timeframeForBarMinutes(barMinutes: number): PaperUniverseTimeframe {
  if (barMinutes === 60) return '1h'
  if (barMinutes === 5) return '5m'
  if (barMinutes * 60 === 1) return '1s'
  throw new Error(`Unsupported barMinutes for paper universe files: ${barMinutes}`)
}

function hoursToBars(hours: number, barMinutes: number): number {
  const bars = Math.round(hours * 60 / barMinutes)
  if (!Number.isFinite(bars) || bars <= 0) throw new Error(`Invalid bar conversion: hours=${hours}, barMinutes=${barMinutes}`)
  return bars
}

function renderConsoleSummary(report: LiquidityConditionedProspectiveObservationCaptureReport): string {
  return [
    `liquidity prospective observation capture: status=${report.status}, dryRun=${report.dryRun}, observations=${report.counts.observationsBuilt}, appended=${report.counts.appendedObservations}`,
    `paper=false, live=false, promotion=false`,
    `observation=${report.observation?.observationId ?? 'none'} pair=${report.observation?.signalPair ? `${report.observation.signalPair.long.symbol}/${report.observation.signalPair.short.symbol}` : 'none'}`,
    `blockers=${report.blockers.slice(0, 10).join('|') || 'none'}`,
  ].join('\n')
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
  return !normalized || normalized === 'null' || normalized === 'false' || normalized === 'none' ? null : raw
}

function parseSymbols(raw: string | undefined): string[] {
  if (!raw || raw.trim().toLowerCase() === 'default') return []
  return raw.split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean)
}

function parseNullablePositiveInteger(raw: string | undefined, fallback: number | null, name: string): number | null {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'null' || normalized === 'none' || normalized === 'false') return null
  return parsePositiveInteger(raw, fallback ?? 1, name)
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

function parseFraction(raw: string | undefined, fallback: number, name: string): number {
  const parsed = raw == null || raw.trim() === '' ? fallback : Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 0.5) {
    throw new Error(`${name} must be in (0, 0.5].`)
  }
  return parsed
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function normalizeNullableString(raw: string | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  return trimmed && !['null', 'none', 'false'].includes(trimmed.toLowerCase()) ? trimmed : null
}

function readLiquidityBucket(value: unknown): LiquidityBucket | null {
  return value === 'all' || value === 'low' || value === 'mid' || value === 'high' ? value : null
}

function readFactorDirection(value: unknown): FactorDirection | null {
  return value === 'momentum' || value === 'reversal' ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(readString).filter((item): item is string => Boolean(item)) : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isRecordValue(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value != null
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('capture_liquidity_conditioned_prospective_observation failed:', error)
    process.exit(1)
  })
}
