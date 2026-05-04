import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  appendExecutionJournal,
  type ExecutionJournalEntry,
} from "./lib/execution_journal.js";

interface CliArgs {
  entryJson?: string;
  entry?: string;
  journalPath?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const payload = await loadEntry(args);
  if (!payload.runId || !payload.stage || !payload.action || !payload.status) {
    throw new Error(
      "--entry or --entry-json must define runId, stage, action, and status.",
    );
  }
  const result = await appendExecutionJournal(payload, args.journalPath);
  console.log(
    [
      `journal=${result.journalPath}`,
      `runId=${result.entry.runId}`,
      `status=${result.entry.status}`,
      `action=${result.entry.action}`,
    ].join(" | "),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  return {
    entryJson: raw.get("entry-json"),
    entry: raw.get("entry"),
    journalPath: raw.get("journal-path"),
  };
}

async function loadEntry(args: CliArgs): Promise<ExecutionJournalEntry> {
  if (args.entryJson) {
    const raw = await readFile(resolve(args.entryJson), "utf-8");
    return JSON.parse(raw) as ExecutionJournalEntry;
  }
  if (args.entry) {
    return JSON.parse(args.entry) as ExecutionJournalEntry;
  }
  throw new Error("Either --entry-json or --entry is required.");
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    index += 1;
  }
  return out;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

