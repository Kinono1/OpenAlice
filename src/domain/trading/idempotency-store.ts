import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

type IdempotencyStatus = 'in_progress' | 'unresolved' | 'succeeded' | 'failed'

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
  commandId?: string
  permitV2Id?: string
  acceptedSequence?: string
  clientOrderId?: string
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

export interface MarkIdempotencyUnresolvedInput {
  key: string
  error: string
  symbol?: string
  ticketId?: string
  commandId?: string
  permitV2Id?: string
  acceptedSequence?: string
  clientOrderId?: string
  nowMs?: number
}

const DEFAULT_LOCK_RETRY_MS = 25
const SNAPSHOT_CORRUPTION_ERROR = 'idempotency_snapshot_corruption'
const HASH_RE = /^[a-f0-9]{64}$/
const POSITIVE_UINT64_RE = /^[1-9][0-9]*$/
const CLIENT_ORDER_ID_RE = /^[A-Za-z0-9]{1,32}$/
const UINT64_MAX = 18_446_744_073_709_551_615n
const RECORD_FIELDS = new Set([
  'key',
  'status',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'symbol',
  'ticketId',
  'orderId',
  'error',
  'commandId',
  'permitV2Id',
  'acceptedSequence',
  'clientOrderId',
])

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
      if (existing.status === 'unresolved') {
        throw new Error('idempotency_unresolved_requires_verified_sidecar_terminal')
      }
      if (existing.status === 'succeeded' || existing.status === 'failed') {
        if (
          existing.status === input.status
          && existing.orderId === input.orderId
          && existing.error === input.error
        ) {
          return
        }
        throw new Error('idempotency_terminal_record_immutable')
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

  /**
   * Persists an execution whose terminal broker outcome is not yet proven.
   * Unresolved records never expire automatically, so a process restart or
   * ordinary TTL cleanup cannot open a duplicate-submission window.
   */
  async markUnresolved(input: MarkIdempotencyUnresolvedInput): Promise<void> {
    assertUnresolvedIdentifiers(input)
    await this.withLock(async () => {
      const nowMs = input.nowMs ?? Date.now()
      const snapshot = await this.readSnapshot()
      this.pruneExpired(snapshot, nowMs)
      const existing = snapshot.records[input.key] ?? {
        key: input.key,
        status: 'unresolved' as const,
        createdAt: nowMs,
        updatedAt: nowMs,
        expiresAt: nowMs + this.ttlMs,
        symbol: input.symbol,
        ticketId: input.ticketId,
      }
      if (existing.status === 'succeeded' || existing.status === 'failed') {
        throw new Error('idempotency_terminal_record_cannot_become_unresolved')
      }
      existing.symbol ??= input.symbol
      existing.ticketId ??= input.ticketId
      for (const field of [
        'commandId',
        'permitV2Id',
        'acceptedSequence',
        'clientOrderId',
      ] as const) {
        const received = input[field]
        const stored = existing[field]
        if (received !== undefined && stored !== undefined && received !== stored) {
          throw new Error(`idempotency_unresolved_identity_conflict:${field}`)
        }
        if (received !== undefined) existing[field] = received
      }
      existing.status = 'unresolved'
      existing.error = input.error
      existing.updatedAt = nowMs
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
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf-8')
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return emptySnapshot()
      }
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw snapshotCorruptionError()
    }
    return validateSnapshot(parsed)
  }

  private async writeSnapshot(snapshot: TradeIdempotencySnapshot): Promise<void> {
    const parent = dirname(this.filePath)
    await mkdir(parent, { recursive: true })
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    let temporaryExists = false
    try {
      const temporary = await open(tmpPath, 'wx', 0o600)
      temporaryExists = true
      try {
        await temporary.writeFile(JSON.stringify(snapshot, null, 2) + '\n', 'utf-8')
        await temporary.datasync()
      } finally {
        await temporary.close()
      }
      await rename(tmpPath, this.filePath)
      temporaryExists = false
      const directory = await open(parent, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      if (temporaryExists) await unlink(tmpPath).catch(() => {})
    }
  }

  private pruneExpired(snapshot: TradeIdempotencySnapshot, nowMs: number): void {
    for (const [key, record] of Object.entries(snapshot.records)) {
      if (record.status !== 'unresolved' && record.expiresAt <= nowMs) {
        delete snapshot.records[key]
      }
    }
  }
}

function assertUnresolvedIdentifiers(input: MarkIdempotencyUnresolvedInput): void {
  if (!input.key || !input.error) {
    throw new Error('idempotency_unresolved_key_and_error_required')
  }
  if (input.commandId !== undefined && !HASH_RE.test(input.commandId)) {
    throw new Error('idempotency_unresolved_command_id_invalid')
  }
  if (input.permitV2Id !== undefined && !HASH_RE.test(input.permitV2Id)) {
    throw new Error('idempotency_unresolved_permit_id_invalid')
  }
  if (
    input.acceptedSequence !== undefined
    && (!POSITIVE_UINT64_RE.test(input.acceptedSequence)
      || BigInt(input.acceptedSequence) > UINT64_MAX)
  ) {
    throw new Error('idempotency_unresolved_sequence_invalid')
  }
  if (
    input.clientOrderId !== undefined
    && !CLIENT_ORDER_ID_RE.test(input.clientOrderId)
  ) {
    throw new Error('idempotency_unresolved_client_order_id_invalid')
  }
}

function emptySnapshot(): TradeIdempotencySnapshot {
  return { records: Object.create(null) }
}

function validateSnapshot(value: unknown): TradeIdempotencySnapshot {
  if (!isRecord(value) || !hasExactKeys(value, new Set(['records']))) {
    throw snapshotCorruptionError()
  }
  if (!isRecord(value.records)) throw snapshotCorruptionError()

  const records: Record<string, TradeIdempotencyRecord> = Object.create(null)
  for (const [key, record] of Object.entries(value.records)) {
    records[key] = validateRecord(key, record)
  }
  return { records }
}

function validateRecord(snapshotKey: string, value: unknown): TradeIdempotencyRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, RECORD_FIELDS)) {
    throw snapshotCorruptionError()
  }
  const key = requiredString(value.key)
  if (key !== snapshotKey) throw snapshotCorruptionError()

  const status = value.status
  if (
    status !== 'in_progress'
    && status !== 'unresolved'
    && status !== 'succeeded'
    && status !== 'failed'
  ) throw snapshotCorruptionError()

  const createdAt = requiredFiniteNumber(value.createdAt)
  const updatedAt = requiredFiniteNumber(value.updatedAt)
  const expiresAt = requiredFiniteNumber(value.expiresAt)
  if (createdAt > updatedAt) throw snapshotCorruptionError()

  const symbol = optionalString(value, 'symbol')
  const ticketId = optionalString(value, 'ticketId')
  const orderId = optionalString(value, 'orderId')
  const error = optionalString(value, 'error')
  const commandId = optionalHash(value, 'commandId')
  const permitV2Id = optionalHash(value, 'permitV2Id')
  const acceptedSequence = optionalSequence(value, 'acceptedSequence')
  const clientOrderId = optionalClientOrderId(value, 'clientOrderId')
  const hasSidecarIdentifiers = (
    commandId !== undefined
    || permitV2Id !== undefined
    || acceptedSequence !== undefined
    || clientOrderId !== undefined
  )

  // There is deliberately no persisted "verified sidecar broker terminal"
  // status in this schema.  Identifiers are retained only while the outcome is
  // unresolved; generic succeeded/failed rows stay legacy/native terminals.
  if (status === 'in_progress' && (
    orderId !== undefined || error !== undefined || hasSidecarIdentifiers
  )) throw snapshotCorruptionError()
  if (status === 'unresolved' && (error === undefined || error.length === 0 || orderId !== undefined)) {
    throw snapshotCorruptionError()
  }
  if ((status === 'succeeded' || status === 'failed') && hasSidecarIdentifiers) {
    throw snapshotCorruptionError()
  }

  return {
    key,
    status,
    createdAt,
    updatedAt,
    expiresAt,
    ...(symbol === undefined ? {} : { symbol }),
    ...(ticketId === undefined ? {} : { ticketId }),
    ...(orderId === undefined ? {} : { orderId }),
    ...(error === undefined ? {} : { error }),
    ...(commandId === undefined ? {} : { commandId }),
    ...(permitV2Id === undefined ? {} : { permitV2Id }),
    ...(acceptedSequence === undefined ? {} : { acceptedSequence }),
    ...(clientOrderId === undefined ? {} : { clientOrderId }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: Set<string>): boolean {
  return hasOnlyKeys(value, expected) && Object.keys(value).length === expected.size
}

function hasOnlyKeys(value: Record<string, unknown>, expected: Set<string>): boolean {
  return Object.keys(value).every(key => expected.has(key))
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw snapshotCorruptionError()
  return value
}

function requiredFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw snapshotCorruptionError()
  return value
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (!(key in value)) return undefined
  return requiredString(value[key])
}

function optionalHash(value: Record<string, unknown>, key: string): string | undefined {
  const item = optionalString(value, key)
  if (item !== undefined && !HASH_RE.test(item)) throw snapshotCorruptionError()
  return item
}

function optionalSequence(value: Record<string, unknown>, key: string): string | undefined {
  const item = optionalString(value, key)
  if (
    item !== undefined
    && (!POSITIVE_UINT64_RE.test(item) || BigInt(item) > UINT64_MAX)
  ) throw snapshotCorruptionError()
  return item
}

function optionalClientOrderId(value: Record<string, unknown>, key: string): string | undefined {
  const item = optionalString(value, key)
  if (item !== undefined && !CLIENT_ORDER_ID_RE.test(item)) throw snapshotCorruptionError()
  return item
}

function snapshotCorruptionError(): Error {
  return new Error(SNAPSHOT_CORRUPTION_ERROR)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
