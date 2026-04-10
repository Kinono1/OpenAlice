import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type IdempotencyStatus = 'in_progress' | 'succeeded' | 'failed'

export interface TradeIdempotencyRecord {
  key: string
  status: IdempotencyStatus
  createdAt: number
  updatedAt: number
  expiresAt: number
  symbol?: string
  ticketId?: string
  orderId?: string
  error?: string
}

interface TradeIdempotencySnapshot {
  records: Record<string, TradeIdempotencyRecord>
}

export interface ReserveIdempotencyInput {
  key: string
  symbol?: string
  ticketId?: string
  allowRetryOnFailed?: boolean
  nowMs?: number
}

export interface ReserveIdempotencyResult {
  acquired: boolean
  retriedFromFailed?: boolean
  record: TradeIdempotencyRecord
}

export interface FinalizeIdempotencyInput {
  key: string
  status: 'succeeded' | 'failed'
  orderId?: string
  error?: string
  nowMs?: number
}

const DEFAULT_LOCK_RETRY_MS = 25

export class TradeIdempotencyStore {
  private readonly lockPath: string

  constructor(
    private readonly filePath: string,
    private readonly ttlMs = 30 * 60_000,
    private readonly lockTimeoutMs = 5_000,
  ) {
    this.lockPath = `${filePath}.lock`
  }

  async reserve(input: ReserveIdempotencyInput): Promise<ReserveIdempotencyResult> {
    return this.withLock(async () => {
      const nowMs = input.nowMs ?? Date.now()
      const snapshot = await this.readSnapshot()
      this.pruneExpired(snapshot, nowMs)

      const existing = snapshot.records[input.key]
      if (existing) {
        if (input.allowRetryOnFailed && existing.status === 'failed') {
          const retried: TradeIdempotencyRecord = {
            key: input.key,
            status: 'in_progress',
            createdAt: existing.createdAt,
            updatedAt: nowMs,
            expiresAt: nowMs + this.ttlMs,
            symbol: input.symbol ?? existing.symbol,
            ticketId: input.ticketId ?? existing.ticketId,
          }
          snapshot.records[input.key] = retried
          await this.writeSnapshot(snapshot)
          return { acquired: true, retriedFromFailed: true, record: retried }
        }
        await this.writeSnapshot(snapshot)
        return { acquired: false, record: existing }
      }

      const record: TradeIdempotencyRecord = {
        key: input.key,
        status: 'in_progress',
        createdAt: nowMs,
        updatedAt: nowMs,
        expiresAt: nowMs + this.ttlMs,
        symbol: input.symbol,
        ticketId: input.ticketId,
      }
      snapshot.records[input.key] = record
      await this.writeSnapshot(snapshot)
      return { acquired: true, record }
    })
  }

  async finalize(input: FinalizeIdempotencyInput): Promise<void> {
    await this.withLock(async () => {
      const nowMs = input.nowMs ?? Date.now()
      const snapshot = await this.readSnapshot()
      this.pruneExpired(snapshot, nowMs)
      const existing = snapshot.records[input.key]
      if (!existing) {
        return
      }
      existing.status = input.status
      existing.orderId = input.orderId
      existing.error = input.error
      existing.updatedAt = nowMs
      existing.expiresAt = nowMs + this.ttlMs
      snapshot.records[input.key] = existing
      await this.writeSnapshot(snapshot)
    })
  }

  async get(key: string): Promise<TradeIdempotencyRecord | null> {
    const snapshot = await this.readSnapshot()
    const nowMs = Date.now()
    this.pruneExpired(snapshot, nowMs)
    const existing = snapshot.records[key]
    if (!existing) {
      return null
    }
    return existing
  }

  async cleanup(nowMs = Date.now()): Promise<number> {
    return this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      const before = Object.keys(snapshot.records).length
      this.pruneExpired(snapshot, nowMs)
      const after = Object.keys(snapshot.records).length
      if (after !== before) {
        await this.writeSnapshot(snapshot)
      }
      return before - after
    })
  }

  async listRecords(nowMs = Date.now()): Promise<TradeIdempotencyRecord[]> {
    const snapshot = await this.readSnapshot()
    this.pruneExpired(snapshot, nowMs)
    return Object.values(snapshot.records)
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const startedAt = Date.now()
    while (true) {
      try {
        const lockFd = await open(this.lockPath, 'wx')
        try {
          return await fn()
        } finally {
          await lockFd.close().catch(() => {})
          await unlink(this.lockPath).catch(() => {})
        }
      } catch (err) {
        if (
          err instanceof Error &&
          'code' in err &&
          (err as NodeJS.ErrnoException).code === 'EEXIST'
        ) {
          if (Date.now() - startedAt >= this.lockTimeoutMs) {
            throw new Error(
              `TradeIdempotencyStore lock timeout after ${this.lockTimeoutMs}ms (${this.filePath})`,
            )
          }
          await sleep(DEFAULT_LOCK_RETRY_MS)
          continue
        }
        throw err
      }
    }
  }

  private async readSnapshot(): Promise<TradeIdempotencySnapshot> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<TradeIdempotencySnapshot>
      if (!parsed.records || typeof parsed.records !== 'object') {
        return { records: {} }
      }
      return { records: parsed.records as Record<string, TradeIdempotencyRecord> }
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return { records: {} }
      }
      throw err
    }
  }

  private async writeSnapshot(snapshot: TradeIdempotencySnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmpPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8')
    await rename(tmpPath, this.filePath)
  }

  private pruneExpired(snapshot: TradeIdempotencySnapshot, nowMs: number): void {
    for (const [key, record] of Object.entries(snapshot.records)) {
      if (record.expiresAt <= nowMs) {
        delete snapshot.records[key]
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
