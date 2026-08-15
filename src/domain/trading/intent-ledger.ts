/**
 * Intent Ledger — append-only record of trade intentions.
 * Every order attempt is recorded BEFORE execution, creating an audit trail.
 * Uses fdatasync for durability.
 */

import { open, readFile, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { StrategyExecutionSummary } from '../strategy/execution-decision.js'
import type { ExecutionTelemetry } from './operation-dispatcher.types.js'
import type { BrokerWriteRoute } from './broker-write-router.js'

export interface TradeIntent {
  intentId: string
  ticketId: string
  symbol: string
  action: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  size?: number
  usdSize?: number
  requestedSize?: number
  requestedUsdSize?: number
  price?: number
  reduceOnly?: boolean
  leverage?: number
  contextId?: string
  exchangeId?: string
  idempotencyKey?: string
  brokerWriteRoute?: BrokerWriteRoute
  clientOrderId?: string
  createdAt: number
  strategy?: StrategyExecutionSummary
  signalTimestampMs?: number
  dispatcherStartedAtMs?: number
  expectedPrice?: number
  forcedRetryIdempotency?: boolean
}

export interface IntentResult {
  intentId: string
  status: 'success' | 'failed' | 'skipped' | 'unknown'
  orderId?: string
  filledPrice?: number
  filledSize?: number
  error?: string
  completedAt: number
  strategy?: StrategyExecutionSummary
  executionTelemetry?: ExecutionTelemetry
  brokerWriteRoute?: BrokerWriteRoute
  brokerWriteOutcome?:
    | 'pre_submit_rejected'
    | 'command_accepted'
    | 'submission_unknown'
  commandId?: string
  permitV2Id?: string
  acceptedSequence?: string
  clientOrderId?: string
}

export interface IntentLedgerEntry {
  type: 'intent' | 'result'
  data: TradeIntent | IntentResult
}

/** Stable error emitted when recovery finds a non-recoverable JSONL record. */
export const INTENT_LEDGER_CORRUPTION_ERROR = 'intent_ledger_corruption'

/** Stable error emitted before an invalid record can be appended. */
export const INTENT_LEDGER_VALIDATION_ERROR = 'intent_ledger_validation_failed'

const HASH_RE = /^[a-f0-9]{64}$/
const POSITIVE_UINT64_RE = /^[1-9][0-9]*$/
const UINT64_MAX = 18_446_744_073_709_551_615n
const CLIENT_ORDER_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

export const intentFlushStats = {
  intentFsyncs: 0,
  resultFsyncs: 0,
}

export class IntentLedger {
  private fd: Awaited<ReturnType<typeof open>> | null = null
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const existedBeforeOpen = await fileExists(this.filePath)
    const file = await open(this.filePath, 'a', 0o600)
    if (!existedBeforeOpen) {
      try {
        await this.syncParentDirectory()
      } catch (err) {
        await file.close()
        throw err
      }
    }
    this.fd = file
  }

  async recordIntent(intent: TradeIntent): Promise<void> {
    if (!this.fd) throw new Error('IntentLedger not initialized')
    validateIntent(intent)
    const entry: IntentLedgerEntry = { type: 'intent', data: intent }
    const line = JSON.stringify(entry) + '\n'
    await this.fd.appendFile(line, 'utf-8')
    await this.fd.datasync()
    intentFlushStats.intentFsyncs++
  }

  async recordResult(result: IntentResult): Promise<void> {
    if (!this.fd) throw new Error('IntentLedger not initialized')
    validateResult(result)
    const entry: IntentLedgerEntry = { type: 'result', data: result }
    const line = JSON.stringify(entry) + '\n'
    await this.fd.appendFile(line, 'utf-8')
    await this.fd.datasync()
    intentFlushStats.resultFsyncs++
  }

  async readAll(): Promise<IntentLedgerEntry[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const entries: IntentLedgerEntry[] = []
      const lines = raw.split('\n')
      const hasTrailingNewline = raw.endsWith('\n')
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as unknown
          validateIntentLedgerEntry(entry)
          entries.push(entry)
        } catch (err) {
          const isFinalNonNewlineLine = index === lines.length - 1 && !hasTrailingNewline
          if (isFinalNonNewlineLine && isTruncatedJsonFragment(line, err)) {
            continue
          }
          throw corruptionError()
        }
      }
      return entries
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  async close(): Promise<void> {
    if (this.fd) {
      await this.fd.datasync()
      await this.fd.close()
      this.fd = null
    }
  }

  static _resetFlushStats(): void {
    intentFlushStats.intentFsyncs = 0
    intentFlushStats.resultFsyncs = 0
  }

  private async syncParentDirectory(): Promise<void> {
    const directory = await open(dirname(this.filePath), 'r')
    try {
      // Do not downgrade durability if the platform rejects directory fsync.
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function isTruncatedJsonFragment(line: string, err: unknown): boolean {
  if (!(err instanceof SyntaxError)) return false
  if (err.message === 'Unexpected end of JSON input') return true
  // V8 reports many valid JSON prefixes (for example a torn string, unicode
  // escape, object, or comma) as an error exactly at EOF rather than with the
  // generic message above.  An error before EOF proves malformed content and
  // must not be treated as a recoverable crash tail.
  const position = /\bposition (\d+)\b/.exec(err.message)?.[1]
  return position !== undefined && Number(position) >= line.length
}

function corruptionError(): Error {
  const error = new Error(INTENT_LEDGER_CORRUPTION_ERROR)
  error.name = 'IntentLedgerCorruptionError'
  return error
}

function validationError(): Error {
  const error = new Error(INTENT_LEDGER_VALIDATION_ERROR)
  error.name = 'IntentLedgerValidationError'
  return error
}

function validateIntentLedgerEntry(value: unknown): asserts value is IntentLedgerEntry {
  const entry = asRecord(value)
  if (entry.type === 'intent') {
    validateIntent(entry.data)
    return
  }
  if (entry.type === 'result') {
    validateResult(entry.data)
    return
  }
  throw validationError()
}

function validateIntent(value: unknown): asserts value is TradeIntent {
  const intent = asRecord(value)
  assertCanonicalText(intent.intentId)
  assertCanonicalOptionalText(intent.ticketId)
  assertCanonicalText(intent.symbol)
  assertCanonicalText(intent.action)
  assertOneOf(intent.side, ['buy', 'sell'])
  assertOneOf(intent.type, ['market', 'limit'])
  assertFiniteNumber(intent.createdAt)
  validateOptionalSidecarFields(intent, false)
}

function validateResult(value: unknown): asserts value is IntentResult {
  const result = asRecord(value)
  assertCanonicalText(result.intentId)
  assertOneOf(result.status, ['success', 'failed', 'skipped', 'unknown'])
  assertFiniteNumber(result.completedAt)
  validateOptionalSidecarFields(result, true)
}

function validateOptionalSidecarFields(record: Record<string, unknown>, isResult: boolean): void {
  if (record.brokerWriteRoute !== undefined) {
    assertOneOf(record.brokerWriteRoute, ['native', 'sidecar'])
  }
  if (
    record.clientOrderId !== undefined
    && (typeof record.clientOrderId !== 'string'
      || !CLIENT_ORDER_ID_RE.test(record.clientOrderId))
  ) throw validationError()
  if (!isResult) return
  if (record.brokerWriteOutcome !== undefined) {
    assertOneOf(record.brokerWriteOutcome, [
      'pre_submit_rejected',
      'command_accepted',
      'submission_unknown',
    ])
  }
  for (const key of ['commandId', 'permitV2Id']) {
    if (record[key] !== undefined && (
      typeof record[key] !== 'string' || !HASH_RE.test(record[key])
    )) throw validationError()
  }
  if (record.acceptedSequence !== undefined && (
    typeof record.acceptedSequence !== 'string'
    || !POSITIVE_UINT64_RE.test(record.acceptedSequence)
    || BigInt(record.acceptedSequence) > UINT64_MAX
  )) {
    throw validationError()
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError()
  return value as Record<string, unknown>
}

function assertNonEmptyString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw validationError()
}

function assertCanonicalText(value: unknown): asserts value is string {
  assertNonEmptyString(value)
  if (value !== value.trim()) throw validationError()
}

function assertCanonicalOptionalText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value !== value.trim()) throw validationError()
}

function assertFiniteNumber(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw validationError()
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[]): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw validationError()
}
