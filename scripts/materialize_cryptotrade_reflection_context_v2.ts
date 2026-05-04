import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";

interface CliArgs {
  symbol: string;
  output: string;
  journalPath: string;
  lookbackCycles: number;
  lookbackBars: number;
}

interface JournalEntry {
  timestamp?: string;
  action?: string;
  status?: string;
  decision?: string | null;
  summaryMetrics?: {
    totalGap?: number | null;
    meanSharpe?: number | null;
    meanPbo?: number | null;
    meanAverageAbsoluteCorrelation?: number | null;
  };
  notes?: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `cryptotrade_v2_ctx.${new Date().toISOString().replace(/[:.]/g, "")}`;
  await appendExecutionJournal({
    runId,
    batchId: "btc_paradigm_cryptotrade_v2_context",
    stage: "compiler",
    action: "input_materialization",
    status: "started",
    inputs: { symbol: args.symbol, journalPath: resolve(args.journalPath) },
    outputs: { output: resolve(args.output) },
    decision: "started",
    codeRefs: ["scripts/materialize_cryptotrade_reflection_context_v2.ts"],
  });

  try {
    const entries = await readJournalEntries(args.journalPath);
    const minSample = 5;

    // Dimension 1: recentDirectionalOutcome
    const recentDecisions = entries
      .filter(e => e.action === "paradigm_comparison" || e.action === "sidecar" || e.action === "proxy_sidecar")
      .slice(-args.lookbackCycles);
    const directionalOutcome = computeDirectionalOutcome(recentDecisions, minSample);

    // Dimension 2: signalDisagreement
    const correlationEntries = entries
      .filter(e => e.summaryMetrics?.meanAverageAbsoluteCorrelation != null)
      .slice(-args.lookbackBars);
    const signalDisagreement = computeDisagreement(correlationEntries, minSample);

    // Dimension 3: failurePatternMemory
    const recentFailures = entries
      .filter(e => e.status === "failed" || e.decision === "stop" || e.decision === "failed")
      .slice(-args.lookbackCycles);
    const failureMemory = computeFailureMemory(recentFailures, args.lookbackCycles, minSample);

    const dimensions = { directionalOutcome, signalDisagreement, failureMemory };
    const insufficientCount = Object.values(dimensions).filter(v => v === null).length;

    if (insufficientCount >= 2) {
      const unavailable = {
        schemaVersion: "cryptotrade_reflection_context.v2",
        generatedAt: new Date().toISOString(),
        symbol: args.symbol,
        status: "unavailable",
        reason: "insufficient_journal_history",
        dimensionStatus: {
          recentDirectionalOutcome: directionalOutcome !== null ? "ok" : "insufficient",
          signalDisagreement: signalDisagreement !== null ? "ok" : "insufficient",
          failurePatternMemory: failureMemory !== null ? "ok" : "insufficient",
        },
        provenance: {
          producer: "cryptotrade.context.openalice_history_proxy",
          reflectionSource: "openalice_paper_history",
          evidenceStrength: "unavailable",
          generation: "v2_external_context",
          note: "Not donor-native. Derived from OpenAlice paper trade history, not CryptoTrade reflective agent.",
        },
      };
      await mkdir(dirname(resolve(args.output)), { recursive: true });
      await writeFile(resolve(args.output), `${JSON.stringify(unavailable, null, 2)}\n`, "utf-8");
      await appendExecutionJournal({
        runId,
        batchId: "btc_paradigm_cryptotrade_v2_context",
        stage: "compiler",
        action: "input_materialization",
        status: "completed",
        inputs: { symbol: args.symbol },
        outputs: { output: resolve(args.output) },
        decision: "unavailable",
        codeRefs: ["scripts/materialize_cryptotrade_reflection_context_v2.ts"],
        notes: [`insufficientCount=${insufficientCount}/3`],
      });
      console.log(`output=${resolve(args.output)} | status=unavailable | insufficient=${insufficientCount}/3`);
      return;
    }

    const context = {
      schemaVersion: "cryptotrade_reflection_context.v2",
      generatedAt: new Date().toISOString(),
      symbol: args.symbol,
      recentDirectionalOutcome: directionalOutcome,
      signalDisagreement: signalDisagreement,
      failurePatternMemory: failureMemory,
      provenance: {
        producer: "cryptotrade.context.openalice_history_proxy",
        reflectionSource: "openalice_paper_history",
        evidenceStrength: "internal_history",
        generation: "v2_external_context",
        note: "Not donor-native. Derived from OpenAlice paper trade history, not CryptoTrade reflective agent.",
        sampleSizes: {
          recentDecisions: recentDecisions.length,
          correlationEntries: correlationEntries.length,
          recentFailures: recentFailures.length,
        },
      },
    };

    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(resolve(args.output), `${JSON.stringify(context, null, 2)}\n`, "utf-8");
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_cryptotrade_v2_context",
      stage: "compiler",
      action: "input_materialization",
      status: "completed",
      inputs: { symbol: args.symbol },
      outputs: { output: resolve(args.output) },
      decision: "completed",
      codeRefs: ["scripts/materialize_cryptotrade_reflection_context_v2.ts"],
    });
    console.log(`output=${resolve(args.output)} | dimensions=3`);
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_cryptotrade_v2_context",
      stage: "compiler",
      action: "input_materialization",
      status: "failed",
      inputs: { symbol: args.symbol },
      outputs: { output: resolve(args.output) },
      decision: "failed",
      codeRefs: ["scripts/materialize_cryptotrade_reflection_context_v2.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

async function readJournalEntries(journalPath: string): Promise<JournalEntry[]> {
  try {
    const raw = await readFile(resolve(journalPath), "utf-8");
    return raw.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
      try { return JSON.parse(line) as JournalEntry; } catch { return null; }
    }).filter((e): e is JournalEntry => e !== null);
  } catch {
    return [];
  }
}

function computeDirectionalOutcome(entries: JournalEntry[], minSample: number): "bullish" | "bearish" | "neutral" | null {
  if (entries.length < minSample) return null;
  let positive = 0;
  let negative = 0;
  for (const e of entries) {
    const sharpe = e.summaryMetrics?.meanSharpe;
    const gap = e.summaryMetrics?.totalGap;
    if (sharpe != null && sharpe > 0) positive++;
    else if (gap != null && gap < 0.5) positive++;
    else if (sharpe != null && sharpe < 0) negative++;
    else if (gap != null && gap > 1.5) negative++;
  }
  const total = positive + negative;
  if (total < minSample) return "neutral";
  if (positive > negative * 1.5) return "bullish";
  if (negative > positive * 1.5) return "bearish";
  return "neutral";
}

function computeDisagreement(entries: JournalEntry[], minSample: number): number | null {
  if (entries.length < minSample) return null;
  const correlations = entries
    .map(e => e.summaryMetrics?.meanAverageAbsoluteCorrelation)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (correlations.length < minSample) return null;
  const avgCorr = correlations.reduce((a, b) => a + b, 0) / correlations.length;
  return Number(clamp(1 - avgCorr, 0.05, 0.95).toFixed(4));
}

function computeFailureMemory(failures: JournalEntry[], window: number, minSample: number): number | null {
  if (window < minSample) return null;
  if (failures.length === 0 && window >= minSample) return 0.05;
  const rate = clamp(failures.length / Math.max(window, 1), 0.05, 0.95);
  return Number(rate.toFixed(4));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const output = raw.get("output");
  if (!output) throw new Error("--output is required.");
  return {
    symbol: raw.get("symbol") ?? "BTC/USD",
    output,
    journalPath: raw.get("journal-path") ?? "data/research/strategy/execution_journal.jsonl",
    lookbackCycles: Math.max(5, Number(raw.get("lookback-cycles") ?? 20)),
    lookbackBars: Math.max(10, Number(raw.get("lookback-bars") ?? 48)),
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) { out.set(key, "true"); continue; }
    out.set(key, next);
    index += 1;
  }
  return out;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
