import { appendFile, mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'

export type JournalStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'not_activated'
  | 'imported'
  | 'unavailable'

export interface ExecutionJournalEntry {
  schemaVersion?: string
  timestamp?: string
  runId: string
  batchId?: string | null
  stage: string
  action: string
  status: JournalStatus
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
  decision?: string | null
  codeRefs?: string[]
  notes?: string[]
  hostname?: string | null
  cwd?: string | null
  gitHead?: string | null
  gitBranch?: string | null
  gitDirty?: boolean | null
}

const DEFAULT_JOURNAL_PATH = 'data/research/strategy/execution_journal.jsonl'

export async function appendExecutionJournal(
  entry: ExecutionJournalEntry,
  journalPath = DEFAULT_JOURNAL_PATH,
): Promise<{ journalPath: string; entry: ExecutionJournalEntry }> {
  const resolvedJournalPath = resolve(journalPath)
  const normalized: ExecutionJournalEntry = {
    schemaVersion: entry.schemaVersion ?? 'execution_journal_entry.v1',
    timestamp: entry.timestamp ?? new Date().toISOString(),
    hostname: entry.hostname ?? hostname(),
    cwd: entry.cwd ?? process.cwd(),
    gitHead: entry.gitHead ?? null,
    gitBranch: entry.gitBranch ?? null,
    gitDirty: entry.gitDirty ?? null,
    ...entry,
    inputs: normalizeRecord(entry.inputs),
    outputs: normalizeRecord(entry.outputs),
    codeRefs: normalizeStringArray(entry.codeRefs),
    notes: normalizeStringArray(entry.notes),
  }

  await mkdir(dirname(resolvedJournalPath), { recursive: true })
  await appendFile(resolvedJournalPath, `${JSON.stringify(normalized)}\n`, 'utf-8')
  return { journalPath: resolvedJournalPath, entry: normalized }
}

export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

function normalizeRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ? Object.fromEntries(Object.entries(value)) : {}
}

function normalizeStringArray(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return []
  }
  return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}
