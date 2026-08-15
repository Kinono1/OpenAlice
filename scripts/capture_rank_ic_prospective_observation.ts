import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  evaluateCrossSectionalMomentum,
  type CrossSectionalAsset,
} from '../src/domain/strategy/cross-sectional-momentum.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { appendJsonlSync } from '../src/runtime/runtime_events.js'
import {
  parseCrossSectionalExecutionMode,
  resolveCrossSectionalExecutionShape,
  type CrossSectionalExecutionMode,
} from './lib/cross_sectional_execution_shape.js'
import { defaultPaperUniverseSymbols, paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'

type FactorName =
  | 'raw_reversal'
  | 'risk_adjusted_reversal'
  | 'rank_reversal'
  | 'signal_confidence'

interface CliArgs {
  lanePath: string
  walkForwardPath: string
  dataDir: string
  ledgerPath: string
  outputPath: string | null
  symbols: string[]
  barMinutes: number
  maxRows: number | null
  maxVolPct: number
  minSpreadPct: number
  minUniverseSize: number
  executionMode: CrossSectionalExecutionMode
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

interface AssetRuntimeStats {
  realizedVolPct: number
  avgVolume24h: number
  dailyVolumeUsd: number
}

interface RankIcProspectiveConfig {
  lookbackHours: number
  secondaryLookbackHours: number
  forwardHours: number
  lookbackBars: number
  secondaryLookbackBars: number
  forwardBars: number
  mtfWeight: number
  factor: FactorName
}

interface ProspectiveRegimeObservation {
  index: number
  time: string
  medianReturnPct: number
  breadthPositivePct: number
  dispersionPct: number
  averageVolPct: number
}

interface ProspectiveFilter {
  filterId: string
  description: string | null
  thresholds: {
    minMedianReturnPct?: number
    maxMedianReturnPct?: number
    minBreadthPositivePct?: number
    maxDispersionPct?: number
    maxAverageVolPct?: number
  }
  thresholdSource: 'latest_walk_forward_validation_window'
}

interface ProspectiveRankSnapshot {
  symbol: string
  signal: number
  rank: number
  confidence: number
  currentPrice: number
  factorValue: number
  reason: string
}

interface ProspectiveSignalLeg {
  symbol: string
  side: 'long' | 'short'
  currentPrice: number
  rank: number
  confidence: number
  factorValue: number
}

export interface RankIcProspectiveObservationEvent {
  schemaVersion: 1
  eventType: 'prospective_decision_open'
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  observationId: string
  laneId: string
  candidateId: string
  strategyFamily: string
  filterId: string
  decisionTime: string
  decisionBarTime: number
  labelDueTime: string
  labelDueBarTime: number
  labelDelayHours: number
  dataWatermark: string
  dataDir: string
  config: RankIcProspectiveConfig
  filter: ProspectiveFilter & { allowed: boolean }
  regime: ProspectiveRegimeObservation | null
  universe: {
    symbolsLoaded: string[]
    assetsAtDecision: number
    executionMode: CrossSectionalExecutionMode
    topN: number
    bottomN: number
    minUniverseSize: number
  }
  signalPair: {
    long: ProspectiveSignalLeg
    short: ProspectiveSignalLeg
    labelStatus: 'pending_future_close'
  } | null
  rankSnapshot: ProspectiveRankSnapshot[]
  currentEvidence: {
    walkForwardWfoStatus: string | null
    walkForwardPassedWindows: number | null
    walkForwardWindowCount: number | null
    walkForwardFailedWindowRatio: number | null
    meanIc: number | null
    icIr: number | null
    netAfterRouteCostPct: number | null
    feeSnapshotSource: string | null
    feeSnapshotVerifiedByRuntime: boolean | null
  }
  blockers: string[]
  notes: string[]
}

export interface RankIcProspectiveObservationCaptureReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  prospectiveOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  dryRun: boolean
  inputs: {
    lanePath: string
    walkForwardPath: string
    dataDir: string
    ledgerPath: string
    outputPath: string | null
    barMinutes: number
    maxRows: number | null
    executionMode: CrossSectionalExecutionMode
  }
  status: 'captured' | 'skipped_duplicate' | 'blocked'
  appendResult: {
    appended: boolean
    reason: 'dry_run' | 'duplicate_observation_id' | 'blocked' | 'appended'
    observationId: string | null
  }
  counts: {
    symbolsLoaded: number
    existingLedgerEvents: number
    observationsBuilt: number
    signalPairsOpened: number
    appendedObservations: number
  }
  observation: RankIcProspectiveObservationEvent | null
  blockers: string[]
  notes: string[]
}

const DEFAULT_LANE_PATH = 'data/research/rank_ic_prospective_trial_lane.live_accumulated_fwd72_median_filter.latest.json'
const DEFAULT_WALK_FORWARD_PATH = 'data/research/rank_ic_walkforward_filter_validation.live_accumulated_fwd72.latest.json'
const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_LEDGER_PATH = 'data/research/rank_ic_prospective_observations.live_accumulated_fwd72_median_filter.jsonl'
const DEFAULT_OUTPUT_PATH = 'data/research/rank_ic_prospective_observation_capture.live_accumulated_fwd72_median_filter.latest.json'

async function main(): Promise<void> {
  const args = parseRankIcProspectiveObservationCaptureArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runRankIcProspectiveObservationCapture(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'rank_ic_prospective_observation_capture',
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

export function parseRankIcProspectiveObservationCaptureArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    lanePath: raw.get('lanePath') ?? raw.get('lane') ?? DEFAULT_LANE_PATH,
    walkForwardPath: raw.get('walkForwardPath') ?? raw.get('walkForward') ?? DEFAULT_WALK_FORWARD_PATH,
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    symbols: parseSymbols(raw.get('symbols')),
    barMinutes: parsePositiveInteger(raw.get('barMinutes'), 60, 'barMinutes'),
    maxRows: parseNullablePositiveInteger(raw.get('maxRows'), null, 'maxRows'),
    maxVolPct: parseFiniteNumber(raw.get('maxVolPct'), 99, 'maxVolPct'),
    minSpreadPct: parseFiniteNumber(raw.get('minSpreadPct'), 0, 'minSpreadPct'),
    minUniverseSize: parsePositiveInteger(raw.get('minUniverseSize'), 20, 'minUniverseSize'),
    executionMode: parseCrossSectionalExecutionMode(raw.get('executionMode'), 'paper'),
    dryRun: parseBool(raw.get('dryRun'), true),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRankIcProspectiveObservationCapture(
  args: CliArgs,
): Promise<RankIcProspectiveObservationCaptureReport> {
  const lanePath = resolve(args.lanePath)
  const walkForwardPath = resolve(args.walkForwardPath)
  const dataDir = resolve(args.dataDir)
  const ledgerPath = resolve(args.ledgerPath)
  const lane = asRecord(await readJsonIfExists(lanePath))
  const walkForward = asRecord(await readJsonIfExists(walkForwardPath))
  const symbols = args.symbols.length > 0 ? args.symbols : readSymbolsFromLane(lane)
  const assets = await loadAssets(dataDir, symbols, args.maxRows, timeframeForBarMinutes(args.barMinutes))
  const existingLedger = readProspectiveObservationLedger(ledgerPath)
  const report = buildRankIcProspectiveObservationCaptureReport({
    lanePath,
    walkForwardPath,
    dataDir,
    ledgerPath,
    outputPath: args.outputPath ? resolve(args.outputPath) : null,
    lane,
    walkForward,
    assets,
    existingLedger,
    args,
    generatedAt: new Date().toISOString(),
  })

  if (!args.dryRun && report.status !== 'blocked' && report.status !== 'skipped_duplicate' && report.observation) {
    appendJsonlSync(ledgerPath, report.observation)
    report.appendResult = {
      appended: true,
      reason: 'appended',
      observationId: report.observation.observationId,
    }
    report.counts.appendedObservations = 1
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildRankIcProspectiveObservationCaptureReport(input: {
  lanePath: string
  walkForwardPath: string
  dataDir: string
  ledgerPath: string
  outputPath: string | null
  lane: Record<string, unknown> | null
  walkForward: Record<string, unknown> | null
  assets: AssetSeries[]
  existingLedger: RankIcProspectiveObservationEvent[]
  args: Pick<CliArgs, 'barMinutes' | 'maxRows' | 'maxVolPct' | 'minSpreadPct' | 'minUniverseSize' | 'executionMode' | 'dryRun'>
  generatedAt?: string
}): RankIcProspectiveObservationCaptureReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const candidate = asRecord(input.lane?.candidate)
  const protocol = asRecord(input.lane?.prospectiveProtocol)
  const config = extractConfig(candidate, input.args.barMinutes)
  const filter = extractFilter(input.walkForward, readString(candidate?.filterId))
  const existingIds = new Set(input.existingLedger.map(event => event.observationId))
  const blockers = buildBaseBlockers(input.lane, input.walkForward, candidate, protocol, config, filter, input.assets)
  const observation = blockers.length === 0 && candidate && config && filter
    ? buildObservation({
        lane: input.lane!,
        candidate,
        protocol,
        config,
        filter,
        assets: input.assets,
        dataDir: input.dataDir,
        args: input.args,
      })
    : null
  if (!observation && blockers.length === 0) blockers.push('prospective_observation_not_built')
  if (observation) blockers.push(...observation.blockers)
  const duplicate = observation ? existingIds.has(observation.observationId) : false
  const status: RankIcProspectiveObservationCaptureReport['status'] = blockers.some(isHardBlocker)
    ? 'blocked'
    : duplicate
      ? 'skipped_duplicate'
      : 'captured'
  const appendReason = status === 'blocked'
    ? 'blocked'
    : duplicate
      ? 'duplicate_observation_id'
      : input.args.dryRun
        ? 'dry_run'
        : 'appended'

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
      lanePath: resolve(input.lanePath),
      walkForwardPath: resolve(input.walkForwardPath),
      dataDir: resolve(input.dataDir),
      ledgerPath: resolve(input.ledgerPath),
      outputPath: input.outputPath ? resolve(input.outputPath) : null,
      barMinutes: input.args.barMinutes,
      maxRows: input.args.maxRows,
      executionMode: input.args.executionMode,
    },
    status,
    appendResult: {
      appended: false,
      reason: appendReason,
      observationId: observation?.observationId ?? null,
    },
    counts: {
      symbolsLoaded: input.assets.length,
      existingLedgerEvents: input.existingLedger.length,
      observationsBuilt: observation ? 1 : 0,
      signalPairsOpened: observation?.signalPair ? 1 : 0,
      appendedObservations: 0,
    },
    observation,
    blockers: uniqueStrings(blockers),
    notes: [
      'This capture is research-only prospective evidence collection; it does not place, propose, or authorize orders.',
      'The label is intentionally pending until the future close becomes available in the live-only data store.',
      'Duplicate observation ids are skipped so hourly cron can run idempotently on the same bar.',
    ],
  }
}

function buildObservation(input: {
  lane: Record<string, unknown>
  candidate: Record<string, unknown>
  protocol: Record<string, unknown> | null
  config: RankIcProspectiveConfig
  filter: ProspectiveFilter
  assets: AssetSeries[]
  dataDir: string
  args: Pick<CliArgs, 'barMinutes' | 'maxVolPct' | 'minSpreadPct' | 'minUniverseSize' | 'executionMode'>
}): RankIcProspectiveObservationEvent {
  const commonPeriods = Math.min(...input.assets.map(asset => asset.candles.length))
  const index = commonPeriods - 1
  const current = input.assets[0]?.candles[index]
  const labelDelayHours = readNumber(input.protocol?.labelDelayHours) ?? input.config.forwardHours
  const labelDueBarTime = (current?.time ?? 0) + labelDelayHours * 60 * 60 * 1_000
  const runtimeStatsBySymbol = buildRuntimeStatsBySymbol(input.assets, input.args.barMinutes)
  const assetsAtDecision = buildAssetsAtDecisionTime({
    assets: input.assets,
    index,
    runtimeStatsBySymbol,
    config: input.config,
  })
  const shape = resolveCrossSectionalExecutionShape(assetsAtDecision.length, {
    mode: input.args.executionMode,
    minUniverseSizeOverride: input.args.minUniverseSize,
  })
  const blockers: string[] = [
    'prospective_observation_not_execution_evidence',
    'paper_live_execution_disabled',
    'future_label_pending',
  ]
  if (assetsAtDecision.length < shape.minUniverseSize) {
    blockers.push(`assets_at_decision_low:${assetsAtDecision.length}<${shape.minUniverseSize}`)
  }
  const regime = buildRegimeObservation(index, current?.time, assetsAtDecision, input.config.lookbackHours)
  const filterAllowed = regime ? filterAllows(input.filter, regime) : false
  if (!regime) blockers.push('decision_regime_missing')
  if (!filterAllowed) blockers.push('decision_regime_filter_blocked')
  const ranks = assetsAtDecision.length >= shape.minUniverseSize
    ? evaluateCrossSectionalMomentum(assetsAtDecision, {
        lookbackHours: input.config.lookbackHours,
        secondaryLookbackHours: input.config.secondaryLookbackHours,
        topN: shape.topN,
        bottomN: shape.bottomN,
        minUniverseSize: shape.minUniverseSize,
        maxVolPercentile: input.args.maxVolPct / 100,
        minSpreadPct: input.args.minSpreadPct,
        requireVolumeConfirmation: assetsAtDecision.length >= 4,
        mtfWeight: input.config.mtfWeight,
        fundingWeight: 0,
      })
    : []
  const assetBySymbol = new Map(assetsAtDecision.map(asset => [asset.symbol, asset]))
  const rankSnapshot = ranks
    .map(rank => {
      const asset = assetBySymbol.get(rank.symbol)
      return {
        symbol: rank.symbol,
        signal: rank.signal,
        rank: rank.rank,
        confidence: round(rank.confidence, 10),
        currentPrice: asset?.currentPrice ?? 0,
        factorValue: asset ? round(factorValueFor(input.config.factor, asset, rank, assetsAtDecision.length), 10) : 0,
        reason: rank.reason,
      }
    })
    .sort((left, right) => left.rank - right.rank)
  const pair = filterAllowed ? selectSignalPair(rankSnapshot) : null
  if (filterAllowed && !pair) blockers.push('decision_signal_pair_missing')
  const laneId = readString(input.candidate.laneId) ?? 'rank_ic_prospective_lane'
  const candidateId = readString(input.candidate.candidateId) ?? 'rank_ic_prospective_candidate'
  const observationId = buildObservationId({
    laneId,
    candidateId,
    decisionBarTime: current?.time ?? 0,
    filter: input.filter,
  })
  const laneEvidence = asRecord(input.lane.currentEvidence)

  return {
    schemaVersion: 1,
    eventType: 'prospective_decision_open',
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId,
    laneId,
    candidateId,
    strategyFamily: readString(input.candidate.strategyFamily) ?? 'cross_sectional_rank_ic_walkforward_filter',
    filterId: input.filter.filterId,
    decisionTime: current ? new Date(current.time).toISOString() : '',
    decisionBarTime: current?.time ?? 0,
    labelDueTime: new Date(labelDueBarTime).toISOString(),
    labelDueBarTime,
    labelDelayHours,
    dataWatermark: current ? new Date(current.time).toISOString() : '',
    dataDir: resolve(input.dataDir),
    config: input.config,
    filter: {
      ...input.filter,
      allowed: filterAllowed,
    },
    regime,
    universe: {
      symbolsLoaded: input.assets.map(asset => asset.symbol),
      assetsAtDecision: assetsAtDecision.length,
      executionMode: input.args.executionMode,
      topN: shape.topN,
      bottomN: shape.bottomN,
      minUniverseSize: shape.minUniverseSize,
    },
    signalPair: pair,
    rankSnapshot,
    currentEvidence: {
      walkForwardWfoStatus: readString(laneEvidence?.walkForwardWfoStatus),
      walkForwardPassedWindows: readNumber(laneEvidence?.walkForwardPassedWindows),
      walkForwardWindowCount: readNumber(laneEvidence?.walkForwardWindowCount),
      walkForwardFailedWindowRatio: readNumber(laneEvidence?.walkForwardFailedWindowRatio),
      meanIc: readNumber(laneEvidence?.meanIc),
      icIr: readNumber(laneEvidence?.icIr),
      netAfterRouteCostPct: readNumber(laneEvidence?.netAfterRouteCostPct),
      feeSnapshotSource: readString(laneEvidence?.feeSnapshotSource),
      feeSnapshotVerifiedByRuntime: readBool(laneEvidence?.feeSnapshotVerifiedByRuntime),
    },
    blockers: uniqueStrings(blockers),
    notes: [
      'This is an open prospective decision observation, not a paper order and not a live order.',
      'Settlement must use only future rows that arrive after decisionTime.',
    ],
  }
}

function selectSignalPair(
  ranks: ProspectiveRankSnapshot[],
): RankIcProspectiveObservationEvent['signalPair'] {
  const long = ranks
    .filter(rank => rank.signal === 1)
    .sort((left, right) => right.confidence - left.confidence || left.rank - right.rank)[0]
  const short = ranks
    .filter(rank => rank.signal === -1)
    .sort((left, right) => right.confidence - left.confidence || right.rank - left.rank)[0]
  if (!long || !short || long.symbol === short.symbol) return null
  return {
    long: {
      symbol: long.symbol,
      side: 'long',
      currentPrice: long.currentPrice,
      rank: long.rank,
      confidence: long.confidence,
      factorValue: long.factorValue,
    },
    short: {
      symbol: short.symbol,
      side: 'short',
      currentPrice: short.currentPrice,
      rank: short.rank,
      confidence: short.confidence,
      factorValue: short.factorValue,
    },
    labelStatus: 'pending_future_close',
  }
}

function extractConfig(
  candidate: Record<string, unknown> | null,
  barMinutes: number,
): RankIcProspectiveConfig | null {
  if (!candidate) return null
  const lookbackHours = readNumber(candidate.lookbackHours)
  const secondaryLookbackHours = readNumber(candidate.secondaryLookbackHours)
  const forwardHours = readNumber(candidate.forwardHours)
  const mtfWeight = readNumber(candidate.mtfWeight)
  const factor = readFactorName(candidate.factor)
  if (
    lookbackHours == null ||
    secondaryLookbackHours == null ||
    forwardHours == null ||
    mtfWeight == null ||
    factor == null
  ) return null
  return {
    lookbackHours,
    secondaryLookbackHours,
    forwardHours,
    lookbackBars: hoursToBars(lookbackHours, barMinutes),
    secondaryLookbackBars: hoursToBars(secondaryLookbackHours, barMinutes),
    forwardBars: hoursToBars(forwardHours, barMinutes),
    mtfWeight,
    factor,
  }
}

function extractFilter(
  walkForward: Record<string, unknown> | null,
  expectedFilterId: string | null,
): ProspectiveFilter | null {
  const best = asRecord(walkForward?.bestWalkForwardCandidate)
  if (!best) return null
  const filterId = readString(best.filterId)
  if (!filterId || (expectedFilterId && filterId !== expectedFilterId)) return null
  const windows = Array.isArray(best.windows)
    ? best.windows.map(asRecord).filter(isRecordValue)
    : []
  const lastWindow = windows[windows.length - 1]
  const filter = asRecord(lastWindow?.filter)
  const thresholds = asRecord(filter?.thresholds)
  if (!thresholds) return null
  const parsedThresholds: ProspectiveFilter['thresholds'] = {}
  for (const key of [
    'minMedianReturnPct',
    'maxMedianReturnPct',
    'minBreadthPositivePct',
    'maxDispersionPct',
    'maxAverageVolPct',
  ] as const) {
    const value = readNumber(thresholds[key])
    if (value != null) parsedThresholds[key] = value
  }
  if (Object.keys(parsedThresholds).length === 0) return null
  return {
    filterId,
    description: readString(filter?.description),
    thresholds: parsedThresholds,
    thresholdSource: 'latest_walk_forward_validation_window',
  }
}

function buildBaseBlockers(
  lane: Record<string, unknown> | null,
  walkForward: Record<string, unknown> | null,
  candidate: Record<string, unknown> | null,
  protocol: Record<string, unknown> | null,
  config: RankIcProspectiveConfig | null,
  filter: ProspectiveFilter | null,
  assets: AssetSeries[],
): string[] {
  const blockers: string[] = []
  if (!lane) blockers.push('prospective_lane_missing_or_invalid')
  if (!walkForward) blockers.push('walk_forward_filter_report_missing_or_invalid')
  if (lane?.laneStatus !== 'ready_for_future_collection') {
    blockers.push(`prospective_lane_status:${readString(lane?.laneStatus) ?? 'missing'}`)
  }
  if (!candidate) blockers.push('prospective_lane_candidate_missing')
  if (!config) blockers.push('prospective_lane_config_missing')
  if (!filter) blockers.push('prospective_filter_threshold_missing')
  if (protocol && protocol.orderExecutionAllowed !== false) blockers.push('prospective_protocol_order_execution_not_disabled')
  if (assets.length < 2) blockers.push(`symbols_loaded_low:${assets.length}<2`)
  if (config && assets.length > 0) {
    const commonPeriods = Math.min(...assets.map(asset => asset.candles.length))
    const minRequired = Math.max(config.lookbackBars, config.secondaryLookbackBars) + 1
    if (commonPeriods < minRequired) blockers.push(`common_periods_low_for_decision:${commonPeriods}<${minRequired}`)
  }
  return uniqueStrings(blockers)
}

function isHardBlocker(blocker: string): boolean {
  return [
    'prospective_lane_missing_or_invalid',
    'walk_forward_filter_report_missing_or_invalid',
    'prospective_lane_candidate_missing',
    'prospective_lane_config_missing',
    'prospective_filter_threshold_missing',
    'prospective_protocol_order_execution_not_disabled',
  ].some(prefix => blocker === prefix || blocker.startsWith(`${prefix}:`)) ||
    blocker.startsWith('prospective_lane_status:') ||
    blocker.startsWith('symbols_loaded_low:') ||
    blocker.startsWith('common_periods_low_for_decision:') ||
    blocker.startsWith('assets_at_decision_low:')
}

function buildAssetsAtDecisionTime(input: {
  assets: AssetSeries[]
  index: number
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  config: RankIcProspectiveConfig
}): CrossSectionalAsset[] {
  const out: CrossSectionalAsset[] = []
  for (const asset of input.assets) {
    const current = asset.candles[input.index]
    const primary = asset.candles[input.index - input.config.lookbackBars]
    const secondary = asset.candles[input.index - input.config.secondaryLookbackBars]
    if (!current || !primary || !secondary) continue
    if (current.close <= 0 || primary.close <= 0 || secondary.close <= 0) continue
    const runtimeStats = input.runtimeStatsBySymbol.get(asset.symbol)?.[input.index]
    out.push({
      symbol: asset.symbol,
      currentPrice: current.close,
      returns: {
        [`${input.config.lookbackHours}h`]: (current.close / primary.close - 1) * 100,
        [`${input.config.secondaryLookbackHours}h`]: (current.close / secondary.close - 1) * 100,
      },
      realizedVolPct: runtimeStats?.realizedVolPct ?? 50,
      avgVolume24h: runtimeStats?.avgVolume24h ?? current.volume,
      dailyVolumeUsd: runtimeStats?.dailyVolumeUsd ?? current.close * current.volume,
    })
  }
  return out
}

function buildRegimeObservation(
  index: number,
  time: number | undefined,
  assetsAtDecision: CrossSectionalAsset[],
  lookbackHours: number,
): ProspectiveRegimeObservation | null {
  const returnKey = `${lookbackHours}h`
  const returns = assetsAtDecision.map(asset => asset.returns[returnKey]).filter(isFiniteNumber)
  const vols = assetsAtDecision.map(asset => asset.realizedVolPct).filter(isFiniteNumber)
  if (returns.length < 2 || vols.length === 0) return null
  return {
    index,
    time: typeof time === 'number' ? new Date(time).toISOString() : '',
    medianReturnPct: round(median(returns), 6),
    breadthPositivePct: round(returns.filter(value => value > 0).length / returns.length, 6),
    dispersionPct: round(standardDeviation(returns), 6),
    averageVolPct: round(mean(vols), 6),
  }
}

function filterAllows(filter: ProspectiveFilter, observation: ProspectiveRegimeObservation): boolean {
  const t = filter.thresholds
  if (t.minMedianReturnPct != null && observation.medianReturnPct < t.minMedianReturnPct) return false
  if (t.maxMedianReturnPct != null && observation.medianReturnPct > t.maxMedianReturnPct) return false
  if (t.minBreadthPositivePct != null && observation.breadthPositivePct < t.minBreadthPositivePct) return false
  if (t.maxDispersionPct != null && observation.dispersionPct > t.maxDispersionPct) return false
  if (t.maxAverageVolPct != null && observation.averageVolPct > t.maxAverageVolPct) return false
  return true
}

function factorValueFor(
  factor: FactorName,
  asset: CrossSectionalAsset,
  rank: ReturnType<typeof evaluateCrossSectionalMomentum>[number],
  universeSize: number,
): number {
  const firstReturnKey = Object.keys(asset.returns)[0]
  const rawReturn = asset.returns[firstReturnKey]
  if (factor === 'raw_reversal') return -rawReturn
  if (factor === 'risk_adjusted_reversal') return -rank.riskAdjustedScore
  if (factor === 'rank_reversal') return universeSize + 1 - rank.rank
  return rank.signal * rank.confidence
}

async function loadAssets(
  dataDir: string,
  symbols: string[],
  maxRows: number | null,
  timeframe: PaperUniverseTimeframe,
): Promise<AssetSeries[]> {
  const assets: AssetSeries[] = []
  for (const symbol of symbols.length > 0 ? symbols : defaultPaperUniverseSymbols()) {
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
    .sort((a, b) => a.time - b.time)
}

function alignByTailLength(assets: AssetSeries[]): AssetSeries[] {
  if (assets.length === 0) return []
  const minLength = Math.min(...assets.map(asset => asset.candles.length))
  return assets.map(asset => ({
    symbol: asset.symbol,
    candles: asset.candles.slice(asset.candles.length - minLength),
  }))
}

function buildRuntimeStatsBySymbol(assets: AssetSeries[], barMinutes: number): Map<string, AssetRuntimeStats[]> {
  const dailyBars = hoursToBars(24, barMinutes)
  return new Map(assets.map(asset => [asset.symbol, buildRuntimeStats(asset.candles, dailyBars, barMinutes)]))
}

function buildRuntimeStats(candles: Candle[], lookbackBars: number, barMinutes: number): AssetRuntimeStats[] {
  const volumePrefix = [0]
  const volumeCountPrefix = [0]
  const volumeUsdPrefix = [0]
  const returnPrefix = [0]
  const returnSqPrefix = [0]

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    const validVolume = Number.isFinite(candle.volume) && candle.volume > 0
    const validVolumeUsd = validVolume && Number.isFinite(candle.close) && candle.close > 0
    volumePrefix.push(volumePrefix[index] + (validVolume ? candle.volume : 0))
    volumeCountPrefix.push(volumeCountPrefix[index] + (validVolume ? 1 : 0))
    volumeUsdPrefix.push(volumeUsdPrefix[index] + (validVolumeUsd ? candle.close * candle.volume : 0))

    const previous = candles[index - 1]
    const ret = previous && previous.close > 0 && candle.close > 0
      ? candle.close / previous.close - 1
      : 0
    returnPrefix.push(returnPrefix[index] + ret)
    returnSqPrefix.push(returnSqPrefix[index] + ret ** 2)
  }

  return candles.map((candle, index) => {
    const volumeStart = Math.max(0, index - lookbackBars + 1)
    const volumeEnd = index + 1
    const volumeSum = volumePrefix[volumeEnd] - volumePrefix[volumeStart]
    const volumeCount = volumeCountPrefix[volumeEnd] - volumeCountPrefix[volumeStart]
    const volumeUsd = volumeUsdPrefix[volumeEnd] - volumeUsdPrefix[volumeStart]
    const returnStart = Math.max(1, index - lookbackBars + 1)
    const returnEnd = index + 1
    const returnCount = Math.max(0, returnEnd - returnStart)
    const returnSum = returnPrefix[returnEnd] - returnPrefix[returnStart]
    const returnSqSum = returnSqPrefix[returnEnd] - returnSqPrefix[returnStart]
    const returnMean = returnCount > 0 ? returnSum / returnCount : 0
    const variance = returnCount > 1
      ? Math.max(0, returnSqSum / returnCount - returnMean ** 2)
      : null
    return {
      realizedVolPct: variance == null ? 50 : Math.sqrt(variance * 365 * 24 * 60 / barMinutes) * 100,
      avgVolume24h: volumeCount > 0 ? volumeSum / volumeCount : candle.volume,
      dailyVolumeUsd: volumeUsd,
    }
  })
}

function readProspectiveObservationLedger(path: string): RankIcProspectiveObservationEvent[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        const parsed = asRecord(JSON.parse(line))
        return parsed?.eventType === 'prospective_decision_open'
          ? [parsed as unknown as RankIcProspectiveObservationEvent]
          : []
      } catch {
        return []
      }
    })
}

function readSymbolsFromLane(lane: Record<string, unknown> | null): string[] {
  const symbols = readStringArray(lane?.symbolsLoaded)
  return symbols.length > 0 ? symbols : defaultPaperUniverseSymbols()
}

async function readJsonIfExists(path: string): Promise<unknown> {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf-8'))
}

function buildObservationId(input: {
  laneId: string
  candidateId: string
  decisionBarTime: number
  filter: ProspectiveFilter
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      laneId: input.laneId,
      candidateId: input.candidateId,
      decisionBarTime: input.decisionBarTime,
      filterId: input.filter.filterId,
      thresholds: input.filter.thresholds,
    }))
    .digest('hex')
    .slice(0, 24)
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

function renderConsoleSummary(report: RankIcProspectiveObservationCaptureReport): string {
  return [
    `rank ic prospective observation capture: status=${report.status}, dryRun=${report.dryRun}, appended=${report.appendResult.appended}`,
    `observation=${report.observation?.observationId ?? 'none'}, decision=${report.observation?.decisionTime ?? 'none'}, due=${report.observation?.labelDueTime ?? 'none'}`,
    `filterAllowed=${report.observation?.filter.allowed ?? 'n/a'}, signalPair=${report.observation?.signalPair ? `${report.observation.signalPair.long.symbol}/${report.observation.signalPair.short.symbol}` : 'none'}`,
    `paper=false, live=false, promotion=false`,
    `blockers=${report.blockers.slice(0, 12).join('|') || 'none'}`,
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

function parseSymbols(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map(value => value.trim()).filter(Boolean)
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return !normalized || normalized === 'null' || normalized === 'false' || normalized === 'none'
    ? null
    : raw
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

function parseNullablePositiveInteger(raw: string | undefined, fallback: number | null, name: string): number | null {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'null' || normalized === 'none' || normalized === 'false') return null
  return parsePositiveInteger(raw, fallback ?? 1, name)
}

function parseFiniteNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be finite.`)
  return parsed
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isRecordValue(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value != null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim() !== '')
    : []
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readFactorName(value: unknown): FactorName | null {
  return value === 'raw_reversal' ||
    value === 'risk_adjusted_reversal' ||
    value === 'rank_reversal' ||
    value === 'signal_confidence'
    ? value
    : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function standardDeviation(values: number[]): number {
  if (values.length <= 1) return 0
  const avg = mean(values)
  return Math.sqrt(mean(values.map(value => (value - avg) ** 2)))
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
    console.error('capture_rank_ic_prospective_observation failed:', error)
    process.exit(1)
  })
}
