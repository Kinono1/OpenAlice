import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const PAPER_EXECUTOR_JOURNAL_MAX_BYTES = 1_048_576;

export interface PaperExecutorJournalEntry {
  simulationCommitId: string;
  walletCommitHash: string;
  executedAt: string;
  operationCount: number;
  strategyFamily: string;
  registryChecksum?: string;
}

export interface PersistedPaperExecutorJournal {
  version: 1;
  lastUpdatedAt: string;
  entries: PaperExecutorJournalEntry[];
}

export async function loadPaperExecutorJournal(
  filePath = "data/runtime/paper_executor_journal.json",
): Promise<PersistedPaperExecutorJournal> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizePaperExecutorJournal(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: 1,
        lastUpdatedAt: new Date(0).toISOString(),
        entries: [],
      };
    }
    throw err;
  }
}

export async function writePaperExecutorJournal(
  journal: PersistedPaperExecutorJournal,
  filePath = "data/runtime/paper_executor_journal.json",
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const originalSerialized = serializeJournal(journal);
  const normalized = compactJournalToFit(journal);
  const serialized = serializeJournal(normalized);
  const rotated = originalSerialized.byteLength > PAPER_EXECUTOR_JOURNAL_MAX_BYTES;

  if (serialized.byteLength > PAPER_EXECUTOR_JOURNAL_MAX_BYTES) {
    throw new Error("Paper executor journal cannot be compacted under the size limit.");
  }

  if (rotated && (await fileExists(filePath))) {
    const current = await stat(filePath);
    if (current.size > 0) {
      await rename(filePath, `${filePath}.${Date.now()}.archive.json`);
    }
  }

  await writeFile(filePath, serialized.content, "utf-8");
}

export function hasExecutedSimulationCommit(
  journal: PersistedPaperExecutorJournal,
  simulationCommitId: string,
): boolean {
  return journal.entries.some(
    (entry) => entry.simulationCommitId === simulationCommitId,
  );
}

export function appendPaperExecutorJournalEntry(
  journal: PersistedPaperExecutorJournal,
  entry: PaperExecutorJournalEntry,
): PersistedPaperExecutorJournal {
  if (hasExecutedSimulationCommit(journal, entry.simulationCommitId)) {
    return journal;
  }
  return {
    version: 1,
    lastUpdatedAt: new Date().toISOString(),
    entries: [...journal.entries, entry],
  };
}

export function normalizePaperExecutorJournal(
  raw: unknown,
): PersistedPaperExecutorJournal {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid paper executor journal payload.");
  }
  const value = raw as Partial<PersistedPaperExecutorJournal>;
  if (value.version !== 1 || typeof value.lastUpdatedAt !== "string" || !Array.isArray(value.entries)) {
    throw new Error("Malformed paper executor journal.");
  }
  return {
    version: 1,
    lastUpdatedAt: value.lastUpdatedAt,
    entries: value.entries.map((entry) => {
      const item = entry as Partial<PaperExecutorJournalEntry>;
      if (
        typeof item.simulationCommitId !== "string" ||
        typeof item.walletCommitHash !== "string" ||
        typeof item.executedAt !== "string" ||
        typeof item.operationCount !== "number" ||
        typeof item.strategyFamily !== "string"
      ) {
        throw new Error("Malformed paper executor journal entry.");
      }
      return {
        simulationCommitId: item.simulationCommitId,
        walletCommitHash: item.walletCommitHash,
        executedAt: item.executedAt,
        operationCount: item.operationCount,
        strategyFamily: item.strategyFamily,
        registryChecksum: item.registryChecksum,
      };
    }),
  };
}

function compactJournalToFit(
  journal: PersistedPaperExecutorJournal,
): PersistedPaperExecutorJournal {
  let entries = [...journal.entries];
  let compacted: PersistedPaperExecutorJournal = {
    version: 1,
    lastUpdatedAt: journal.lastUpdatedAt,
    entries,
  };

  while (
    entries.length > 0 &&
    serializeJournal(compacted).byteLength > PAPER_EXECUTOR_JOURNAL_MAX_BYTES
  ) {
    entries = entries.slice(1);
    compacted = {
      version: 1,
      lastUpdatedAt: journal.lastUpdatedAt,
      entries,
    };
  }

  return compacted;
}

function serializeJournal(
  journal: PersistedPaperExecutorJournal,
): { content: string; byteLength: number } {
  const content = `${JSON.stringify(journal, null, 2)}\n`;
  return {
    content,
    byteLength: Buffer.byteLength(content, "utf-8"),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
