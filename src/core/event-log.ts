/**
 * Event Log — append-only persistent event log with in-memory ring buffer.
 *
 * Every append goes to a SQLite WAL table AND an in-memory buffer.
 * The memory buffer holds the most recent N entries (default 500) for fast
 * queries. Disk is the source of truth for crash recovery and full history.
 *
 * Storage: SQLite WAL (`event_log` table), append-only.
 * Recovery: on startup, loads the tail of the table into the memory buffer
 * and restores the observed seq counter. SQLite owns write serialization,
 * crash recovery, and cross-process writer coordination.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// ==================== Types ====================

export interface EventLogEntry<T = unknown> {
  /** Global monotonic sequence number. */
  seq: number
  /** Event timestamp (epoch ms). */
  ts: number
  /** Event type, e.g. "trade.open", "heartbeat.ok". */
  type: string
  /** Arbitrary JSON-serializable payload. */
  payload: T
}

export type EventLogListener = (entry: EventLogEntry) => void

export interface EventLogQueryResult {
  entries: EventLogEntry[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface EventLog {
  /** Append an event. Returns the persisted entry (with seq/ts). */
  append<T>(type: string, payload: T): Promise<EventLogEntry<T>>

  /**
   * Read events from persistent storage.
   * - afterSeq: only return entries with seq > afterSeq (default: 0 = all)
   * - type: only return entries matching this type
   * - limit: max number of entries to return
   */
  read(opts?: { afterSeq?: number; limit?: number; type?: string }): Promise<EventLogEntry[]>

  /**
   * Paginated query from persistent storage. Returns entries newest-first (descending seq).
   * - page: 1-indexed page number (default: 1)
   * - pageSize: entries per page (default: 100)
   * - type: only return entries matching this type
   */
  query(opts?: { page?: number; pageSize?: number; type?: string }): Promise<EventLogQueryResult>

  /**
   * Query the in-memory buffer (fast, no disk I/O).
   * - afterSeq: only return entries with seq > afterSeq
   * - type: only return entries matching this type
   * - limit: max number of entries to return
   *
   * Only sees the most recent `bufferSize` entries.
   */
  recent(opts?: { afterSeq?: number; limit?: number; type?: string }): EventLogEntry[]

  /** Current highest seq number (0 if empty). */
  lastSeq(): number

  /** Subscribe to new events (real-time, on append). Returns unsubscribe fn. */
  subscribe(listener: EventLogListener): () => void

  /** Subscribe to new events of a specific type. Returns unsubscribe fn. */
  subscribeType(type: string, listener: EventLogListener): () => void

  /** Close the log (clear listeners and buffer). */
  close(): Promise<void>

  /** Reset all state and clear persistent storage. For tests only. */
  _resetForTest(): Promise<void>
}

// ==================== Defaults ====================

const DEFAULT_BUFFER_SIZE = 500

// ==================== Implementation ====================

/**
 * Create (or open) an append-only event log.
 *
 * Reads the existing file to restore the seq counter and populate the
 * in-memory buffer with the most recent entries.
 */
export async function createEventLog(opts?: {
  logPath?: string
  /** Max entries in the in-memory ring buffer. Default: 500. */
  bufferSize?: number
}): Promise<EventLog> {
  const logPath = opts?.logPath ?? 'data/event-log/events.sqlite'
  const bufferSize = opts?.bufferSize ?? DEFAULT_BUFFER_SIZE

  // Ensure directory exists
  mkdirSync(dirname(logPath), { recursive: true })
  const db = new DatabaseSync(logPath)
  try {
    db.enableDefensive(true)
  } catch {
    // Older Node SQLite builds may not expose defensive mode.
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS event_log (
      seq INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_log_type_seq
      ON event_log(type, seq);
  `)
  migrateLegacyJsonlIfEmpty(db, logPath)

  // In-memory ring buffer
  let buffer: EventLogEntry[] = []

  // Recover seq + buffer from existing file
  let seq = recoverState(db, buffer, bufferSize)

  // Listener sets
  const listeners = new Set<EventLogListener>()
  const typeListeners = new Map<string, Set<EventLogListener>>()

  // ---------- append ----------

  async function append<T>(type: string, payload: T): Promise<EventLogEntry<T>> {
    const ts = Date.now()
    const payloadJson = JSON.stringify(payload) ?? 'null'
    const result = db.prepare(
      `INSERT INTO event_log(ts, type, payload_json)
       VALUES (?, ?, ?)`,
    ).run(ts, type, payloadJson)
    const entrySeq = Number(result.lastInsertRowid)
    seq = Math.max(seq, entrySeq)
    const entry: EventLogEntry<T> = {
      seq: entrySeq,
      ts,
      type,
      payload,
    }

    // Push to ring buffer, truncate if over limit
    buffer.push(entry)
    if (buffer.length > bufferSize) {
      buffer = buffer.slice(buffer.length - bufferSize)
    }

    // Fan-out to subscribers (swallow errors to keep pipeline alive)
    for (const fn of listeners) {
      try { fn(entry) } catch (err) { console.warn('[event-log] subscriber error:', err) }
    }
    const tSet = typeListeners.get(type)
    if (tSet) {
      for (const fn of tSet) {
        try { fn(entry) } catch (err) { console.warn('[event-log] type subscriber error:', err) }
      }
    }

    return entry
  }

  // ---------- read (disk) ----------

  async function read(readOpts?: {
    afterSeq?: number
    limit?: number
    type?: string
  }): Promise<EventLogEntry[]> {
    const afterSeq = readOpts?.afterSeq ?? 0
    const limit = readOpts?.limit ?? Infinity
    const filterType = readOpts?.type

    const rows = queryRows(db, { afterSeq, limit, type: filterType, order: 'asc' })
    return rows.map(rowToEventLogEntry).filter(isEventLogEntry)
  }

  // ---------- query (disk, paginated) ----------

  async function query(queryOpts?: {
    page?: number
    pageSize?: number
    type?: string
  }): Promise<EventLogQueryResult> {
    const page = Math.max(1, queryOpts?.page ?? 1)
    const pageSize = Math.max(1, queryOpts?.pageSize ?? 100)
    const filterType = queryOpts?.type

    // Read all matching entries from disk
    const all = await read({ type: filterType })
    const total = all.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))

    // Paginate: page 1 = newest entries (end of array)
    const start = Math.max(0, total - page * pageSize)
    const end = total - (page - 1) * pageSize
    const entries = all.slice(start, end).reverse()

    return { entries, total, page, pageSize, totalPages }
  }

  // ---------- recent (memory) ----------

  function recent(readOpts?: {
    afterSeq?: number
    limit?: number
    type?: string
  }): EventLogEntry[] {
    const afterSeq = readOpts?.afterSeq ?? 0
    const limit = readOpts?.limit ?? Infinity
    const filterType = readOpts?.type

    const results: EventLogEntry[] = []

    for (const entry of buffer) {
      if (entry.seq <= afterSeq) continue
      if (filterType && entry.type !== filterType) continue
      results.push(entry)
      if (results.length >= limit) break
    }

    return results
  }

  // ---------- subscribe ----------

  function subscribe(listener: EventLogListener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  function subscribeType(type: string, listener: EventLogListener): () => void {
    let set = typeListeners.get(type)
    if (!set) {
      set = new Set()
      typeListeners.set(type, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) typeListeners.delete(type)
    }
  }

  // ---------- lifecycle ----------

  async function close(): Promise<void> {
    listeners.clear()
    typeListeners.clear()
    buffer = []
    db.close()
  }

  async function _resetForTest(): Promise<void> {
    seq = 0
    listeners.clear()
    typeListeners.clear()
    buffer = []
    db.exec('DELETE FROM event_log')
  }

  return {
    append,
    read,
    query,
    recent,
    lastSeq: () => seq,
    subscribe,
    subscribeType,
    close,
    _resetForTest,
  }
}

// ==================== Helpers ====================

/**
 * Read the log table, restore the seq counter, and populate the in-memory
 * buffer with the most recent `bufferSize` entries.
 */
function recoverState(
  db: DatabaseSync,
  buffer: EventLogEntry[],
  bufferSize: number,
): number {
  const tailRows = queryRows(db, {
    afterSeq: 0,
    limit: bufferSize,
    order: 'desc',
  })
  const tail = tailRows
    .map(rowToEventLogEntry)
    .filter(isEventLogEntry)
    .reverse()
  buffer.push(...tail)

  const row = db.prepare('SELECT MAX(seq) AS seq FROM event_log').get() as { seq?: unknown } | undefined
  return typeof row?.seq === 'number' ? row.seq : 0
}

function migrateLegacyJsonlIfEmpty(db: DatabaseSync, sqlitePath: string): void {
  const legacyPath = legacyJsonlPathFor(sqlitePath)
  if (!legacyPath || !existsSync(legacyPath)) return

  const countRow = db.prepare('SELECT COUNT(*) AS count FROM event_log').get() as { count?: unknown } | undefined
  if (countRow?.count !== 0) return

  const insert = db.prepare(
    `INSERT OR IGNORE INTO event_log(seq, ts, type, payload_json)
     VALUES (?, ?, ?, ?)`,
  )
  const entries: EventLogEntry[] = []
  for (const line of readFileSync(legacyPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (isPersistedEventLogEntry(parsed)) entries.push(parsed)
    } catch {
      continue
    }
  }

  if (entries.length === 0) return

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const entry of entries) {
      insert.run(
        entry.seq,
        entry.ts,
        entry.type,
        JSON.stringify(entry.payload) ?? 'null',
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the original migration error.
    }
    throw error
  }
}

function legacyJsonlPathFor(sqlitePath: string): string | null {
  return sqlitePath.endsWith('.sqlite')
    ? `${sqlitePath.slice(0, -'.sqlite'.length)}.jsonl`
    : null
}

interface EventLogRow {
  seq: unknown
  ts: unknown
  type: unknown
  payload_json: unknown
}

function queryRows(
  db: DatabaseSync,
  opts: {
    afterSeq: number
    limit: number
    type?: string
    order: 'asc' | 'desc'
  },
): EventLogRow[] {
  const limit = Number.isFinite(opts.limit)
    ? Math.max(0, Math.floor(opts.limit))
    : -1
  const order = opts.order === 'desc' ? 'DESC' : 'ASC'
  if (opts.type) {
    return db.prepare(
      `SELECT seq, ts, type, payload_json
       FROM event_log
       WHERE seq > ? AND type = ?
       ORDER BY seq ${order}
       LIMIT ?`,
    ).all(opts.afterSeq, opts.type, limit) as unknown as EventLogRow[]
  }

  return db.prepare(
    `SELECT seq, ts, type, payload_json
     FROM event_log
     WHERE seq > ?
     ORDER BY seq ${order}
     LIMIT ?`,
  ).all(opts.afterSeq, limit) as unknown as EventLogRow[]
}

function rowToEventLogEntry(row: EventLogRow): EventLogEntry | null {
  if (
    typeof row.seq !== 'number' ||
    typeof row.ts !== 'number' ||
    typeof row.type !== 'string' ||
    typeof row.payload_json !== 'string'
  ) {
    return null
  }

  try {
    return {
      seq: row.seq,
      ts: row.ts,
      type: row.type,
      payload: JSON.parse(row.payload_json),
    }
  } catch {
    return null
  }
}

function isEventLogEntry(entry: EventLogEntry | null): entry is EventLogEntry {
  return entry !== null
}

function isPersistedEventLogEntry(value: unknown): value is EventLogEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return Number.isSafeInteger(entry.seq) &&
    typeof entry.ts === 'number' &&
    Number.isFinite(entry.ts) &&
    typeof entry.type === 'string' &&
    entry.type.length > 0 &&
    'payload' in entry
}
