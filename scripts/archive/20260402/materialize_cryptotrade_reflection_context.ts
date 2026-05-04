import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";

interface VerdictPayload {
  reasonCodes?: string[];
  aggregateMetrics?: {
    meanPbo?: number;
    meanDsrProbability?: number;
    fdrQ?: number;
  };
  champion?: {
    strategy?: string;
  } | null;
}

interface ValidationRunsPayload {
  diagnostics?: {
    meanAverageAbsoluteCorrelation?: number;
  };
  champion?: {
    strategy?: string;
  } | null;
}

interface CliArgs {
  verdict: string;
  validationRuns: string;
  output: string;
  symbol: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `cryptotrade_context.${new Date().toISOString().replace(/[:.]/g, "")}`;
  await appendExecutionJournal({
    runId,
    batchId: "btc_paradigm_cryptotrade_context",
    stage: "compiler",
    action: "input_materialization",
    status: "started",
    inputs: {
      verdict: resolve(args.verdict),
      validationRuns: resolve(args.validationRuns),
      symbol: args.symbol,
    },
    outputs: {
      output: resolve(args.output),
    },
    decision: "started",
    codeRefs: ["scripts/materialize_cryptotrade_reflection_context.ts"],
  });

  try {
    const verdict = JSON.parse(
      await readFile(resolve(args.verdict), "utf-8"),
    ) as VerdictPayload;
    const validationRuns = JSON.parse(
      await readFile(resolve(args.validationRuns), "utf-8"),
    ) as ValidationRunsPayload;

    const reasons = Array.isArray(verdict.reasonCodes) ? verdict.reasonCodes : [];
    const meanPbo = Number(verdict.aggregateMetrics?.meanPbo ?? 0.5);
    const meanDsr = Number(verdict.aggregateMetrics?.meanDsrProbability ?? 0.5);
    const fdrQ = Number(verdict.aggregateMetrics?.fdrQ ?? 1);
    const disagreementScore = Number(
      Math.max(
        0.05,
        Math.min(0.95, Number(validationRuns.diagnostics?.meanAverageAbsoluteCorrelation ?? 0.5)),
      ).toFixed(4),
    );

    const narrativeState =
      reasons.some(code => code.includes("DSR")) ? "bearish" :
      reasons.some(code => code.includes("FDR")) ? "mixed" :
      meanDsr > 0.55 ? "bullish" : "neutral";

    const reflection = {
      schemaVersion: "cryptotrade_reflection_context.v1",
      generatedAt: new Date().toISOString(),
      symbol: args.symbol,
      baselineSignal:
        validationRuns.champion?.strategy === "trend" || verdict.champion?.strategy === "trend"
          ? 1
          : 0,
      narrativeState,
      disagreementScore,
      recentFailureRate: Number(Math.max(0.05, Math.min(0.95, fdrQ)).toFixed(4)),
      newsSentimentScore: Number(Math.max(-1, Math.min(1, meanDsr - meanPbo)).toFixed(4)),
      riskScore: Number(Math.max(0.05, Math.min(0.95, meanPbo)).toFixed(4))
    };

    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(resolve(args.output), `${JSON.stringify(reflection, null, 2)}\n`, "utf-8");
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_cryptotrade_context",
      stage: "compiler",
      action: "input_materialization",
      status: "completed",
      inputs: {
        verdict: resolve(args.verdict),
        validationRuns: resolve(args.validationRuns),
      },
      outputs: {
        output: resolve(args.output),
      },
      decision: "completed",
      codeRefs: ["scripts/materialize_cryptotrade_reflection_context.ts"],
    });
    console.log(`output=${resolve(args.output)}`);
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_cryptotrade_context",
      stage: "compiler",
      action: "input_materialization",
      status: "failed",
      inputs: {
        verdict: resolve(args.verdict),
        validationRuns: resolve(args.validationRuns),
      },
      outputs: {
        output: resolve(args.output),
      },
      decision: "failed",
      codeRefs: ["scripts/materialize_cryptotrade_reflection_context.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const verdict = raw.get("verdict");
  const validationRuns = raw.get("validation-runs");
  const output = raw.get("output");
  if (!verdict) throw new Error("--verdict is required.");
  if (!validationRuns) throw new Error("--validation-runs is required.");
  if (!output) throw new Error("--output is required.");
  return {
    verdict,
    validationRuns,
    output,
    symbol: raw.get("symbol") ?? "BTC/USD",
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
