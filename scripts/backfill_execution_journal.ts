import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  appendExecutionJournal,
  extractSummaryMetrics,
  loadExistingJournalRunIds,
  readJsonIfExists,
  type ExecutionJournalEntry,
  type JournalStatus,
} from "./lib/execution_journal.js";

interface CliArgs {
  journalPath?: string;
}

interface RegistryBatch {
  batch?: number;
  id?: number;
  kind?: string;
  description?: string;
  searchJson?: string;
  sourceId?: string;
  summaryOutput?: string;
  markdownOutput?: string;
  importedSummary?: string;
  importedMarkdown?: string;
  importedReason?: string;
}

interface RegistryPayload {
  batches?: RegistryBatch[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const existingRunIds = await loadExistingJournalRunIds(args.journalPath);
  const entries = await buildBackfillEntries();
  let appended = 0;
  for (const entry of entries) {
    if (existingRunIds.has(entry.runId)) {
      continue;
    }
    await appendExecutionJournal(entry, args.journalPath);
    appended += 1;
  }
  console.log(`backfill_entries_appended=${appended}`);
}

async function buildBackfillEntries(): Promise<ExecutionJournalEntry[]> {
  const entries: ExecutionJournalEntry[] = [];

  entries.push(
    await buildRouteBackfill({
      batchId: "batch21",
      tag: "route_batch21_btc_regime_source.v1",
      notePath: "docs/research/strategy_route_batch21_20260330.md",
      candidatesPath:
        "docs/research/strategy_candidates.route_batch21_btc_regime_source.v1.json",
      sourceId: "btc_structured_source_regime_filter",
      protocolProfile: "phaseb_native_v1",
      codeRefs: [
        "scripts/materialize_structured_source_family_manifest.ts",
        "scripts/run_route_af.ts",
      ],
    }),
  );

  entries.push(
    await buildRouteBackfill({
      batchId: "batch22",
      tag: "route_batch22_btc_source_grid.v1",
      notePath: "docs/research/strategy_route_batch22_20260331.md",
      candidatesPath:
        "docs/research/strategy_candidates.route_batch22_btc_source_grid.v1.json",
      sourceId: "btc_batch22_source_grid",
      protocolProfile: "phaseb_native_v1",
      codeRefs: [
        "scripts/materialize_btc_batch22_candidate_grid.ts",
        "scripts/run_route_af.ts",
      ],
    }),
  );

  entries.push(
    await buildSummaryBackfill({
      runId: "backfill.batch23",
      batchId: "batch23",
      stage: "batch",
      action: "sweep",
      status: "completed",
      decision: "failed",
      description:
        "Full phaseb-r3 BTC sweep established richer upstream search exhaustion under the fixed native policy.",
      inputs: {
        searchJson:
          "data/research/strategy/analysis/g3g4/archive/phaseb-r3/phaseb_family_search.json",
        baseManifest:
          "docs/research/strategy_candidates.route_batch15_btc_phaseb_neighborhood_base.v1.json",
        notePath: "docs/research/strategy_route_batch23_20260331.md",
      },
      outputs: {
        summary:
          "data/research/strategy/analysis/phaseb_r3_btc_native_full_20260331.json",
        markdown:
          "data/research/strategy/analysis/phaseb_r3_btc_native_full_20260331.md",
      },
      summaryPath:
        "data/research/strategy/analysis/phaseb_r3_btc_native_full_20260331.json",
      codeRefs: ["scripts/run_phaseb_trial_sweep.ts", "scripts/run_route_af.ts"],
    }),
  );

  const registry = await readJson<
    RegistryPayload
  >("docs/research/btc_frontier_batch_registry_24_40.v1.json");
  for (const batch of registry.batches ?? []) {
    const batchNumber = batch.batch ?? batch.id;
    if (!Number.isInteger(batchNumber) || batchNumber < 24 || batchNumber > 40) {
      continue;
    }

    const kind = batch.kind ?? "pending";
    if (kind === "full_sweep") {
      entries.push(
        await buildSummaryBackfill({
          runId: `backfill.batch${batchNumber}`,
          batchId: `batch${batchNumber}`,
          stage: "batch",
          action: "sweep",
          status: "completed",
          decision: "failed",
          description: batch.description ?? "",
          inputs: {
            searchJson: batch.searchJson ?? null,
            sourceId: batch.sourceId ?? null,
            registry:
              "docs/research/btc_frontier_batch_registry_24_40.v1.json",
          },
          outputs: {
            summary: batch.summaryOutput ?? null,
            markdown: batch.markdownOutput ?? null,
          },
          summaryPath: batch.summaryOutput ?? null,
          codeRefs: ["scripts/run_btc_frontier_batch.ts", "scripts/run_phaseb_trial_sweep.ts"],
        }),
      );
      continue;
    }

    if (kind === "import_sweep") {
      const importedPayload = await readJsonIfExists<Record<string, unknown>>(
        batch.importedSummary,
      );
      entries.push({
        runId: `backfill.batch${batchNumber}`,
        batchId: `batch${batchNumber}`,
        stage: "batch",
        action: "import_prior_evidence",
        status: "imported",
        decision: "imported",
        backfilled: true,
        inputs: {
          importedSummary: batch.importedSummary ?? null,
          importedMarkdown: batch.importedMarkdown ?? null,
          reason: batch.importedReason ?? null,
          registry:
            "docs/research/btc_frontier_batch_registry_24_40.v1.json",
        },
        outputs: {
          summary: batch.summaryOutput ?? null,
          markdown: batch.markdownOutput ?? null,
        },
        summaryMetrics: extractSummaryMetrics(importedPayload),
        codeRefs: ["scripts/run_btc_frontier_batch.ts"],
        notes: [batch.description ?? ""].filter(Boolean),
      });
      continue;
    }

    if (kind === "memo") {
      entries.push({
        runId: `backfill.batch${batchNumber}`,
        batchId: `batch${batchNumber}`,
        stage: "batch",
        action: "memo",
        status: "completed",
        decision: "recorded",
        backfilled: true,
        inputs: {
          reason: batch.importedReason ?? null,
          registry:
            "docs/research/btc_frontier_batch_registry_24_40.v1.json",
        },
        outputs: {
          summary: batch.summaryOutput ?? null,
          markdown: batch.markdownOutput ?? null,
        },
        summaryMetrics: extractSummaryMetrics(
          await readJsonIfExists<Record<string, unknown>>(batch.summaryOutput),
        ),
        codeRefs: ["scripts/run_btc_frontier_batch.ts"],
        notes: [batch.description ?? ""].filter(Boolean),
      });
      continue;
    }

    entries.push({
      runId: `backfill.batch${batchNumber}`,
      batchId: `batch${batchNumber}`,
      stage: "batch",
      action: "frontier_decision",
      status: "not_activated",
      decision: "not_activated",
      backfilled: true,
      inputs: {
        reason: batch.importedReason ?? null,
        registry:
          "docs/research/btc_frontier_batch_registry_24_40.v1.json",
      },
      outputs: {
        summary: batch.summaryOutput ?? null,
        markdown: batch.markdownOutput ?? null,
      },
      summaryMetrics: extractSummaryMetrics(
        await readJsonIfExists<Record<string, unknown>>(batch.summaryOutput),
      ),
      codeRefs: ["scripts/run_btc_frontier_batch.ts"],
      notes: [batch.description ?? ""].filter(Boolean),
    });
  }

  return entries;
}

async function buildRouteBackfill(input: {
  batchId: string;
  tag: string;
  notePath: string;
  candidatesPath: string;
  sourceId: string;
  protocolProfile: string;
  codeRefs: string[];
}): Promise<ExecutionJournalEntry> {
  const verdictPath = `data/research/strategy/experiment_verdict.${input.tag}.json`;
  const statusPath = `data/runtime/route_af_status.${input.tag.replace(/\.v1$/, "")}.latest.json`;
  const validationPath = `data/research/strategy/strategy_validation_runs.${input.tag}.json`;
  const verdict = await readJsonIfExists<Record<string, unknown>>(verdictPath);
  return {
    runId: `backfill.${input.batchId}`,
    batchId: input.batchId,
    stage: "route",
    action: "route",
    status: "completed",
    decision: verdict?.result === "GO" ? "promoted_to_route" : "failed",
    backfilled: true,
    inputs: {
      candidates: input.candidatesPath,
      sourceId: input.sourceId,
      protocolProfile: input.protocolProfile,
      notePath: input.notePath,
    },
    outputs: {
      validationRuns: validationPath,
      verdict: verdictPath,
      status: statusPath,
      phaseReadiness: `data/runtime/phase_readiness.${input.tag}.json`,
    },
    summaryMetrics: extractSummaryMetrics(verdict),
    codeRefs: input.codeRefs,
  };
}

async function buildSummaryBackfill(input: {
  runId: string;
  batchId: string;
  stage: string;
  action: string;
  status: JournalStatus;
  decision: string;
  description: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  summaryPath: string | null | undefined;
  codeRefs: string[];
}): Promise<ExecutionJournalEntry> {
  const payload = await readJsonIfExists<Record<string, unknown>>(input.summaryPath);
  return {
    runId: input.runId,
    batchId: input.batchId,
    stage: input.stage,
    action: input.action,
    status: input.status,
    decision: input.decision,
    backfilled: true,
    inputs: input.inputs,
    outputs: input.outputs,
    summaryMetrics: extractSummaryMetrics(payload),
    codeRefs: input.codeRefs,
    notes: [input.description].filter(Boolean),
  };
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  return {
    journalPath: raw.get("journal-path"),
  };
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

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
