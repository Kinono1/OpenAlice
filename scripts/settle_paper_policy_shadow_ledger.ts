import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireRuntimeLock, type RuntimeLock } from '../src/runtime/runtime_lock.js'
import {
  appendPaperPolicyShadowOutcome,
  buildPaperPolicyShadowOutcome,
  DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
  readOpenPaperPolicyShadows,
  type PaperPolicyShadowCloseReason,
  type PaperPolicyShadowOutcome,
  type ParsedPaperPolicyShadowOpen,
} from '../src/runtime/paper_policy_shadow_ledger.js'
import {
  buildEvidenceManifest,
  readGitEvidenceSnapshot,
  type EvidenceManifest,
} from '../src/runtime/evidence_manifest.js'
import {
  paperSymbolToCsvFile,
  type PaperUniverseTimeframe,
} from './lib/paper_universe.js'

const DEFAULT_OUTPUT_PATH = 'data/runtime/paper_policy_shadow_settle.latest.json'
const DEFAULT_LOCK_DIR = 'data/runtime/locks/paper_policy_shadow_settle.script.lock'

export interface MarketCandle {
  timestamp: number
  datetime: string
  open: number
  high: number
  low: number
  close: number
}

export interface PaperPolicyShadowSettleArgs {
  ledgerPath: string
  dataDir: string
  timeframe: PaperUniverseTimeframe
  lane: string | null
  symbol: string | null
  asOfMs: number | null
  dryRun: boolean
  maxOutcomes: number | null
  outputPath: string | null
  lockDir: string | null
  json: boolean
}

export interface PaperPolicyShadowSettleReport {
  schemaVersion: 1
  generatedAt: string
  counterfactualType: 'trade_level_shadow'
  dryRun: boolean
  inputs: {
    ledgerPath: string
    dataDir: string
    timeframe: PaperUniverseTimeframe
    lane: string | null
    symbol: string | null
    asOfMs: number | null
    maxOutcomes: number | null
    outputPath: string | null
  }
  counts: {
    openShadowsLoaded: number
    shadowsConsidered: number
    dueOutcomes: number
    appendedOutcomes: number
    appendSkipped: number
    notDue: number
    missingCandleFiles: number
    candleRowsLoaded: number
    invalidCandleRows: number
    skippedByMaxOutcomes: number
  }
  missingSymbols: string[]
  outcomes: PaperPolicyShadowOutcome[]
  appendResults: Array<{
    shadowId: string
    appended: boolean
    reason?: string
  }>
  evidenceManifest: EvidenceManifest | null
  notes: string[]
}

interface CandleLoadResult {
  candles: MarketCandle[]
  missing: boolean
  invalidRows: number
}

async function writePaperPolicyShadowSettleReport(input: {
  report: PaperPolicyShadowSettleReport
  startedAt: Date
}): Promise<PaperPolicyShadowSettleReport> {
  const { report, startedAt } = input
  if (report.inputs.outputPath) {
    await mkdir(dirname(report.inputs.outputPath), { recursive: true })
    const finishedAt = new Date()
    const gitSnapshot = readGitEvidenceSnapshot()
    const manifestInput = {
      job: 'paper_policy_shadow_settle',
      artifactPath: report.inputs.outputPath,
      startedAt,
      finishedAt,
      exitCode: 0,
      businessStatus: report.counts.dueOutcomes > 0 ? 'pass' : 'warn',
      recordsIn: report.counts.openShadowsLoaded,
      recordsOut: report.counts.appendedOutcomes,
      gitSnapshot,
    } as const
    report.evidenceManifest = buildEvidenceManifest({
      ...manifestInput,
      artifactHash: null,
    })
    report.evidenceManifest.artifactHash = null
    await writeFile(report.inputs.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    const manifest = buildEvidenceManifest(manifestInput)
    await writeFile(manifest.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  }
  return report
}

function buildLockedPaperPolicyShadowSettleReport(
  args: PaperPolicyShadowSettleArgs,
  ledgerPath: string,
  dataDir: string,
  lockDir: string,
): PaperPolicyShadowSettleReport {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    counterfactualType: 'trade_level_shadow',
    dryRun: args.dryRun,
    inputs: {
      ledgerPath,
      dataDir,
      timeframe: args.timeframe,
      lane: args.lane,
      symbol: args.symbol,
      asOfMs: args.asOfMs,
      maxOutcomes: args.maxOutcomes,
      outputPath: args.outputPath ? resolve(args.outputPath) : null,
      lockDir,
    },
    counts: {
      openShadowsLoaded: 0,
      shadowsConsidered: 0,
      dueOutcomes: 0,
      appendedOutcomes: 0,
      appendSkipped: 0,
      notDue: 0,
      missingCandleFiles: 0,
      candleRowsLoaded: 0,
      invalidCandleRows: 0,
      skippedByMaxOutcomes: 0,
    },
    missingSymbols: [],
    outcomes: [],
    appendResults: [],
    evidenceManifest: null,
    notes: [
      'paper_policy_shadow_settle skipped because internal runtime lock is already held.',
      'No shadow outcomes were evaluated or appended in this run.',
    ],
  }
}

export function parsePaperPolicyShadowSettleArgs(argv: string[]): PaperPolicyShadowSettleArgs {
  const raw = parseRawArgs(argv)
  const timeframe = parseTimeframe(raw.get('timeframe') ?? '5m')
  return {
    ledgerPath: raw.get('ledgerPath') ?? DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
    dataDir: raw.get('dataDir') ?? defaultDataDir(timeframe),
    timeframe,
    lane: parseNullableString(raw.get('lane')),
    symbol: parseNullableString(raw.get('symbol')),
    asOfMs: parseNullableTimestamp(raw.get('asOf')),
    dryRun: parseBool(raw.get('dryRun'), true),
    maxOutcomes: parseNullablePositiveInteger(raw.get('maxOutcomes')),
    outputPath: parseNullableString(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    lockDir: parseNullableString(raw.get('lockDir') ?? DEFAULT_LOCK_DIR),
    json: parseBool(raw.get('json'), false),
  }
}

export async function settlePaperPolicyShadowLedger(
  args: PaperPolicyShadowSettleArgs,
): Promise<PaperPolicyShadowSettleReport> {
  const startedAt = new Date()
  const ledgerPath = resolve(args.ledgerPath)
  const dataDir = resolve(args.dataDir)
  const lockDir = args.lockDir ? resolve(args.lockDir) : null
  let settleLock: RuntimeLock | null = null
  if (!args.dryRun && lockDir) {
    settleLock = acquireRuntimeLock(lockDir, {
      purpose: 'paper_policy_shadow_settle',
    })
    if (!settleLock) {
      return writePaperPolicyShadowSettleReport({
        report: buildLockedPaperPolicyShadowSettleReport(args, ledgerPath, dataDir, lockDir),
        startedAt,
      })
    }
  }

  try {
  const openShadows = readOpenPaperPolicyShadows(ledgerPath)
  const filteredShadows = openShadows.filter((shadow) =>
    (args.lane === null || shadow.lane === args.lane) &&
    (args.symbol === null || shadow.symbol === args.symbol)
  )
  const candlesBySymbol = new Map<string, CandleLoadResult>()
  const outcomes: PaperPolicyShadowOutcome[] = []
  const appendResults: PaperPolicyShadowSettleReport['appendResults'] = []
  const missingSymbols = new Set<string>()
  let notDue = 0
  let missingCandleFiles = 0
  let candleRowsLoaded = 0
  let invalidCandleRows = 0
  let skippedByMaxOutcomes = 0

  for (const shadow of filteredShadows) {
    let candleLoad = candlesBySymbol.get(shadow.symbol)
    if (!candleLoad) {
      candleLoad = loadCandlesForSymbol(dataDir, shadow.symbol, args.timeframe)
      candlesBySymbol.set(shadow.symbol, candleLoad)
      candleRowsLoaded += candleLoad.candles.length
      invalidCandleRows += candleLoad.invalidRows
      if (candleLoad.missing) {
        missingCandleFiles += 1
        missingSymbols.add(shadow.symbol)
      }
    }
    if (candleLoad.missing || candleLoad.candles.length === 0) {
      notDue += 1
      continue
    }

    const outcome = findDueShadowOutcomeFromCandles(shadow, candleLoad.candles, args.asOfMs)
    if (!outcome) {
      notDue += 1
      continue
    }

    if (args.maxOutcomes !== null && outcomes.length >= args.maxOutcomes) {
      skippedByMaxOutcomes += 1
      continue
    }

    outcomes.push(outcome)
    if (!args.dryRun) {
      const appendResult = appendPaperPolicyShadowOutcome(outcome, ledgerPath)
      appendResults.push(appendResult)
    }
  }

  const report: PaperPolicyShadowSettleReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    counterfactualType: 'trade_level_shadow',
    dryRun: args.dryRun,
    inputs: {
      ledgerPath,
      dataDir,
      timeframe: args.timeframe,
      lane: args.lane,
      symbol: args.symbol,
      asOfMs: args.asOfMs,
      maxOutcomes: args.maxOutcomes,
      outputPath: args.outputPath ? resolve(args.outputPath) : null,
      lockDir,
    },
    counts: {
      openShadowsLoaded: openShadows.length,
      shadowsConsidered: filteredShadows.length,
      dueOutcomes: outcomes.length,
      appendedOutcomes: appendResults.filter(result => result.appended).length,
      appendSkipped: appendResults.filter(result => !result.appended).length,
      notDue,
      missingCandleFiles,
      candleRowsLoaded,
      invalidCandleRows,
      skippedByMaxOutcomes,
    },
    missingSymbols: [...missingSymbols].sort(),
    outcomes,
    appendResults,
    evidenceManifest: null,
    notes: [
      'This settles blocked trade-level shadow signals only; it does not compute portfolio counterfactual PnL.',
      'Stop-loss outcomes use OHLC detection and close at the recorded stopLossPrice.',
      'Horizon outcomes use the first eligible candle at or after openBarTime + horizonMs, not the latest available price.',
      'dryRun defaults to true; pass --dryRun false to append closed outcomes to the ledger.',
      'non-dry-run settle uses an internal runtime lock so manual runs and cron runs share the same overlap guard.',
    ],
  }

  return writePaperPolicyShadowSettleReport({ report, startedAt })
  } finally {
    settleLock?.release()
  }
}

export function findDueShadowOutcomeFromCandles(
  shadow: ParsedPaperPolicyShadowOpen,
  candles: MarketCandle[],
  asOfMs: number | null,
): PaperPolicyShadowOutcome | null {
  const horizonAt = shadow.openBarTime + shadow.horizonMs
  for (const candle of candles) {
    if (candle.timestamp <= shadow.openBarTime) continue
    if (asOfMs !== null && candle.timestamp > asOfMs) break

    const stopReason = getStopCloseReason(shadow, candle)
    if (stopReason) {
      return buildPaperPolicyShadowOutcome(
        shadow,
        {
          symbol: shadow.symbol,
          price: shadow.stopLossPrice ?? candle.close,
          barTime: candle.timestamp,
          ts: candle.datetime,
        },
        stopReason,
      )
    }

    if (candle.timestamp >= horizonAt) {
      return buildPaperPolicyShadowOutcome(
        shadow,
        {
          symbol: shadow.symbol,
          price: candle.close,
          barTime: candle.timestamp,
          ts: candle.datetime,
        },
        'shadow_horizon_expired',
      )
    }
  }
  return null
}

export function parseMarketCandleCsv(raw: string): { candles: MarketCandle[]; invalidRows: number } {
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) return { candles: [], invalidRows: 0 }
  const header = lines[0].split(',').map(item => item.trim())
  const timestampIndex = header.indexOf('timestamp')
  const datetimeIndex = header.indexOf('datetime')
  const openIndex = header.indexOf('open')
  const highIndex = header.indexOf('high')
  const lowIndex = header.indexOf('low')
  const closeIndex = header.indexOf('close')
  if ([timestampIndex, datetimeIndex, openIndex, highIndex, lowIndex, closeIndex].some(index => index < 0)) {
    throw new Error('CSV must include timestamp, datetime, open, high, low, close headers')
  }

  const candles: MarketCandle[] = []
  let invalidRows = 0
  for (const line of lines.slice(1)) {
    const columns = line.split(',').map(item => item.trim())
    const timestamp = parseTimestampColumn(columns[timestampIndex], columns[datetimeIndex])
    const open = Number(columns[openIndex])
    const high = Number(columns[highIndex])
    const low = Number(columns[lowIndex])
    const close = Number(columns[closeIndex])
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0
    ) {
      invalidRows += 1
      continue
    }
    candles.push({
      timestamp,
      datetime: columns[datetimeIndex] || new Date(timestamp).toISOString(),
      open,
      high,
      low,
      close,
    })
  }

  candles.sort((a, b) => a.timestamp - b.timestamp)
  return { candles, invalidRows }
}

function loadCandlesForSymbol(
  dataDir: string,
  symbol: string,
  timeframe: PaperUniverseTimeframe,
): CandleLoadResult {
  const path = join(dataDir, paperSymbolToCsvFile(symbol, timeframe))
  if (!existsSync(path)) return { candles: [], missing: true, invalidRows: 0 }
  const parsed = parseMarketCandleCsv(readFileSync(path, 'utf-8'))
  return { ...parsed, missing: false }
}

function getStopCloseReason(
  shadow: ParsedPaperPolicyShadowOpen,
  candle: MarketCandle,
): PaperPolicyShadowCloseReason | null {
  if (shadow.stopLossPrice === null) return null
  if (shadow.side === 'long' && candle.low <= shadow.stopLossPrice) return 'shadow_stop_loss'
  if (shadow.side === 'short' && candle.high >= shadow.stopLossPrice) return 'shadow_stop_loss'
  return null
}

function defaultDataDir(timeframe: PaperUniverseTimeframe): string {
  if (timeframe === '1s') return 'data/market/live_1s'
  if (timeframe === '5m') return 'data/market/live_5m'
  return 'data/market/live_accumulated'
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const withoutPrefix = arg.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out.set(withoutPrefix, next)
      i += 1
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseTimeframe(value: string): PaperUniverseTimeframe {
  if (value === '1s' || value === '5m' || value === '1h') return value
  throw new Error(`Unsupported timeframe: ${value}`)
}

function parseNullableString(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' || trimmed.toLowerCase() === 'null' ? null : trimmed
}

function parseNullableTimestamp(value: string | undefined): number | null {
  const trimmed = parseNullableString(value)
  if (trimmed === null) return null
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(trimmed)
  if (Number.isFinite(parsed)) return parsed
  throw new Error(`Invalid timestamp: ${value}`)
}

function parseNullablePositiveInteger(value: string | undefined): number | null {
  const trimmed = parseNullableString(value)
  if (trimmed === null) return null
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${value}`)
  }
  return parsed
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function parseTimestampColumn(timestampValue: string, datetimeValue: string): number {
  const timestamp = Number(timestampValue)
  if (Number.isFinite(timestamp)) return timestamp
  const parsed = Date.parse(datetimeValue)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parsePaperPolicyShadowSettleArgs(argv)
  const report = await settlePaperPolicyShadowLedger(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(JSON.stringify({
    generatedAt: report.generatedAt,
    dryRun: report.dryRun,
    counts: report.counts,
    outputPath: report.inputs.outputPath,
  }, null, 2))
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
