/**
 * Intent Ledger — append-only record of trade intentions.
 * Every order attempt is recorded BEFORE execution, creating an audit trail.
 * Uses fdatasync for durability.
 */

import { open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'

export interface TradeIntent {
  intentId: string
  ticketId: string
  symbol: string
  action: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  size?: number
  usdSize?: number
  price?: number
  reduceOnly?: boolean
  leverage?: number
  contextId?: string
  exchangeId?: string
  clientOrderId?: string
  createdAt: number
}

export interface IntentResult {
  intentId: string
  status: 'success' | 'failed' | 'skipped'
  orderId?: string
  filledPrice?: number
  filledSize?: number
  error?: string
  completedAt: number
}

export interface IntentLedgerEntry {
  type: 'intent' | 'result'
  data: TradeIntent | IntentResult
}

/** Flush statistics for durability verification in tests */
export const intentFlushStats = {
  intentFsyncs: 0,
  resultFsyncs: 0,
}

export class IntentLedger {
  private fd: Awaited<ReturnType<typeof open>> | null = null
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    this.fd = await open(this.filePath, 'a')
  }

  /** Record a trade intent BEFORE execution. */
  async recordIntent(intent: TradeIntent): Promise<void> {
    if (!this.fd) throw new Error('IntentLedger not initialized')
    const entry: IntentLedgerEntry = { type: 'intent', data: intent }
    const line = JSON.stringify(entry) + '\n'
    await this.fd.write(line)
    await this.fd.datasync()
    intentFlushStats.intentFsyncs++
  }

  /** Record the result of an intent AFTER execution. */
  async recordResult(result: IntentResult): Promise<void> {
    if (!this.fd) throw new Error('IntentLedger not initialized')
    const entry: IntentLedgerEntry = { type: 'result', data: result }
    const line = JSON.stringify(entry) + '\n'
    await this.fd.write(line)
    await this.fd.datasync()
    intentFlushStats.resultFsyncs++
  }

  /** Read all entries (for audit/recovery). */
  async readAll(): Promise<IntentLedgerEntry[]> {
    const { readFile } = await import('node:fs/promises')
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      return raw.split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line))
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

  /** For tests. */
  static _resetFlushStats(): void {
    intentFlushStats.intentFsyncs = 0
    intentFlushStats.resultFsyncs = 0
  }
}
