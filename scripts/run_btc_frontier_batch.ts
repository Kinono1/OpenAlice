import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  extractSummaryMetrics,
  readJsonIfExists,
  sanitizeError,
} from "./lib/execution_journal.js";

type BatchKind = "full_sweep" | "import_sweep" | "memo" | "pending";

interface RegistryDefaults {
  symbol?: string;
  inputCsv?: string;
  lookbackBars?: number;
  baseManifest?: string;
  protocolProfile?: string;
  multipleTestingUnit?: "candidate" | "family";
  fdrMethod?: "bh" | "by" | "cv_storey_bh" | "stepc" | "spa";
  wfoProfile?: "stable" | "shift" | "stress";
}

interface BatchSpec {
  batch?: number;
  id?: number;
  kind?: BatchKind | string;
  enabled?: boolean;
  description?: string;
  searchJson?: string;
  sourceId?: string;
  baseManifest?: string;
  symbol?: string;
  inputCsv?: string;
  lookbackBars?: number;
  protocolProfile?: string;
  multipleTestingUnit?: "candidate" | "family";
  fdrMethod?: "bh" | "by" | "cv_storey_bh" | "stepc" | "spa";
  wfoProfile?: "stable" | "shift" | "stress";
  trialList?: number[];
  summaryOutput?: string;
  markdownOutput?: string;
  importedSummary?: string;
  importedMarkdown?: string;
  importedReason?: string;
}

interface Registry {
  schemaVersion?: string;
  defaults?: RegistryDefaults;
  batches?: BatchSpec[];
  items?: BatchSpec[];
}

interface CliArgs {
  registry: string;
  batch: number;
  dryRun: boolean;
  force: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = await readJson<Registry>(args.registry);
  const batches = registry.batches ?? registry.items ?? [];
  const batch = batches.find(item => (item.batch ?? item.id) === args.batch);
  if (!batch) {
    throw new Error(`Batch ${args.batch} not found in ${args.registry}`);
  }

  const defaults = registry.defaults ?? {};
  const kind = normalizeKind(batch.kind);
  const runId = `btc_frontier_batch_${args.batch}.${new Date().toISOString().replace(/[:.]/g, "")}`;
  const summaryOutput = resolveRequiredPath(
    batch.summaryOutput,
    `batch ${args.batch} summaryOutput`,
  );
  const markdownOutput = resolveRequiredPath(
    batch.markdownOutput,
    `batch ${args.batch} markdownOutput`,
  );
  const journalInputs = {
    registry: resolve(args.registry),
    batch: args.batch,
    kind,
    dryRun: args.dryRun,
    force: args.force,
    sourceId: batch.sourceId ?? null,
    searchJson: batch.searchJson ? resolve(batch.searchJson) : null,
  };
  const journalOutputs = {
    summary: summaryOutput,
    markdown: markdownOutput,
  };

  if (kind === "memo" || kind === "pending") {
    const payload = buildMemoPayload({
      batch: args.batch,
      kind,
      description: batch.description ?? "",
      reason: batch.importedReason ?? "no_reason_provided",
      status: kind === "memo" ? "recorded" : "pending",
    });
    if (args.dryRun) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    await appendExecutionJournal({
      runId,
      batchId: `batch${args.batch}`,
      stage: "batch",
      action: kind === "memo" ? "memo" : "frontier_decision",
      status: "started",
      inputs: journalInputs,
      outputs: journalOutputs,
      decision: "started",
      codeRefs: ["scripts/run_btc_frontier_batch.ts"],
    });
    await writeOutputs(summaryOutput, markdownOutput, payload, renderMemoMarkdown(payload));
    await appendExecutionJournal({
      runId,
      batchId: `batch${args.batch}`,
      stage: "batch",
      action: kind === "memo" ? "memo" : "frontier_decision",
      status: kind === "memo" ? "completed" : "not_activated",
      inputs: journalInputs,
      outputs: journalOutputs,
      summaryMetrics: extractSummaryMetrics(payload),
      decision: kind === "memo" ? "recorded" : "not_activated",
      codeRefs: ["scripts/run_btc_frontier_batch.ts"],
      notes: [batch.description ?? ""].filter(Boolean),
    });
    console.log(`batch=${args.batch} | kind=${kind} | mode=memo | summary=${summaryOutput}`);
    return;
  }

  if (kind === "import_sweep") {
    const importedSummary = resolveRequiredPath(
      batch.importedSummary,
      `batch ${args.batch} importedSummary`,
    );
    const importedMarkdown = resolveRequiredPath(
      batch.importedMarkdown,
      `batch ${args.batch} importedMarkdown`,
    );
    await assertExists(importedSummary, "imported summary");
    await assertExists(importedMarkdown, "imported markdown");

    const importedPayload = await readJson<Record<string, unknown>>(importedSummary);
    const payload = {
      schemaVersion: "btc_frontier_batch_result.v1",
      batch: args.batch,
      kind,
      mode: "imported",
      importedReason: batch.importedReason ?? "canonical_prior_evidence",
      importedSummary,
      importedMarkdown,
      importedPayload,
    };
    if (args.dryRun) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    await appendExecutionJournal({
      runId,
      batchId: `batch${args.batch}`,
      stage: "batch",
      action: "import_prior_evidence",
      status: "started",
      inputs: {
        ...journalInputs,
        importedSummary,
        importedMarkdown,
        importedReason: batch.importedReason ?? null,
      },
      outputs: journalOutputs,
      decision: "started",
      codeRefs: ["scripts/run_btc_frontier_batch.ts"],
    });
    await writeOutputs(summaryOutput, markdownOutput, payload, renderImportMarkdown(payload));
    await appendExecutionJournal({
      runId,
      batchId: `batch${args.batch}`,
      stage: "batch",
      action: "import_prior_evidence",
      status: "imported",
      inputs: {
        ...journalInputs,
        importedSummary,
        importedMarkdown,
        importedReason: batch.importedReason ?? null,
      },
      outputs: journalOutputs,
      summaryMetrics: extractSummaryMetrics(importedPayload),
      decision: "imported",
      codeRefs: ["scripts/run_btc_frontier_batch.ts"],
      notes: [batch.description ?? ""].filter(Boolean),
    });
    console.log(`batch=${args.batch} | kind=${kind} | mode=imported | summary=${summaryOutput}`);
    return;
  }

  if (kind !== "full_sweep") {
    throw new Error(`Unsupported batch kind: ${batch.kind ?? "undefined"}`);
  }

  if (!args.force && (await exists(summaryOutput))) {
    console.log(`batch=${args.batch} | kind=${kind} | mode=existing | summary=${summaryOutput}`);
    return;
  }

  const searchJson = resolveRequiredPath(batch.searchJson, `batch ${args.batch} searchJson`);
  const baseManifest = resolve(
    batch.baseManifest ?? defaults.baseManifest ?? "",
  );
  if (!baseManifest || baseManifest === resolve(".")) {
    throw new Error(`Batch ${args.batch} is missing baseManifest.`);
  }

  const symbol = batch.symbol ?? defaults.symbol ?? "BTC/USD";
  const inputCsv = batch.inputCsv ?? defaults.inputCsv ?? "";
  const lookbackBars = batch.lookbackBars ?? defaults.lookbackBars ?? 3600;
  const protocolProfile = batch.protocolProfile ?? defaults.protocolProfile ?? "phaseb_native_v1";
  const multipleTestingUnit =
    batch.multipleTestingUnit ?? defaults.multipleTestingUnit ?? "candidate";
  const fdrMethod = batch.fdrMethod ?? defaults.fdrMethod ?? "bh";
  const wfoProfile = batch.wfoProfile ?? defaults.wfoProfile ?? "stable";
  const sourceId = batch.sourceId ?? `batch${args.batch}`;
  const sweepId = deriveSweepId(summaryOutput);

  const execArgs = [
    "--import",
    "tsx",
    "./scripts/run_phaseb_trial_sweep.ts",
    "--search-json",
    searchJson,
    "--base-manifest",
    baseManifest,
    "--sweep-id",
    sweepId,
    "--symbol",
    symbol,
    "--input-csv",
    inputCsv,
    "--lookback-bars",
    String(lookbackBars),
    "--protocol-profile",
    protocolProfile,
    "--multiple-testing-unit",
    multipleTestingUnit,
    "--fdr-method",
    fdrMethod,
    "--wfo-profile",
    wfoProfile,
    "--summary-output",
    summaryOutput,
    "--markdown-output",
    markdownOutput,
  ];
  if (Array.isArray(batch.trialList) && batch.trialList.length > 0) {
    execArgs.push("--trial-list", batch.trialList.join(","));
  }

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          batch: args.batch,
          kind,
          command: [process.execPath, ...execArgs],
        },
        null,
        2,
      ),
    );
    return;
  }

  await appendExecutionJournal({
    runId,
    batchId: `batch${args.batch}`,
    stage: "batch",
    action: "sweep",
    status: "started",
    inputs: {
      ...journalInputs,
      baseManifest,
      symbol,
      inputCsv,
      lookbackBars,
      protocolProfile,
      multipleTestingUnit,
      fdrMethod,
      wfoProfile,
      trialList: batch.trialList ?? null,
    },
    outputs: journalOutputs,
    decision: "started",
    codeRefs: ["scripts/run_btc_frontier_batch.ts", "scripts/run_phaseb_trial_sweep.ts"],
  });
  try {
    await execNode(execArgs);
    await appendExecutionJournal({
      runId,
      batchId: `batch${args.batch}`,
      stage: "batch",
      action: "sweep",
      status: "completed",
      inputs: {
        ...journalInputs,
        baseManifest,
        symbol,
        inputCsv,
        lookbackBars,
        protocolProfile,
        multipleTestingUnit,
        fdrMethod,
        wfoProfile,
        trialList: batch.trialList ?? null,
      },
      outputs: journalOutputs,
      summaryMetrics: extractSummaryMetrics(
        await readJsonIfExists<Record<string, unknown>>(summaryOutput),
      ),
      decision: "completed",
      codeRefs: ["scripts/run_btc_frontier_batch.ts", "scripts/run_phaseb_trial_sweep.ts"],
      notes: [batch.description ?? ""].filter(Boolean),
    });
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: `batch${args.batch}`,
      stage: "batch",
      action: "sweep",
      status: "failed",
      inputs: {
        ...journalInputs,
        baseManifest,
        symbol,
        inputCsv,
        lookbackBars,
        protocolProfile,
        multipleTestingUnit,
        fdrMethod,
        wfoProfile,
        trialList: batch.trialList ?? null,
      },
      outputs: journalOutputs,
      decision: "failed",
      codeRefs: ["scripts/run_btc_frontier_batch.ts", "scripts/run_phaseb_trial_sweep.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const registry = raw.get("registry");
  const batch = Number(raw.get("batch"));
  if (!registry) throw new Error("--registry is required.");
  if (!Number.isInteger(batch) || batch < 24 || batch > 40) {
    throw new Error("--batch must be an integer in [24, 40].");
  }
  return {
    registry,
    batch,
    dryRun: parseBool(raw.get("dry-run"), false),
    force: parseBool(raw.get("force"), false),
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
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

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function normalizeKind(value: string | undefined): BatchKind {
  if (value === "full_sweep" || value === "import_sweep" || value === "memo" || value === "pending") {
    return value;
  }
  return "pending";
}

function resolveRequiredPath(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new Error(`Missing ${label}.`);
  }
  return resolve(value);
}

function deriveSweepId(summaryOutput: string): string {
  const normalized = summaryOutput.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return base.replace(/\.json$/i, "");
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertExists(path: string, label: string): Promise<void> {
  if (!(await exists(path))) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

async function writeOutputs(
  summaryOutput: string,
  markdownOutput: string,
  payload: unknown,
  markdown: string,
): Promise<void> {
  await mkdir(dirname(summaryOutput), { recursive: true });
  await Promise.all([
    writeFile(summaryOutput, `${JSON.stringify(payload, null, 2)}\n`, "utf-8"),
    writeFile(markdownOutput, markdown, "utf-8"),
  ]);
}

function buildMemoPayload(input: {
  batch: number;
  kind: BatchKind;
  description: string;
  reason: string;
  status: "recorded" | "pending";
}) {
  return {
    schemaVersion: "btc_frontier_batch_result.v1",
    batch: input.batch,
    kind: input.kind,
    status: input.status,
    description: input.description,
    reason: input.reason,
  };
}

function renderMemoMarkdown(payload: ReturnType<typeof buildMemoPayload>): string {
  return [
    `# Batch ${payload.batch}`,
    "",
    `- kind: \`${payload.kind}\``,
    `- status: \`${payload.status}\``,
    `- reason: \`${payload.reason}\``,
    "",
    payload.description,
    "",
  ].join("\n");
}

function renderImportMarkdown(payload: {
  batch: number;
  kind: string;
  mode: string;
  importedReason: string;
  importedSummary: string;
  importedMarkdown: string;
}): string {
  return [
    `# Batch ${payload.batch}`,
    "",
    `- kind: \`${payload.kind}\``,
    `- mode: \`${payload.mode}\``,
    `- importedReason: \`${payload.importedReason}\``,
    `- importedSummary: \`${payload.importedSummary}\``,
    `- importedMarkdown: \`${payload.importedMarkdown}\``,
    "",
  ].join("\n");
}

async function execNode(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("exit", code => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed with exit code ${code ?? "unknown"}`));
    });
  });
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
