import type { EventLog, EventLogEntry } from "../core/event-log.js";

const DUPLICATE_EVENT = "idempotency.duplicate";
const RETRY_OVERRIDE_EVENT = "idempotency.retry_override";
const RETRY_REJECTED_EVENT = "idempotency.retry_rejected";

export interface IdempotencyGovernanceSummary {
  duplicateCount: number;
  retryOverrideCount: number;
  retryRejectedCount: number;
  duplicateKeys: string[];
  retryOverrideKeys: string[];
  retryRejectedKeys: string[];
}

export async function summarizeIdempotencyEventsForDate(
  eventLog: Pick<EventLog, "read"> | undefined,
  date: string
): Promise<IdempotencyGovernanceSummary> {
  assertDate(date);
  if (!eventLog) {
    return emptySummary();
  }

  const dayStartMs = Date.parse(`${date}T00:00:00.000Z`);
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;

  const [duplicates, retryOverrides, retryRejected] = await Promise.all([
    eventLog.read({ type: DUPLICATE_EVENT }),
    eventLog.read({ type: RETRY_OVERRIDE_EVENT }),
    eventLog.read({ type: RETRY_REJECTED_EVENT }),
  ]);

  const duplicateEntries = filterEntriesByDay(duplicates, dayStartMs, dayEndMs);
  const retryEntries = filterEntriesByDay(retryOverrides, dayStartMs, dayEndMs);
  const retryRejectedEntries = filterEntriesByDay(
    retryRejected,
    dayStartMs,
    dayEndMs
  );

  return {
    duplicateCount: duplicateEntries.length,
    retryOverrideCount: retryEntries.length,
    retryRejectedCount: retryRejectedEntries.length,
    duplicateKeys: uniqueInOrder(
      duplicateEntries
        .map(entry => extractPayloadKey(entry))
        .filter((value): value is string => Boolean(value))
    ),
    retryOverrideKeys: uniqueInOrder(
      retryEntries
        .map(entry => extractPayloadKey(entry))
        .filter((value): value is string => Boolean(value))
    ),
    retryRejectedKeys: uniqueInOrder(
      retryRejectedEntries
        .map(entry => extractPayloadKey(entry))
        .filter((value): value is string => Boolean(value))
    ),
  };
}

function filterEntriesByDay(
  entries: EventLogEntry[],
  dayStartMs: number,
  dayEndMs: number
): EventLogEntry[] {
  return entries.filter(
    entry => entry.ts >= dayStartMs && entry.ts < dayEndMs
  );
}

function extractPayloadKey(entry: EventLogEntry): string | undefined {
  if (!entry.payload || typeof entry.payload !== "object") {
    return undefined;
  }
  const key = (entry.payload as Record<string, unknown>).key;
  if (typeof key !== "string") {
    return undefined;
  }
  const trimmed = key.trim();
  return trimmed ? trimmed : undefined;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function emptySummary(): IdempotencyGovernanceSummary {
  return {
    duplicateCount: 0,
    retryOverrideCount: 0,
    retryRejectedCount: 0,
    duplicateKeys: [],
    retryOverrideKeys: [],
    retryRejectedKeys: [],
  };
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(
      `Invalid date ${value}. Expected YYYY-MM-DD for idempotency summary.`
    );
  }
}
