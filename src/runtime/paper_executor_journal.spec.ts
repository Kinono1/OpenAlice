import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAPER_EXECUTOR_JOURNAL_MAX_BYTES,
  appendPaperExecutorJournalEntry,
  hasExecutedSimulationCommit,
  loadPaperExecutorJournal,
  normalizePaperExecutorJournal,
  writePaperExecutorJournal,
} from "./paper_executor_journal.js";

describe("paper_executor_journal", () => {
  it("dedupes executed simulation commit ids", () => {
    const base = {
      version: 1 as const,
      lastUpdatedAt: "2026-03-14T00:00:00.000Z",
      entries: [],
    };

    const once = appendPaperExecutorJournalEntry(base, {
      simulationCommitId: "sim-1",
      walletCommitHash: "abc12345",
      executedAt: "2026-03-14T01:00:00.000Z",
      operationCount: 1,
      strategyFamily: "vol_gated_trend",
    });
    const twice = appendPaperExecutorJournalEntry(once, {
      simulationCommitId: "sim-1",
      walletCommitHash: "abc12345",
      executedAt: "2026-03-14T01:00:00.000Z",
      operationCount: 1,
      strategyFamily: "vol_gated_trend",
    });

    expect(hasExecutedSimulationCommit(twice, "sim-1")).toBe(true);
    expect(twice.entries).toHaveLength(1);
  });

  it("normalizes a persisted journal payload", () => {
    const normalized = normalizePaperExecutorJournal({
      version: 1,
      lastUpdatedAt: "2026-03-14T00:00:00.000Z",
      entries: [
        {
          simulationCommitId: "sim-1",
          walletCommitHash: "abc12345",
          executedAt: "2026-03-14T01:00:00.000Z",
          operationCount: 2,
          strategyFamily: "vol_gated_breakout",
          registryChecksum: "checksum",
        },
      ],
    });

    expect(normalized.entries[0].walletCommitHash).toBe("abc12345");
    expect(normalized.entries[0].registryChecksum).toBe("checksum");
  });

  it("rotates and compacts the active journal when it exceeds the size cap", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "paper-executor-journal-"));
    const filePath = join(tempDir, "paper_executor_journal.json");
    const entries = Array.from({ length: 64 }, (_, index) => ({
      simulationCommitId: `sim-${index}`,
      walletCommitHash: `hash-${index}`,
      executedAt: "2026-03-14T01:00:00.000Z",
      operationCount: 1,
      strategyFamily: "vol_gated_trend",
      registryChecksum: "x".repeat(20_000),
    }));

    await writePaperExecutorJournal(
      {
        version: 1,
        lastUpdatedAt: "2026-03-14T02:00:00.000Z",
        entries,
      },
      filePath,
    );

    const files = await readdir(tempDir);
    expect(files.some((name) => name.includes(".archive.json"))).toBe(false);

    await writePaperExecutorJournal(
      {
        version: 1,
        lastUpdatedAt: "2026-03-14T03:00:00.000Z",
        entries: [...entries, {
          simulationCommitId: "sim-overflow",
          walletCommitHash: "hash-overflow",
          executedAt: "2026-03-14T03:00:00.000Z",
          operationCount: 1,
          strategyFamily: "vol_gated_trend",
          registryChecksum: "y".repeat(200_000),
        }],
      },
      filePath,
    );

    const nextFiles = await readdir(tempDir);
    expect(nextFiles.some((name) => name.includes(".archive.json"))).toBe(true);

    const loaded = await loadPaperExecutorJournal(filePath);
    expect(JSON.stringify(loaded).length).toBeLessThan(PAPER_EXECUTOR_JOURNAL_MAX_BYTES);
    expect(loaded.entries.length).toBeLessThan(entries.length + 1);
  });
});
