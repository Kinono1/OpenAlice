#!/usr/bin/env tsx
/**
 * Build signal health status from sidecar signal intake.
 *
 * Reads the latest sidecar file, evaluates each signal's health status,
 * computes direction accuracy where market data allows, and writes the
 * result to data/runtime/signal_health.latest.json.
 *
 * The v5 plan requires:
 *   "Drift monitor ???? 模型标签周期，???? TTL ???收益窗口。默认? horizon=6? 1h bar? target_start_delay_bars=1"
 *
 * Flow:
 *   1. Read data/runtime/sidecar_signal_intake.latest.json
 *   2. Detect format: v5 envelope (schema_version=1, source=cryptotrade) vs bare array
 *   3. For each signal, evaluate health based on target_end_at vs now
 *   4. Try to settle past signals by comparing predicted direction vs actual price movement
 *   5. Aggregate results and write output
 *
 * Usage:
 *   npx tsx scripts/build_signal_health_status.ts
 *   npx tsx scripts/build_signal_health_status.ts --dry-run
 *   npx tsx scripts/build_signal_health_status.ts --dry-run --json
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  cryptoDlSidecarEnvelopeV1Schema,
  signalHealthV1Schema,
  computeCurrentSlotId,
} from '../src/runtime/sidecar_signal.js'
import { writeJsonAtomic } from '../src/runtime/atomic_write.js'
import type { CryptoDlSignalV1, SignalHealthV1 } from '../src/runtime/sidecar_signal.js'

// ── Types ─────────────────────────────────────────────────────────────

interface OldFormatSignal {
  signal_id: string
  symbol: string
  direction: string
  position_pct: number
  confidence: number
  thesis: string
  [key: string]: unknown
}

interface ByStatusCounts {
  pending: number
  warmup: number
  healthy: number
  decayed: number
  blocked: number
}

interface SignalHealthOutput {
  generated_at: string
  total_signals: number
  by_status: ByStatusCounts
  signals: SignalHealthV1[]
  summary: {
    avg_direction_accuracy: number | null
    avg_rank_ic: number | null
    total_settled: number
  }
}

interface CandleRow {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// ── Constants ─────────────────────────────────────────────────────────

const SIDECAR_PATH = 'data/runtime/sidecar_signal_intake.latest.json'
const OUTPUT_PATH = 'data/runtime/signal_health.latest.json'
const MARKET_DATA_DIR = 'data/market/live_accumulated'

/** Default label horizon in bars when not available in the signal (v5 plan default). */
const DEFAULT_HORIZON_BARS = 6

/** Default bar interval in ms (1 hour). */
const DEFAULT_BAR_INTERVAL_MS = 3_600_000

/** Default target start delay in bars. */
const DEFAULT_START_DELAY_BARS = 1

// ── Helpers ───────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString()
}

/**
 * Attempt to extract a UTC timestamp from a signal_id of the form
 * `crypto_dl_20260511_110751_ec12446f` (YYYYMMDD_HHMMSS suffix).
 */
function extractTimestampFromSignalId(signalId: string): number | null {
  const match = signalId.match(
    /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/,
  )
  if (!match) return null
  const [, year, month, day, hour, min, sec] = match
  return Date.UTC(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(min, 10),
    Number.parseInt(sec, 10),
  )
}

/**
 * Convert a trading pair symbol like `XRP/USDT` to a market-data file
 * prefix like `XRP_USDT_USDT`.
 */
function symbolToMarketFilePrefix(symbol: string): string {
  return symbol.replace(/\//g, '_') + '_USDT'
}

/**
 * Parse CSV text into candle rows.
 */
function parseCSV(text: string): CandleRow[] {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []
  const header = lines[0]
  const columns = header.split(',')
  const idx = {
    timestamp: columns.indexOf('timestamp'),
    open: columns.indexOf('open'),
    high: columns.indexOf('high'),
    low: columns.indexOf('low'),
    close: columns.indexOf('close'),
    volume: columns.indexOf('volume'),
  }

  const rows: CandleRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',')
    const row: CandleRow = {
      timestamp: Number(vals[idx.timestamp]),
      open: Number(vals[idx.open]),
      high: Number(vals[idx.high]),
      low: Number(vals[idx.low]),
      close: Number(vals[idx.close]),
      volume: Number(vals[idx.volume]),
    }
    if (Number.isFinite(row.timestamp) && Number.isFinite(row.close) && row.close > 0) {
      rows.push(row)
    }
  }
  return rows
}

/**
 * Find the best-matching market data CSV file for a given symbol.
 * Prefers the 1h timeframe file.  Falls back to any CSV matching
 * the symbol prefix.
 */
function findMarketDataFile(symbol: string): string | null {
  if (!existsSync(MARKET_DATA_DIR)) return null

  const prefix = symbolToMarketFilePrefix(symbol)
  let files: string[]
  try {
    files = readdirSync(MARKET_DATA_DIR)
  } catch {
    return null
  }

  // Prefer the canonical 1h file.
  const h1File = files.find(
    f => f.startsWith(prefix) && f.includes('_1h.'),
  )
  if (h1File) return join(MARKET_DATA_DIR, h1File)

  // Any CSV for this symbol.
  const anyFile = files.find(f => f.startsWith(prefix) && f.endsWith('.csv'))
  return anyFile ? join(MARKET_DATA_DIR, anyFile) : null
}

/**
 * Find the candle row whose timestamp is closest to `targetMs`, within a
 * tolerance of 2 bar intervals.  Returns null if no row is close enough.
 */
function findClosestBar(
  rows: CandleRow[],
  targetMs: number,
  toleranceMs: number,
): CandleRow | null {
  if (rows.length === 0) return null

  let best = rows[0]
  let bestDiff = Math.abs(best.timestamp - targetMs)
  for (let i = 1; i < rows.length; i++) {
    const diff = Math.abs(rows[i].timestamp - targetMs)
    if (diff < bestDiff) {
      best = rows[i]
      bestDiff = diff
    }
  }

  return bestDiff <= toleranceMs ? best : null
}

// ── Direction-Accuracy Computation ────────────────────────────────────

interface DirectionResult {
  direction_correct: boolean
  actual_return: number
}

/**
 * Compute direction accuracy for a settled signal by reading the
 * symbol's accumulated OHLCV file and comparing the predicted
 * direction (sign of target_position_bps) vs the actual return
 * from the bar nearest target_end_at to the latest close.
 */
function computeDirectionAccuracy(
  signal: CryptoDlSignalV1,
  marketFile: string,
): DirectionResult | null {
  try {
    const text = readFileSync(marketFile, 'utf-8')
    const rows = parseCSV(text)
    if (rows.length < 2) return null

    // Sort ascending by timestamp.
    rows.sort((a, b) => a.timestamp - b.timestamp)

    const targetEndMs = new Date(signal.target_end_at).getTime()
    const predictedDirection = Math.sign(signal.target_position_bps)
    const toleranceMs = signal.bar_interval_ms * 2

    // Find bar nearest target_end_at (entry bar).
    const entryBar = findClosestBar(rows, targetEndMs, toleranceMs)
    if (!entryBar) return null

    // Latest bar for current reference price.
    const latestBar = rows[rows.length - 1]

    const actualReturn = (latestBar.close - entryBar.close) / entryBar.close
    const actualDirection = Math.sign(actualReturn)

    // Flat prediction is trivially correct (no bet to lose).
    if (predictedDirection === 0) {
      return { direction_correct: true, actual_return: actualReturn }
    }

    return {
      direction_correct: predictedDirection === actualDirection,
      actual_return: actualReturn,
    }
  } catch {
    return null
  }
}

// ── Signal Health Evaluation ──────────────────────────────────────────

/**
 * Build the common fields shared across all health-status variants.
 *
 * CryptoDlSignalV1 does not carry signal_id, so one is synthesised
 * from model_id + as_of + symbol when absent.
 */
function buildCommonFields(
  signal: CryptoDlSignalV1,
): Pick<
  SignalHealthV1,
  | 'model_id'
  | 'signal_id'
  | 'target_end_at'
  | 'as_of'
  | 'label_horizon_bars'
  | 'bar_interval_ms'
> {
  // signal_id may be missing in pure v5 envelope; synthesise one.
  const anySignal = signal as Record<string, unknown>
  const signalId =
    typeof anySignal.signal_id === 'string' && anySignal.signal_id.length > 0
      ? (anySignal.signal_id as string)
      : synthesiseSignalId(signal)

  return {
    model_id: signal.model_id,
    signal_id: signalId,
    target_end_at: signal.target_end_at,
    as_of: signal.as_of,
    label_horizon_bars: signal.label_horizon_bars,
    bar_interval_ms: signal.bar_interval_ms,
  }
}

/**
 * Deterministically generate a signal_id for v5 signals that lack one.
 */
function synthesiseSignalId(signal: CryptoDlSignalV1): string {
  const asOf = signal.as_of
    .replace(/[:-]/g, '')
    .replace(/\.\d+Z/, '')
    .replace(/Z$/, '')
  const sym = signal.symbol.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
  const suffix = hashSimple(`${signal.model_id}|${signal.symbol}|${signal.as_of}`)
  return `${signal.model_id}_${asOf}_${sym}_${suffix}`
}

/** Simple string hash returning a hex suffix (first 8 chars). */
function hashSimple(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8)
}

/**
 * Attempt to settle a signal whose target_end_at has passed.
 *
 * Looks up market data for the symbol, computes direction accuracy
 * against actual price movement, and returns health status fields.
 * Returns null when market data is unavailable.
 */
function trySettleSignal(
  signal: CryptoDlSignalV1,
): Pick<SignalHealthV1, 'status' | 'direction_accuracy' | 'signal_decay'> | null {
  const marketFile = findMarketDataFile(signal.symbol)
  if (!marketFile) return null

  const result = computeDirectionAccuracy(signal, marketFile)
  if (!result) return null

  const status: 'healthy' | 'decayed' = result.direction_correct
    ? 'healthy'
    : 'decayed'

  return {
    status,
    direction_accuracy: result.direction_correct ? 1 : 0,
    signal_decay: result.direction_correct ? 0 : 1,
  }
}

/**
 * Evaluate the health status of a single v5 signal.
 *
 * Logic:
 *   - target_end_at is still in the future  ->  pending
 *   - past end, within 2x bar window         ->  try settle; fallback warmup
 *   - past end, beyond 2x bar window         ->  try settle; fallback blocked
 */
function evaluateSignalHealth(
  signal: CryptoDlSignalV1,
  now: Date,
): SignalHealthV1 {
  const common = buildCommonFields(signal)
  const targetEnd = new Date(signal.target_end_at)
  const barWindowMs = signal.label_horizon_bars * signal.bar_interval_ms

  // Rank IC is inferred from target_position_bps (predicted return).
  const rankIc = signal.target_position_bps / 10000

  if (targetEnd > now) {
    return { ...common, status: 'pending', rank_ic: rankIc }
  }

  const timeSinceEnd = now.getTime() - targetEnd.getTime()

  if (timeSinceEnd > barWindowMs * 2) {
    // Well past the target window; data should exist.
    const settled = trySettleSignal(signal)
    if (settled) return { ...common, rank_ic: rankIc, ...settled }
    return {
      ...common,
      status: 'blocked',
      blocked_reason: 'settlement_data_missing',
      rank_ic: rankIc,
    }
  }

  // Within the settlement window — may still be accumulating data.
  const settled = trySettleSignal(signal)
  if (settled) return { ...common, rank_ic: rankIc, ...settled }

  return { ...common, status: 'warmup', rank_ic: rankIc }
}

// ── Old-Format (Bare Array) Conversion ────────────────────────────────

/**
 * Convert an old-format bare-array signal into a v5 CryptoDlSignalV1
 * by inferring timestamps from the signal_id and using v5 plan defaults
 * for horizon / bar interval / start delay.
 */
function oldFormatToV5(
  signal: OldFormatSignal,
): CryptoDlSignalV1 {
  const timestamp =
    extractTimestampFromSignalId(signal.signal_id) ?? Date.now()
  const asOf = new Date(timestamp).toISOString()

  const startDelayMs = DEFAULT_START_DELAY_BARS * DEFAULT_BAR_INTERVAL_MS
  const horizonMs = DEFAULT_HORIZON_BARS * DEFAULT_BAR_INTERVAL_MS

  const targetStartAt = new Date(timestamp + startDelayMs)
  const targetEndAt = new Date(timestamp + startDelayMs + horizonMs)

  return {
    source: 'cryptotrade',
    strategy_id: 'crypto_dl',
    symbol: signal.symbol,
    as_of: asOf,
    target_position_bps: Math.round(signal.position_pct * 10000),
    confidence_bps: Math.round(signal.confidence * 10000),
    model_id: signal.signal_id.split('_').slice(0, 2).join('_') || 'crypto_dl',
    thesis: signal.thesis,
    label_horizon_bars: DEFAULT_HORIZON_BARS,
    bar_interval_ms: DEFAULT_BAR_INTERVAL_MS,
    target_start_delay_bars: DEFAULT_START_DELAY_BARS,
    target_start_at: targetStartAt.toISOString(),
    target_end_at: targetEndAt.toISOString(),
  }
}

// ── Input Detection ───────────────────────────────────────────────────

type LoadedSignals = {
  signals: CryptoDlSignalV1[]
  slotId?: string
}

/**
 * Try to parse the input as a v5 envelope.  Returns the signals
 * array and optional slot_id on success, or null if the input
 * does not match the v5 envelope schema.
 */
function tryParseV5Envelope(input: unknown): LoadedSignals | null {
  const result = cryptoDlSidecarEnvelopeV1Schema.safeParse(input)
  if (!result.success) return null
  return {
    signals: result.data.signals,
    slotId: result.data.slot_id,
  }
}

/**
 * Try to parse the input as a bare old-format array.
 */
function tryParseBareArray(input: unknown): CryptoDlSignalV1[] | null {
  if (!Array.isArray(input)) return null
  if (input.length === 0) return null

  // Quick structural check: bare-array items use direction/position_pct.
  const first = input[0] as Record<string, unknown>
  if (
    typeof first?.signal_id !== 'string' ||
    typeof first?.symbol !== 'string'
  ) {
    return null
  }

  return input.map(item => oldFormatToV5(item as OldFormatSignal))
}

// ── Output Formatting ─────────────────────────────────────────────────

function formatHumanReadable(output: SignalHealthOutput): string {
  const lines: string[] = [
    'Signal Health Report',
    `Generated at: ${output.generated_at}`,
    `Total signals: ${output.total_signals}`,
    '',
    'By Status:',
    `  pending:  ${output.by_status.pending}`,
    `  warmup:   ${output.by_status.warmup}`,
    `  healthy:  ${output.by_status.healthy}`,
    `  decayed:  ${output.by_status.decayed}`,
    `  blocked:  ${output.by_status.blocked}`,
    '',
    'Summary:',
    `  avg_direction_accuracy: ${output.summary.avg_direction_accuracy?.toFixed(4) ?? 'N/A'}`,
    `  avg_rank_ic:             ${output.summary.avg_rank_ic?.toFixed(6) ?? 'N/A'}`,
    `  total_settled:           ${output.summary.total_settled}`,
  ]

  if (output.signals.length > 0) {
    lines.push('', 'Signals:')
    for (const s of output.signals) {
      const endTs = s.target_end_at.replace('T', ' ').slice(0, 19)
      lines.push(
        `  [${s.status.padEnd(8)}] ${s.model_id} / ${s.signal_id.slice(-8)}  end=${endTs}`,
      )
    }
  }

  return lines.join('\n')
}

// ── Main ──────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const jsonOutput = args.includes('--json')

  const now = new Date()

  // 1. Read input file.
  let raw: unknown
  try {
    const text = readFileSync(SIDECAR_PATH, 'utf-8')
    raw = JSON.parse(text)
  } catch (err) {
    console.error(
      `Failed to read sidecar file at ${SIDECAR_PATH}:`,
      err instanceof Error ? err.message : String(err),
    )
    process.exit(1)
  }

  // 2. Detect format and extract signals.
  let v5Signals: CryptoDlSignalV1[]

  const v5Envelope = tryParseV5Envelope(raw)
  if (v5Envelope) {
    v5Signals = v5Envelope.signals
  } else {
    const bareSignals = tryParseBareArray(raw)
    if (bareSignals) {
      v5Signals = bareSignals
    } else {
      console.error('Unrecognised signal input format: expected v5 envelope or bare array.')
      process.exit(1)
    }
  }

  // 3. Handle empty signals.
  if (v5Signals.length === 0) {
    const emptyOutput: SignalHealthOutput = {
      generated_at: nowISO(),
      total_signals: 0,
      by_status: { pending: 0, warmup: 0, healthy: 0, decayed: 0, blocked: 0 },
      signals: [],
      summary: {
        avg_direction_accuracy: null,
        avg_rank_ic: null,
        total_settled: 0,
      },
    }

    if (dryRun) {
      if (jsonOutput) {
        console.log(JSON.stringify(emptyOutput, null, 2))
      } else {
        console.log(formatHumanReadable(emptyOutput))
      }
    } else {
      writeJsonAtomic(OUTPUT_PATH, emptyOutput)
      console.error('Signal health: no signals to evaluate.')
    }
    return
  }

  // 4. Evaluate each signal.
  const healthSignals: SignalHealthV1[] = v5Signals.map(s =>
    evaluateSignalHealth(s, now),
  )

  // 5. Aggregate.
  const byStatus: ByStatusCounts = {
    pending: 0,
    warmup: 0,
    healthy: 0,
    decayed: 0,
    blocked: 0,
  }
  let directionAccuracySum = 0
  let directionAccuracyCount = 0
  let rankIcSum = 0
  let rankIcCount = 0

  for (const s of healthSignals) {
    byStatus[s.status]++
    if (s.direction_accuracy !== undefined) {
      directionAccuracySum += s.direction_accuracy
      directionAccuracyCount++
    }
    if (s.rank_ic !== undefined) {
      rankIcSum += s.rank_ic
      rankIcCount++
    }
  }

  const output: SignalHealthOutput = {
    generated_at: nowISO(),
    total_signals: healthSignals.length,
    by_status: byStatus,
    signals: healthSignals,
    summary: {
      avg_direction_accuracy:
        directionAccuracyCount > 0
          ? directionAccuracySum / directionAccuracyCount
          : null,
      avg_rank_ic:
        rankIcCount > 0 ? rankIcSum / rankIcCount : null,
      total_settled:
        byStatus.healthy + byStatus.decayed,
    },
  }

  // 6. Write or print output.
  if (dryRun) {
    if (jsonOutput) {
      console.log(JSON.stringify(output, null, 2))
    } else {
      console.log(formatHumanReadable(output))
    }
  } else {
    writeJsonAtomic(OUTPUT_PATH, output)
    const settled = byStatus.healthy + byStatus.decayed
    console.error(
      `Signal health: ${byStatus.pending} pending, ${byStatus.warmup} warmup, ${settled} settled (${byStatus.healthy} healthy, ${byStatus.decayed} decayed), ${byStatus.blocked} blocked`,
    )
  }
}

main()
