import { describe, expect, it, vi } from "vitest";
import type { EventLog, EventLogEntry } from "../core/event-log.js";
import { summarizeIdempotencyEventsForDate } from "./idempotency_event_summary.js";

describe("idempotency_event_summary", () => {
  it("returns zero summary when event log is unavailable", async () => {
    const summary = await summarizeIdempotencyEventsForDate(
      undefined,
      "2026-02-27"
    );

    expect(summary).toEqual({
      duplicateCount: 0,
      retryOverrideCount: 0,
      retryRejectedCount: 0,
      duplicateKeys: [],
      retryOverrideKeys: [],
      retryRejectedKeys: [],
    });
  });

  it("aggregates daily duplicate/retry events and key sets", async () => {
    const targetDate = "2026-02-27";
    const dayStartMs = Date.parse(`${targetDate}T00:00:00.000Z`);
    const entriesByType = new Map<string, EventLogEntry[]>([
      [
        "idempotency.duplicate",
        [
          makeEntry(1, dayStartMs - 10, "idempotency.duplicate", {
            key: "old-key",
          }),
          makeEntry(2, dayStartMs + 1, "idempotency.duplicate", {
            key: "ticket:A",
          }),
          makeEntry(3, dayStartMs + 100, "idempotency.duplicate", {
            key: "ticket:A",
          }),
          makeEntry(4, dayStartMs + 200, "idempotency.duplicate", {
            key: "ticket:B",
          }),
        ],
      ],
      [
        "idempotency.retry_override",
        [
          makeEntry(5, dayStartMs + 300, "idempotency.retry_override", {
            key: "ticket:A",
          }),
          makeEntry(6, dayStartMs + 400, "idempotency.retry_override", {
            key: "ticket:C",
          }),
          makeEntry(7, dayStartMs + 24 * 60 * 60 * 1000, "idempotency.retry_override", {
            key: "next-day",
          }),
        ],
      ],
      [
        "idempotency.retry_rejected",
        [
          makeEntry(8, dayStartMs + 500, "idempotency.retry_rejected", {
            key: "ticket:D",
          }),
        ],
      ],
    ]);

    const readMock = vi.fn(async (opts?: { type?: string }) => {
      return entriesByType.get(opts?.type ?? "") ?? [];
    });

    const summary = await summarizeIdempotencyEventsForDate(
      { read: readMock } as Pick<EventLog, "read">,
      targetDate
    );

    expect(summary.duplicateCount).toBe(3);
    expect(summary.retryOverrideCount).toBe(2);
    expect(summary.retryRejectedCount).toBe(1);
    expect(summary.duplicateKeys).toEqual(["ticket:A", "ticket:B"]);
    expect(summary.retryOverrideKeys).toEqual(["ticket:A", "ticket:C"]);
    expect(summary.retryRejectedKeys).toEqual(["ticket:D"]);
    expect(readMock).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid date format", async () => {
    await expect(
      summarizeIdempotencyEventsForDate(undefined, "2026/02/27")
    ).rejects.toThrow("Expected YYYY-MM-DD");
  });
});

function makeEntry(
  seq: number,
  ts: number,
  type: string,
  payload: unknown
): EventLogEntry {
  return { seq, ts, type, payload };
}
