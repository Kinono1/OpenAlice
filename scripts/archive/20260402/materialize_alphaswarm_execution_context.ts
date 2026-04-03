import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";

interface ValidationRuns {
  aggregateMetrics?: {
    meanPbo?: number;
    meanDsrProbability?: number;
  };
  diagnostics?: {
    meanAverageAbsoluteCorrelation?: number;
  };
  config?: {
    costModel?: {
      slippageBps?: number;
      latencyBars?: number;
    };
  };
}

interface CliArgs {
  validationRuns: string;
  output: string;
  symbol: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `alphaswarm_context.${new Date().toISOString().replace(/[:.]/g, "")}`;
  await appendExecutionJournal({
    runId,
    batchId: "btc_paradigm_alphaswarm_context",
    stage: "compiler",
    action: "input_materialization",
    status: "started",
    inputs: {
      validationRuns: resolve(args.validationRuns),
      symbol: args.symbol,
    },
    outputs: {
      output: resolve(args.output),
    },
    decision: "started",
    codeRefs: ["scripts/materialize_alphaswarm_execution_context.ts"],
  });

  try {
    const payload = JSON.parse(
      await readFile(resolve(args.validationRuns), "utf-8"),
    ) as ValidationRuns;
    const meanPbo = Number(payload.aggregateMetrics?.meanPbo ?? 0.5);
    const meanDsr = Number(payload.aggregateMetrics?.meanDsrProbability ?? 0.5);
    const correlation = Number(payload.diagnostics?.meanAverageAbsoluteCorrelation ?? 0.5);
    const slippageBps = Number(payload.config?.costModel?.slippageBps ?? 3);
    const latencyBars = Number(payload.config?.costModel?.latencyBars ?? 1);

    const context = {
      schemaVersion: "alphaswarm_execution_context.v1",
      generatedAt: new Date().toISOString(),
      symbol: args.symbol,
      venueDispersionPct: Number(Math.max(0.05, Math.min(0.95, correlation)).toFixed(4)),
      routingFrictionBps: Number((slippageBps * 1.5).toFixed(4)),
      liquidityScore: Number(Math.max(0.05, Math.min(0.95, meanDsr)).toFixed(4)),
      latencyScore: Number(Math.max(0.05, Math.min(0.95, 1 / (latencyBars + 1))).toFixed(4)),
      onChainCongestionScore: Number(Math.max(0.05, Math.min(0.95, meanPbo)).toFixed(4))
    };

    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(resolve(args.output), `${JSON.stringify(context, null, 2)}\n`, "utf-8");
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_alphaswarm_context",
      stage: "compiler",
      action: "input_materialization",
      status: "completed",
      inputs: {
        validationRuns: resolve(args.validationRuns),
      },
      outputs: {
        output: resolve(args.output),
      },
      decision: "completed",
      codeRefs: ["scripts/materialize_alphaswarm_execution_context.ts"],
    });
    console.log(`output=${resolve(args.output)}`);
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_alphaswarm_context",
      stage: "compiler",
      action: "input_materialization",
      status: "failed",
      inputs: {
        validationRuns: resolve(args.validationRuns),
      },
      outputs: {
        output: resolve(args.output),
      },
      decision: "failed",
      codeRefs: ["scripts/materialize_alphaswarm_execution_context.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const validationRuns = raw.get("validation-runs");
  const output = raw.get("output");
  if (!validationRuns) throw new Error("--validation-runs is required.");
  if (!output) throw new Error("--output is required.");
  return {
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

