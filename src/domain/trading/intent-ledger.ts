/**
 * Intent Ledger — append-only record of trade intentions.
 * Every order attempt is recorded BEFORE execution, creating an audit trail.
 * Uses fdatasync for durability.
 */

import { open, readFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { StrategyExecutionSummary } from '../strategy/execution-decision.js'
import type { ExecutionTelemetry } from './operation-dispatcher.types.js'

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
}

export interface IntentLedgerEntry {
  type: 'intent' | 'result'
  data: TradeIntent | IntentResult
}

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
    this.fd = await open(this.filePath, 'a')
  }

  async recordIntent(intent: TradeIntent): Promise<void> {
    if (!this.fd) throw new Error('IntentLedger not initialized')
    const entry: IntentLedgerEntry = { type: 'intent', data: intent }
    const line = JSON.stringify(entry) + '\n'
    await this.fd.write(line)
    await this.fd.datasync()
    intentFlushStats.intentFsyncs++
  }

  async recordResult(result: IntentResult): Promise<void> {
    if (!this.fd) throw new Error('IntentLedger not initialized')
    const entry: IntentLedgerEntry = { type: 'result', data: result }
    const line = JSON.stringify(entry) + '\n'
    await this.fd.write(line)
    await this.fd.datasync()
    intentFlushStats.resultFsyncs++
  }

  async readAll(): Promise<IntentLedgerEntry[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const entries: IntentLedgerEntry[] = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          entries.push(JSON.parse(line) as IntentLedgerEntry)
        } catch {
          // tolerate malformed trailing or partially-written lines
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
}
