import { appendFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

export type JournalStatus =
  | "started"
  | "completed"
  | "failed"
  | "not_activated"
  | "imported"
  | "unavailable";

export interface SummaryMetrics {
  meanPbo?: number | null;
  meanDsrProbability?: number | null;
  fdrQ?: number | null;
  wfoFailureDensity?: number | null;
  totalGap?: number | null;
  meanSharpe?: number | null;
  meanAverageAbsoluteCorrelation?: number | null;
  maxAbsoluteCorrelation?: number | null;
}

export interface ExecutionJournalEntry {
  schemaVersion?: string;
  timestamp?: string;
  runId: string;
  batchId?: string | null;
  stage: string;
  action: string;
  status: JournalStatus;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  summaryMetrics?: SummaryMetrics;
  decision?: string | null;
  codeRefs?: string[];
  notes?: string[];
  backfilled?: boolean;
  hostname?: string | null;
  cwd?: string | null;
  gitHead?: string | null;
  gitBranch?: string | null;
  gitDirty?: boolean | null;
}

interface GitMeta {
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
}

const DEFAULT_JOURNAL_PATH = "data/research/strategy/execution_journal.jsonl";

export async function appendExecutionJournal(
  entry: ExecutionJournalEntry,
  journalPath = DEFAULT_JOURNAL_PATH,
): Promise<{ journalPath: string; entry: ExecutionJournalEntry }> {
  const gitMeta = await resolveGitMeta();
  const normalized: ExecutionJournalEntry = {
    schemaVersion: entry.schemaVersion ?? "execution_journal_entry.v1",
    timestamp: entry.timestamp ?? new Date().toISOString(),
    hostname: entry.hostname ?? hostname(),
    cwd: entry.cwd ?? process.cwd(),
    gitHead: entry.gitHead ?? gitMeta.head,
    gitBranch: entry.gitBranch ?? gitMeta.branch,
    gitDirty: entry.gitDirty ?? gitMeta.dirty,
    ...entry,
    inputs: normalizeRecord(entry.inputs),
    outputs: normalizeRecord(entry.outputs),
    summaryMetrics: normalizeSummaryMetrics(entry.summaryMetrics),
    codeRefs: normalizeStringArray(entry.codeRefs),
    notes: normalizeStringArray(entry.notes),
  };

  const resolvedJournalPath = resolve(journalPath);
  await mkdir(dirname(resolvedJournalPath), { recursive: true });
  await appendFile(
    resolvedJournalPath,
    `${JSON.stringify(normalized)}\n`,
    "utf-8",
  );
  return {
    journalPath: resolvedJournalPath,
    entry: normalized,
  };
}

export async function readJsonIfExists<T>(
  path: string | null | undefined,
): Promise<T | null> {
  if (!path) {
    return null;
  }
  try {
    const raw = await readFile(resolve(path), "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function extractSummaryMetrics(payload: unknown): SummaryMetrics {
  const winner = resolveWinnerPayload(payload);
  const aggregate = pickAggregateMetrics(winner) ?? pickAggregateMetrics(payload);
  const diagnostics = pickDiagnostics(payload);
  const derivedGap = deriveGapMetrics(payload, aggregate);
  return normalizeSummaryMetrics({
    meanPbo: toFiniteNumber(aggregate?.meanPbo),
    meanDsrProbability: toFiniteNumber(aggregate?.meanDsrProbability),
    fdrQ: toFiniteNumber(aggregate?.fdrQ),
    wfoFailureDensity: toFiniteNumber(winner?.wfoFailureDensity),
    totalGap: toFiniteNumber(
      winner?.hardGap?.totalGap ?? (payload as any)?.hardGap?.totalGap ?? derivedGap.totalGap,
    ),
    meanSharpe: toFiniteNumber(
      winner?.meanSharpe ??
        winner?.champion?.sharpe ??
        (payload as any)?.champion?.sharpe ??
        (payload as any)?.leader?.sharpe,
    ),
    meanAverageAbsoluteCorrelation: toFiniteNumber(
      diagnostics?.meanAverageAbsoluteCorrelation,
    ),
    maxAbsoluteCorrelation: toFiniteNumber(diagnostics?.maxAbsoluteCorrelation),
  });
}

export function resolveWinnerPayload(payload: unknown): Record<string, any> | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (Array.isArray(payload.rankedTrials) && isRecord(payload.rankedTrials[0])) {
    return payload.rankedTrials[0];
  }
  if (Array.isArray(payload.rankedProfiles) && isRecord(payload.rankedProfiles[0])) {
    return payload.rankedProfiles[0];
  }
  if (isRecord(payload.recommendedParadigm)) {
    return payload.recommendedParadigm;
  }
  return payload;
}

export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export async function loadExistingJournalRunIds(
  journalPath = DEFAULT_JOURNAL_PATH,
): Promise<Set<string>> {
  try {
    const raw = await readFile(resolve(journalPath), "utf-8");
    const lines = raw
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
    const runIds = new Set<string>();
    for (const line of lines) {
      try {
        const payload = JSON.parse(line) as { runId?: unknown };
        if (typeof payload.runId === "string" && payload.runId.trim()) {
          runIds.add(payload.runId);
        }
      } catch {
        continue;
      }
    }
    return runIds;
  } catch {
    return new Set<string>();
  }
}

function pickAggregateMetrics(payload: unknown): Record<string, any> | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (isRecord(payload.aggregateMetrics)) {
    return payload.aggregateMetrics;
  }
  if (isRecord(payload.baseAggregateMetrics)) {
    return payload.baseAggregateMetrics;
  }
  if (isRecord(payload.portfolio?.aggregateMetrics)) {
    return payload.portfolio.aggregateMetrics;
  }
  return null;
}

function pickDiagnostics(payload: unknown): Record<string, any> | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (isRecord(payload.diagnostics)) {
    return payload.diagnostics;
  }
  if (isRecord(payload.validationDiagnostics)) {
    return payload.validationDiagnostics;
  }
  return null;
}

function deriveGapMetrics(
  payload: unknown,
  aggregate: Record<string, any> | null,
): { totalGap: number | null } {
  if (!isRecord(payload) || !isRecord(aggregate) || !isRecord(payload.thresholds)) {
    return { totalGap: null };
  }
  const meanPbo = toFiniteNumber(aggregate.meanPbo);
  const meanDsr = toFiniteNumber(aggregate.meanDsrProbability);
  const fdrQ = toFiniteNumber(aggregate.fdrQ);
  const pboMax = toFiniteNumber(payload.thresholds.meanPboMax);
  const dsrMin = toFiniteNumber(payload.thresholds.meanDsrProbabilityMin);
  const fdrMax = toFiniteNumber(payload.thresholds.fdrQMax);
  if (
    meanPbo === null ||
    meanDsr === null ||
    fdrQ === null ||
    pboMax === null ||
    dsrMin === null ||
    fdrMax === null
  ) {
    return { totalGap: null };
  }
  const pboGap = Math.max(0, meanPbo - pboMax);
  const dsrGap = Math.max(0, dsrMin - meanDsr);
  const fdrGap = Math.max(0, fdrQ - fdrMax);
  return {
    totalGap: Number((pboGap + dsrGap + fdrGap).toFixed(6)),
  };
}

function normalizeSummaryMetrics(
  metrics: SummaryMetrics | undefined,
): SummaryMetrics {
  return {
    meanPbo: toFiniteNumber(metrics?.meanPbo),
    meanDsrProbability: toFiniteNumber(metrics?.meanDsrProbability),
    fdrQ: toFiniteNumber(metrics?.fdrQ),
    wfoFailureDensity: toFiniteNumber(metrics?.wfoFailureDensity),
    totalGap: toFiniteNumber(metrics?.totalGap),
    meanSharpe: toFiniteNumber(metrics?.meanSharpe),
    meanAverageAbsoluteCorrelation: toFiniteNumber(
      metrics?.meanAverageAbsoluteCorrelation,
    ),
    maxAbsoluteCorrelation: toFiniteNumber(metrics?.maxAbsoluteCorrelation),
  };
}

function normalizeRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!value) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeStringArray(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveGitMeta(): Promise<GitMeta> {
  const [head, branch, dirtyRaw] = await Promise.all([
    execGit(["rev-parse", "HEAD"]),
    execGit(["rev-parse", "--abbrev-ref", "HEAD"]),
    execGit(["status", "--porcelain"]),
  ]);
  return {
    head,
    branch,
    dirty: dirtyRaw === null ? null : dirtyRaw.trim().length > 0,
  };
}

async function execGit(args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", code => {
      resolvePromise(code === 0 ? stdout.trim() : null);
    });
  });
}
