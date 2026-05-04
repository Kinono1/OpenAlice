import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OhlcvData } from '../src/domain/analysis/indicator/types.js'
import type { StrategyConfig } from '../src/core/config.js'
import { evaluateRuntimeFactorSnapshot } from '../src/domain/strategy/runtime-evaluator.js'
import type { IcMonitorSnapshot } from '../src/domain/strategy/factors/index.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  buildPaperUniverseAsset,
  type PaperUniverseTimeframe,
} from './lib/paper_universe.js'

const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_OUTPUT_PATH = 'data/runtime/ic_monitor_snapshot.latest.json'
const DEFAULT_SYMBOLS = 'BTC,ETH,SOL'
const DEFAULT_TIMEFRAME: PaperUniverseTimeframe = '1h'

export interface PublishIcMonitorSnapshotArgs {
  dataDir: string
  symbols: string[]
  timeframe: PaperUniverseTimeframe
  outputPath: string | null
  maxBars: number
  minWarmupBars: number
  json: boolean
}

export interface IcMonitorSnapshotPublishReport {
  schemaVersion: 1
  generatedAt: string
  outputPath: string | null
  dataDir: string
  symbols: string[]
  timeframe: PaperUniverseTimeframe
  maxBars: number
  minWarmupBars: number
  status: 'ok' | 'insufficient_data' | 'missing_data' | 'invalid_symbol_scope'
  samplesWritten: number
  returnCount: number
  factorSignalCount: number
  factorCount: number
  earliestSignalTs: string | null
  latestSignalTs: string | null
  symbolDiagnostics: Array<{
    symbol: string
    filePath: string
    status: 'ok' | 'missing' | 'insufficient_rows' | 'error'
    rowsLoaded: number
    samplesWritten: number
    error: string | null
  }>
  snapshot: IcMonitorSnapshot
  notes: string[]
}

export function parsePublishIcMonitorSnapshotArgs(argv: string[]): PublishIcMonitorSnapshotArgs {
  const raw = parseRawArgs(argv)
  return {
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    symbols: parseSymbols(raw.get('symbols') ?? DEFAULT_SYMBOLS),
    timeframe: parseTimeframe(raw.get('timeframe') ?? DEFAULT_TIMEFRAME),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxBars: parsePositiveInt(raw.get('maxBars'), 240),
    minWarmupBars: parsePositiveInt(raw.get('minWarmupBars'), 48),
    json: parseBool(raw.get('json'), false),
  }
}

export async function publishIcMonitorSnapshot(
  args: PublishIcMonitorSnapshotArgs,
): Promise<IcMonitorSnapshotPublishReport> {
  const startedAt = new Date()
  const dataDir = resolve(args.dataDir)
  const snapshot: IcMonitorSnapshot = {
    version: 0,
    signals: [],
    returns: [],
  }
  const symbolDiagnostics: IcMonitorSnapshotPublishReport['symbolDiagnostics'] = []

  for (const symbol of args.symbols) {
    const asset = buildPaperUniverseAsset(symbol, args.timeframe)
    const filePath = resolve(join(dataDir, asset.file))
    if (!existsSync(filePath)) {
      symbolDiagnostics.push({
        symbol: asset.paperSymbol,
        filePath,
        status: 'missing',
        rowsLoaded: 0,
        samplesWritten: 0,
        error: null,
      })
      continue
    }
    try {
      const candles = await loadOhlcv(filePath)
      if (candles.length < args.minWarmupBars) {
        symbolDiagnostics.push({
          symbol: asset.paperSymbol,
          filePath,
          status: 'insufficient_rows',
          rowsLoaded: candles.length,
          samplesWritten: 0,
          error: null,
        })
        continue
      }
      const selected = candles.slice(-args.maxBars)
      const beforeSignals = snapshot.signals.length
      let rollingSnapshot: IcMonitorSnapshot | undefined = snapshot
      for (let end = args.minWarmupBars; end <= selected.length; end++) {
        const window = selected.slice(0, end)
        const nowUtcMs = Date.parse(window[window.length - 1].date)
        const evaluated = evaluateRuntimeFactorSnapshot({
          symbol: asset.paperSymbol,
          candles: window,
          strategyConfig: icReplayStrategyConfig(),
          sourceTier: 'L2',
          useType: 'U1',
          sentiment: 'S0',
          nowUtcMs,
          icMonitorSnapshot: rollingSnapshot,
        })
        rollingSnapshot = evaluated.icMonitorSnapshot
      }
      snapshot.version = rollingSnapshot?.version ?? snapshot.version
      snapshot.signals = rollingSnapshot?.signals ?? snapshot.signals
      snapshot.returns = rollingSnapshot?.returns ?? snapshot.returns
      symbolDiagnostics.push({
        symbol: asset.paperSymbol,
        filePath,
        status: 'ok',
        rowsLoaded: candles.length,
        samplesWritten: snapshot.signals.length - beforeSignals,
        error: null,
      })
    } catch (err: unknown) {
      symbolDiagnostics.push({
        symbol: asset.paperSymbol,
        filePath,
        status: 'error',
        rowsLoaded: 0,
        samplesWritten: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const signalTimestamps = snapshot.signals.map(signal => signal.timestamp).filter(Number.isFinite)
  const report: IcMonitorSnapshotPublishReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    outputPath: args.outputPath ? resolve(args.outputPath) : null,
    dataDir,
    symbols: [...args.symbols],
    timeframe: args.timeframe,
    maxBars: args.maxBars,
    minWarmupBars: args.minWarmupBars,
    status: snapshot.signals.length > 0
      ? 'ok'
      : symbolDiagnostics.some(item => item.status === 'missing')
        ? 'missing_data'
        : 'insufficient_data',
    samplesWritten: snapshot.signals.length,
    returnCount: snapshot.returns.length,
    factorSignalCount: snapshot.signals.length,
    factorCount: new Set(snapshot.signals.map(signal => signal.factor)).size,
    earliestSignalTs: signalTimestamps.length > 0 ? new Date(Math.min(...signalTimestamps)).toISOString() : null,
    latestSignalTs: signalTimestamps.length > 0 ? new Date(Math.max(...signalTimestamps)).toISOString() : null,
    symbolDiagnostics,
    snapshot,
    notes: [
      'This publisher replays local OHLCV into the symbol-aware runtime FactorIcMonitor in shadow mode.',
      'The resulting snapshot is diagnostic only; IC status still controls promotion eligibility separately.',
      'No orders are submitted and no portfolio target is generated by this script.',
    ],
  }

  await maybeWriteSnapshotReport(args.outputPath, report, startedAt)

  return report
}

async function maybeWriteSnapshotReport(
  outputPathInput: string | null,
  report: IcMonitorSnapshotPublishReport,
  startedAt: Date,
): Promise<void> {
  if (!outputPathInput) return
  const outputPath = resolve(outputPathInput)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report.snapshot, null, 2)}\n`, 'utf-8')
  await writeEvidenceManifestForArtifact({
    job: 'ic_monitor_snapshot',
    artifactPath: outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: 0,
    businessStatus: report.status === 'ok' ? 'pass' : 'warn',
    recordsIn: report.symbolDiagnostics.reduce((sum, item) => sum + item.rowsLoaded, 0),
    recordsOut: report.samplesWritten,
    errorClass: report.status === 'ok' ? null : report.status,
  })
}

async function loadOhlcv(path: string): Promise<OhlcvData[]> {
  const raw = await readFile(path, 'utf-8')
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length < 2) return []
  const header = lines[0].split(',')
  const idx = {
    timestamp: header.indexOf('timestamp'),
    datetime: header.indexOf('datetime'),
    open: header.indexOf('open'),
    high: header.indexOf('high'),
    low: header.indexOf('low'),
    close: header.indexOf('close'),
    volume: header.indexOf('volume'),
  }
  for (const [key, value] of Object.entries(idx)) {
    if (value < 0 && key !== 'datetime') throw new Error(`CSV missing required column ${key}: ${path}`)
  }
  return lines.slice(1).flatMap(row => {
    const cols = row.split(',')
    const timestamp = Number(cols[idx.timestamp])
    const date = idx.datetime >= 0 ? cols[idx.datetime] : new Date(timestamp).toISOString()
    const open = Number(cols[idx.open])
    const high = Number(cols[idx.high])
    const low = Number(cols[idx.low])
    const close = Number(cols[idx.close])
    const volume = Number(cols[idx.volume])
    if (![timestamp, open, high, low, close, volume].every(Number.isFinite)) return []
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return []
    return [{ date, open, high, low, close, volume }]
  })
}

function icReplayStrategyConfig(): StrategyConfig {
  return {
    enabled: true,
    governance: {
      useGovernanceGate: true,
      staleDataCapsExecution: true,
      preferReduceOnWeakSignal: false,
    },
    runtime: {
      marketScope: 'crypto',
      runtimeIntegrationEnabled: false,
    },
    eventCalendar: {
      enabled: true,
      events: [],
    },
    factors: {
      fundingRate: { enabled: false, weight: 0 },
      basis: { enabled: false, weight: 0 },
      volumeSurge: { enabled: true, weight: 1 },
      momentumComposite: { enabled: true, weight: 1 },
      meanReversion: { enabled: true, weight: 1 },
      volatilityRegime: { enabled: true, weight: 1 },
      liquidationPressure: { enabled: false, weight: 0 },
      crossTimeframeDivergence: { enabled: true, weight: 1 },
    },
    positionSizing: {
      enabled: true,
      method: 'fixed',
      defaultAssetLayer: 'core',
      targetVolPct: 10,
      maxPctOfEquity: 0.3,
      kellyFraction: 0.15,
      layerConfigs: [
        {
          layer: 'core',
          maxPositions: 5,
          maxPositionPctOfEquity: 0.3,
          minActionStatusToTrade: 'probe',
          requiresCoreNotRiskOff: false,
        },
        {
          layer: 'extended',
          maxPositions: 3,
          maxPositionPctOfEquity: 0.15,
          minActionStatusToTrade: 'attack-lite',
          requiresCoreNotRiskOff: true,
        },
        {
          layer: 'watch-only',
          maxPositions: 1,
          maxPositionPctOfEquity: 0.05,
          minActionStatusToTrade: 'attack',
          requiresCoreNotRiskOff: true,
        },
      ],
    },
    metaLabeling: {
      enabled: false,
      upperBarrierPct: 2,
      lowerBarrierPct: 1,
      maxHoldingBars: 24,
      minConfidenceToTrade: 0.55,
    },
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i++
  }
  return out
}

function parseSymbols(value: string): string[] {
  return value.split(',').map(item => item.trim().toUpperCase()).filter(Boolean)
}

function parseTimeframe(value: string): PaperUniverseTimeframe {
  if (value === '1h' || value === '5m' || value === '1s') return value
  return DEFAULT_TIMEFRAME
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

export function renderIcMonitorSnapshotPublishMarkdown(report: IcMonitorSnapshotPublishReport): string {
  const lines: string[] = []
  lines.push('# IC Monitor Snapshot Publish')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Status: \`${report.status}\``)
  lines.push(`Samples written: ${report.samplesWritten}`)
  lines.push(`Returns: ${report.returnCount}`)
  lines.push(`Factors: ${report.factorCount}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parsePublishIcMonitorSnapshotArgs(argv)
  const report = await publishIcMonitorSnapshot(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderIcMonitorSnapshotPublishMarkdown(report))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
