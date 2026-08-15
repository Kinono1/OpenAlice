import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { appendJsonlSync } from '../src/runtime/runtime_events.js'
import { paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'
import type { EthCarryPitFeatureRow } from './build_eth_carry_pit_feature_dataset.js'

type UnknownRecord = Record<string, unknown>

interface CliArgs {
  featurePath: string
  dataDir: string
  ledgerPath: string
  outputPath: string | null
  barMinutes: number
  labelDelayHours: number
  maxRows: number | null
  maxObservationsPerRun?: number
  asOfMs: number | null
  allowHistoricalDue: boolean
  dryRun: boolean
  json: boolean
}

interface Candle {
  time: number
  close: number
}

export interface EthCarryProspectiveObservationEvent {
  schemaVersion: 1
  eventType: 'eth_carry_prospective_decision_open'
  researchOnly: true
  prospectiveOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  observationId: string
  candidateId: 'eth_btc_pit_basis_funding_carry'
  strategyFamily: 'funding_carry_rebuild'
  decisionTime: string
  decisionBarTime: number
  labelDueTime: string
  labelDueBarTime: number
  labelDelayHours: number
  dataWatermark: string
  dataDir: string
  sourceFeature: {
    featureId: string
    decisionAvailableAt: string
    decisionAvailableAtMs: number
    availabilityLagMs: number
    pairSkewMs: number
  }
  pitFeatures: {
    fundingSpread: number | null
    basisSpreadDiffPct: number
    ethFundingRate: number | null
    btcFundingRate: number | null
    ethBasisSpreadPct: number
    btcBasisSpreadPct: number
    ethNextFundingTime: string | null
    btcNextFundingTime: string | null
  }
  signal: {
    direction: 'short_eth_long_btc' | 'long_eth_short_btc'
    basis: 'funding_spread_primary_then_basis_spread'
    labelStatus: 'pending_future_close'
    long: {
      symbol: 'ETH-USDT' | 'BTC-USDT'
      entryPrice: number
    }
    short: {
      symbol: 'ETH-USDT' | 'BTC-USDT'
      entryPrice: number
    }
  } | null
  blockers: string[]
  notes: string[]
}

export interface EthCarryProspectiveObservationCaptureReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  prospectiveOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  dryRun: boolean
  inputs: {
    featurePath: string
    dataDir: string
    ledgerPath: string
    outputPath: string | null
    barMinutes: number
    labelDelayHours: number
    maxRows: number | null
    maxObservationsPerRun: number
    asOfMs: number | null
    allowHistoricalDue: boolean
  }
  status: 'captured' | 'skipped_duplicate' | 'blocked'
  appendResult: {
    appended: boolean
    reason: 'dry_run' | 'duplicate_observation_id' | 'blocked' | 'appended'
    observationId: string | null
  }
  appendResults: Array<{
    appended: boolean
    reason: 'dry_run' | 'duplicate_observation_id' | 'blocked' | 'appended'
    observationId: string | null
  }>
  counts: {
    featureRowsLoaded: number
    existingLedgerEvents: number
    observationsBuilt: number
    appendedObservations: number
    duplicateObservations: number
    skippedAlreadyDueObservations: number
  }
  observation: EthCarryProspectiveObservationEvent | null
  observations: EthCarryProspectiveObservationEvent[]
  blockers: string[]
  notes: string[]
}

const DEFAULT_FEATURE_PATH = 'data/research/eth_carry_pit_features.latest.json'
const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_LEDGER_PATH = 'data/research/eth_carry_prospective_observations.jsonl'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_prospective_observation_capture.latest.json'

async function main(): Promise<void> {
  const args = parseEthCarryProspectiveObservationCaptureArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runEthCarryProspectiveObservationCapture(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_prospective_observation_capture',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked' ? 'fail' : 'warn',
      recordsIn: report.counts.featureRowsLoaded,
      recordsOut: report.counts.appendedObservations,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseEthCarryProspectiveObservationCaptureArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    featurePath: raw.get('featurePath') ?? raw.get('features') ?? DEFAULT_FEATURE_PATH,
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    barMinutes: parsePositiveInteger(raw.get('barMinutes'), 60, 'barMinutes'),
    labelDelayHours: parsePositiveInteger(raw.get('labelDelayHours'), 8, 'labelDelayHours'),
    maxRows: parseNullablePositiveInteger(raw.get('maxRows'), null, 'maxRows'),
    maxObservationsPerRun: parsePositiveInteger(raw.get('maxObservationsPerRun'), 1, 'maxObservationsPerRun'),
    asOfMs: parseNullableTimestamp(raw.get('asOf')),
    allowHistoricalDue: parseBool(raw.get('allowHistoricalDue'), false),
    dryRun: parseBool(raw.get('dryRun'), true),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryProspectiveObservationCapture(
  args: CliArgs,
): Promise<EthCarryProspectiveObservationCaptureReport> {
  const featurePath = resolve(args.featurePath)
  const dataDir = resolve(args.dataDir)
  const ledgerPath = resolve(args.ledgerPath)
  const featureRows = readCarryFeatureRows(featurePath)
  const existingEvents = readOpenEvents(ledgerPath)
  const report = await buildEthCarryProspectiveObservationCaptureReport({
    featurePath,
    dataDir,
    ledgerPath,
    outputPath: args.outputPath ? resolve(args.outputPath) : null,
    featureRows,
    existingEvents,
    args,
    generatedAt: new Date().toISOString(),
  })

  if (!args.dryRun && report.status === 'captured') {
    let appendedObservations = 0
    report.appendResults = report.appendResults.map((result, index) => {
      const observation = report.observations[index]
      if (!observation || result.reason !== 'appended') return result
      appendJsonlSync(ledgerPath, observation)
      appendedObservations += 1
      return { ...result, appended: true }
    })
    report.counts.appendedObservations = appendedObservations
    report.appendResult = report.appendResults.find(result => result.appended) ?? report.appendResult
    if (report.appendResult.appended) {
      report.appendResult = { ...report.appendResult, appended: true }
    }
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export async function buildEthCarryProspectiveObservationCaptureReport(input: {
  featurePath: string
  dataDir: string
  ledgerPath: string
  outputPath: string | null
  featureRows: EthCarryPitFeatureRow[]
  existingEvents: EthCarryProspectiveObservationEvent[]
  args: Pick<CliArgs, 'barMinutes' | 'labelDelayHours' | 'maxRows' | 'maxObservationsPerRun' | 'asOfMs' | 'allowHistoricalDue' | 'dryRun'>
  generatedAt?: string
}): Promise<EthCarryProspectiveObservationCaptureReport> {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const asOfMs = input.args.asOfMs ?? Date.now()
  const maxObservationsPerRun = input.args.maxObservationsPerRun ?? 1
  const blockers: string[] = []
  if (!existsSync(input.featurePath)) blockers.push('eth_carry_pit_feature_dataset_missing')
  const featureRows = input.featureRows
    .filter(row => row.strategyFamily === 'funding_carry_rebuild')
    .filter(row => row.blockers.length === 0)
    .sort((left, right) => right.decisionAvailableAtMs - left.decisionAvailableAtMs)
  if (featureRows.length === 0) blockers.push('usable_eth_carry_pit_feature_rows_missing')

  const ethCandles = await loadCandles(input.dataDir, 'ETH-USDT', input.args.barMinutes, input.args.maxRows)
  const btcCandles = await loadCandles(input.dataDir, 'BTC-USDT', input.args.barMinutes, input.args.maxRows)
  if (ethCandles.length === 0) blockers.push('decision_candles_missing:ETH-USDT')
  if (btcCandles.length === 0) blockers.push('decision_candles_missing:BTC-USDT')

  const existingIds = new Set(input.existingEvents.map(event => event.observationId))
  const observations: EthCarryProspectiveObservationEvent[] = []
  let duplicateObservations = 0
  let skippedAlreadyDueObservations = 0
  for (const feature of featureRows) {
    if (observations.length >= maxObservationsPerRun) break
    const candidate = buildObservationFromFeature({
      feature,
      dataDir: input.dataDir,
      ethCandles,
      btcCandles,
      barMinutes: input.args.barMinutes,
      labelDelayHours: input.args.labelDelayHours,
    })
    if (!candidate) continue
    if (!input.args.allowHistoricalDue && candidate.labelDueBarTime <= asOfMs) {
      skippedAlreadyDueObservations += 1
      continue
    }
    if (existingIds.has(candidate.observationId)) {
      duplicateObservations += 1
      continue
    }
    observations.push(candidate)
  }
  if (observations.length === 0 && blockers.length === 0 && duplicateObservations > 0) {
    const latest = featureRows[0]
    const duplicateObservationId = latest
      ? buildObservationId(latest.featureId, resolveDecisionBarTime(latest.decisionAvailableAtMs, ethCandles, btcCandles))
      : null
    return buildCaptureReport({
      generatedAt,
      input,
      status: 'skipped_duplicate',
      observations: [],
      blockers: [],
      duplicateObservations,
      skippedAlreadyDueObservations,
      appendResult: {
        appended: false,
        reason: 'duplicate_observation_id',
        observationId: duplicateObservationId,
      },
    })
  }
  if (observations.length === 0 && blockers.length === 0) blockers.push('eth_carry_prospective_observation_not_built')
  const status: EthCarryProspectiveObservationCaptureReport['status'] =
    blockers.length > 0 ? 'blocked' : 'captured'
  const appendResults = observations.map(observation => ({
    appended: false,
    reason: input.args.dryRun ? 'dry_run' as const : 'appended' as const,
    observationId: observation.observationId,
  }))
  const primaryAppendResult = appendResults[0] ?? {
    appended: false,
    reason: status === 'blocked' ? 'blocked' as const : input.args.dryRun ? 'dry_run' as const : 'appended' as const,
    observationId: observations[0]?.observationId ?? null,
  }

  return buildCaptureReport({
    generatedAt,
    input,
    status,
    observations,
    blockers,
    duplicateObservations,
    skippedAlreadyDueObservations,
    appendResults,
    appendResult: primaryAppendResult,
  })
}

function buildCaptureReport(input: {
  generatedAt: string
  input: {
    featurePath: string
    dataDir: string
    ledgerPath: string
    outputPath: string | null
    featureRows: EthCarryPitFeatureRow[]
    existingEvents: EthCarryProspectiveObservationEvent[]
    args: Pick<CliArgs, 'barMinutes' | 'labelDelayHours' | 'maxRows' | 'maxObservationsPerRun' | 'asOfMs' | 'allowHistoricalDue' | 'dryRun'>
  }
  status: EthCarryProspectiveObservationCaptureReport['status']
  observations: EthCarryProspectiveObservationEvent[]
  blockers: string[]
  duplicateObservations?: number
  skippedAlreadyDueObservations?: number
  appendResult: EthCarryProspectiveObservationCaptureReport['appendResult']
  appendResults?: EthCarryProspectiveObservationCaptureReport['appendResults']
}): EthCarryProspectiveObservationCaptureReport {
  const observation = input.observations[0] ?? null
  const appendResults = input.appendResults ?? []
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    dryRun: input.input.args.dryRun,
    inputs: {
      featurePath: input.input.featurePath,
      dataDir: input.input.dataDir,
      ledgerPath: input.input.ledgerPath,
      outputPath: input.input.outputPath,
      barMinutes: input.input.args.barMinutes,
      labelDelayHours: input.input.args.labelDelayHours,
      maxRows: input.input.args.maxRows,
      maxObservationsPerRun: input.input.args.maxObservationsPerRun ?? 1,
      asOfMs: input.input.args.asOfMs,
      allowHistoricalDue: input.input.args.allowHistoricalDue,
    },
    status: input.status,
    appendResult: input.appendResult,
    appendResults,
    counts: {
      featureRowsLoaded: input.input.featureRows.length,
      existingLedgerEvents: input.input.existingEvents.length,
      observationsBuilt: input.observations.length,
      appendedObservations: appendResults.filter(result => result.appended).length,
      duplicateObservations: input.duplicateObservations ?? appendResults.filter(result => result.reason === 'duplicate_observation_id').length,
      skippedAlreadyDueObservations: input.skippedAlreadyDueObservations ?? 0,
    },
    observation,
    observations: input.observations,
    blockers: uniqueStrings(input.blockers),
    notes: [
      'This capture is research-only prospective evidence for funding/carry PIT features.',
      'The decision bar is strictly after feature decisionAvailableAt to avoid same-bar or future leakage.',
      'Batch capture only records future-label observations; normal capture still skips already-due labels unless allowHistoricalDue=true.',
      'This is not a paper order and not a live order.',
    ],
  }
}

function buildObservationFromFeature(input: {
  feature: EthCarryPitFeatureRow
  dataDir: string
  ethCandles: Candle[]
  btcCandles: Candle[]
  barMinutes: number
  labelDelayHours: number
}): EthCarryProspectiveObservationEvent | null {
  const decisionBarTime = resolveDecisionBarTime(
    input.feature.decisionAvailableAtMs,
    input.ethCandles,
    input.btcCandles,
  )
  if (decisionBarTime == null || decisionBarTime <= input.feature.decisionAvailableAtMs) return null
  const ethEntry = findCandle(input.ethCandles, decisionBarTime)
  const btcEntry = findCandle(input.btcCandles, decisionBarTime)
  if (!ethEntry || !btcEntry) return null
  const labelDueBarTime = decisionBarTime + input.labelDelayHours * 3_600_000
  const direction = resolveCarryDirection(input.feature)
  const long = direction === 'short_eth_long_btc'
    ? { symbol: 'BTC-USDT' as const, entryPrice: btcEntry.close }
    : { symbol: 'ETH-USDT' as const, entryPrice: ethEntry.close }
  const short = direction === 'short_eth_long_btc'
    ? { symbol: 'ETH-USDT' as const, entryPrice: ethEntry.close }
    : { symbol: 'BTC-USDT' as const, entryPrice: btcEntry.close }
  const observationId = buildObservationId(input.feature.featureId, decisionBarTime)
  const blockers = uniqueStrings([
    ...(decisionBarTime > input.feature.decisionAvailableAtMs ? [] : ['decision_time_not_after_feature_available_at']),
    ...(input.feature.requiredFields.explicitAvailableAt ? [] : ['explicit_available_at_missing']),
    ...(input.feature.requiredFields.fundingRateCashflow ? [] : ['funding_rate_cashflow_missing']),
    ...(input.feature.requiredFields.basisSpread ? [] : ['basis_spread_missing']),
    'research_only_not_execution_evidence',
    'paper_live_execution_disabled',
  ])
  return {
    schemaVersion: 1,
    eventType: 'eth_carry_prospective_decision_open',
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId,
    candidateId: 'eth_btc_pit_basis_funding_carry',
    strategyFamily: 'funding_carry_rebuild',
    decisionTime: new Date(decisionBarTime).toISOString(),
    decisionBarTime,
    labelDueTime: new Date(labelDueBarTime).toISOString(),
    labelDueBarTime,
    labelDelayHours: input.labelDelayHours,
    dataWatermark: new Date(Math.min(input.ethCandles.at(-1)?.time ?? 0, input.btcCandles.at(-1)?.time ?? 0)).toISOString(),
    dataDir: resolve(input.dataDir),
    sourceFeature: {
      featureId: input.feature.featureId,
      decisionAvailableAt: input.feature.decisionAvailableAt,
      decisionAvailableAtMs: input.feature.decisionAvailableAtMs,
      availabilityLagMs: decisionBarTime - input.feature.decisionAvailableAtMs,
      pairSkewMs: input.feature.pairSkewMs,
    },
    pitFeatures: {
      fundingSpread: input.feature.fundingSpread,
      basisSpreadDiffPct: input.feature.basisSpreadDiffPct,
      ethFundingRate: input.feature.ethFundingRate,
      btcFundingRate: input.feature.btcFundingRate,
      ethBasisSpreadPct: input.feature.ethBasisSpreadPct,
      btcBasisSpreadPct: input.feature.btcBasisSpreadPct,
      ethNextFundingTime: input.feature.ethNextFundingTime,
      btcNextFundingTime: input.feature.btcNextFundingTime,
    },
    signal: {
      direction,
      basis: 'funding_spread_primary_then_basis_spread',
      labelStatus: 'pending_future_close',
      long,
      short,
    },
    blockers,
    notes: [
      'Open prospective observation only; closed outcomes must be settled after labelDueTime.',
      'Feature timestamps are point-in-time bounded by decisionAvailableAt.',
    ],
  }
}

function resolveCarryDirection(feature: EthCarryPitFeatureRow): 'short_eth_long_btc' | 'long_eth_short_btc' {
  if (feature.fundingSpread != null && feature.fundingSpread !== 0) {
    return feature.fundingSpread > 0 ? 'short_eth_long_btc' : 'long_eth_short_btc'
  }
  return feature.basisSpreadDiffPct > 0 ? 'short_eth_long_btc' : 'long_eth_short_btc'
}

function resolveDecisionBarTime(
  availableAtMs: number,
  ethCandles: Candle[],
  btcCandles: Candle[],
): number | null {
  const ethTime = ethCandles.find(candle => candle.time > availableAtMs)?.time
  const btcTime = btcCandles.find(candle => candle.time > availableAtMs)?.time
  if (ethTime == null || btcTime == null) return null
  return Math.max(ethTime, btcTime)
}

async function loadCandles(
  dataDir: string,
  symbol: 'ETH-USDT' | 'BTC-USDT',
  barMinutes: number,
  maxRows: number | null,
): Promise<Candle[]> {
  const timeframe = `${barMinutes === 60 ? '1h' : `${barMinutes}m`}` as PaperUniverseTimeframe
  const path = join(dataDir, paperSymbolToCsvFile(symbol, timeframe))
  if (!existsSync(path)) return []
  const rows = readFileSync(path, 'utf-8')
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseCandleCsvLine)
    .filter((item): item is Candle => item != null)
    .sort((left, right) => left.time - right.time)
  return maxRows != null ? rows.slice(-maxRows) : rows
}

function parseCandleCsvLine(line: string): Candle | null {
  const [timestamp, , , , , close] = line.split(',')
  const time = Number(timestamp)
  const closeNumber = Number(close)
  if (!Number.isFinite(time) || !Number.isFinite(closeNumber)) return null
  return { time, close: closeNumber }
}

function findCandle(candles: Candle[], time: number): Candle | null {
  return candles.find(candle => candle.time === time) ?? null
}

function readCarryFeatureRows(path: string): EthCarryPitFeatureRow[] {
  const resolvedPath = resolve(path)
  if (!existsSync(resolvedPath)) return []
  const parsed = asRecord(JSON.parse(readFileSync(resolvedPath, 'utf-8')))
  const rows = Array.isArray(parsed?.carryFeatureRows) ? parsed.carryFeatureRows : []
  return rows
    .map(asCarryFeatureRow)
    .filter((row): row is EthCarryPitFeatureRow => row != null)
}

function asCarryFeatureRow(value: unknown): EthCarryPitFeatureRow | null {
  const row = asRecord(value)
  if (!row) return null
  const featureId = readString(row.featureId)
  const decisionAvailableAt = readString(row.decisionAvailableAt)
  const decisionAvailableAtMs = readNumber(row.decisionAvailableAtMs)
  const sourceFeatures = asRecord(row.sourceFeatures)
  const requiredFields = asRecord(row.requiredFields)
  if (!featureId || !decisionAvailableAt || decisionAvailableAtMs == null || !sourceFeatures || !requiredFields) return null
  return {
    featureId,
    exchange: readString(row.exchange) ?? 'binance',
    market: readString(row.market) ?? 'usdm',
    strategyFamily: 'funding_carry_rebuild',
    symbols: {
      leader: 'ETHUSDT',
      hedge: 'BTCUSDT',
    },
    decisionAvailableAt,
    decisionAvailableAtMs,
    pairSkewMs: readNumber(row.pairSkewMs) ?? 0,
    fundingSpread: readNumber(row.fundingSpread),
    basisSpreadDiffPct: readNumber(row.basisSpreadDiffPct) ?? 0,
    ethFundingRate: readNumber(row.ethFundingRate),
    btcFundingRate: readNumber(row.btcFundingRate),
    ethBasisSpreadPct: readNumber(row.ethBasisSpreadPct) ?? 0,
    btcBasisSpreadPct: readNumber(row.btcBasisSpreadPct) ?? 0,
    ethNextFundingTime: readString(row.ethNextFundingTime),
    btcNextFundingTime: readString(row.btcNextFundingTime),
    requiredFields: {
      fundingRateCashflow: readBoolean(requiredFields.fundingRateCashflow) === true,
      basisSpread: readBoolean(requiredFields.basisSpread) === true,
      explicitAvailableAt: readBoolean(requiredFields.explicitAvailableAt) === true,
    },
    sourceFeatures: {
      ethBasisFeatureId: readString(sourceFeatures.ethBasisFeatureId) ?? '',
      btcBasisFeatureId: readString(sourceFeatures.btcBasisFeatureId) ?? '',
    },
    blockers: readStringArray(row.blockers),
  }
}

function readOpenEvents(path: string): EthCarryProspectiveObservationEvent[] {
  const resolvedPath = resolve(path)
  if (!existsSync(resolvedPath)) return []
  return readFileSync(resolvedPath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as EthCarryProspectiveObservationEvent
      } catch {
        return null
      }
    })
    .filter((event): event is EthCarryProspectiveObservationEvent =>
      event?.eventType === 'eth_carry_prospective_decision_open')
}

function renderConsoleSummary(report: EthCarryProspectiveObservationCaptureReport): string {
  return [
    `eth carry prospective capture: status=${report.status}, dryRun=${report.dryRun}`,
    `features=${report.counts.featureRowsLoaded}, built=${report.counts.observationsBuilt}, appended=${report.counts.appendedObservations}`,
    report.observation ? `observationId=${report.observation.observationId}` : 'observationId=null',
    report.blockers.length > 0 ? `blockers=${report.blockers.join(',')}` : 'blockers=[]',
  ].join('\n')
}

function buildObservationId(featureId: string, decisionBarTime: number | null): string {
  return hashId(['eth_carry_prospective_observation', featureId, String(decisionBarTime ?? 'missing')])
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      parsed.set(key, next)
      index += 1
    } else {
      parsed.set(key, 'true')
    }
  }
  return parsed
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  if (value === 'null' || value === 'none' || value === '') return null
  return value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  if (['1', 'true', 'yes'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no'].includes(value.toLowerCase())) return false
  return fallback
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function parseNullablePositiveInteger(value: string | undefined, fallback: number | null, label: string): number | null {
  if (value == null || value === 'null') return fallback
  return parsePositiveInteger(value, fallback ?? 1, label)
}

function parseNullableTimestamp(value: string | undefined): number | null {
  if (value == null || value === 'null') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid timestamp: ${value}`)
  return parsed
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function hashId(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('capture_eth_carry_prospective_observation failed:', error)
    process.exitCode = 1
  })
}
