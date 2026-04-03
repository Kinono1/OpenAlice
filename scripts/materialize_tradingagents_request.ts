import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";

interface CandleRow {
  timestamp: string;
  iso: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface CliArgs {
  inputCsv: string;
  output: string;
  lookbackBars: number;
  symbol: string;
  sourceId: string;
  selectedAnalysts: string[];
  researchDepth: number;
  releaseGateMode: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `tradingagents_request.${new Date().toISOString().replace(/[:.]/g, "")}`;
  await appendExecutionJournal({
    runId,
    batchId: "btc_paradigm_tradingagents_request",
    stage: "compiler",
    action: "input_materialization",
    status: "started",
    inputs: {
      inputCsv: resolve(args.inputCsv),
      symbol: args.symbol,
      lookbackBars: args.lookbackBars,
      selectedAnalysts: args.selectedAnalysts,
      researchDepth: args.researchDepth,
      releaseGateMode: args.releaseGateMode,
    },
    outputs: {
      request: resolve(args.output),
    },
    decision: "started",
    codeRefs: ["scripts/materialize_tradingagents_request.ts"],
  });

  try {
    const candles = await readCandles(args.inputCsv, args.lookbackBars);
    if (candles.length < 1) {
      throw new Error(`No candles available in ${args.inputCsv}`);
    }
    const windowStart = candles[0].iso;
    const windowEnd = candles[candles.length - 1].iso;
    const payload = {
      symbol: args.symbol,
      marketContext: {
        lookbackBars: candles.length,
        windowStart,
        windowEnd,
        candles: candles.map((row) => ({
          timestamp: row.iso,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
        })),
      },
      newsContext: {
        items: [],
      },
      decisionContext: {
        selectedAnalysts: args.selectedAnalysts,
        researchDepth: args.researchDepth,
        releaseGateMode: args.releaseGateMode,
      },
    };
    const generatedAt = new Date().toISOString();
    const request = {
      schemaVersion: "tradingagents_sidecar_request.v1",
      requestMeta: {
        schemaVersion: "tradingagents_sidecar_request.v1",
        requestId: `btc-ta-request-${Date.now()}`,
        sidecarRunId: `btc-ta-run-${Date.now()}`,
        sourceId: args.sourceId,
        generatedAt,
        inputHash: computePayloadHash(payload),
      },
      payload,
    };

    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(resolve(args.output), `${JSON.stringify(request, null, 2)}\n`, "utf-8");
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_tradingagents_request",
      stage: "compiler",
      action: "input_materialization",
      status: "completed",
      inputs: {
        inputCsv: resolve(args.inputCsv),
        symbol: args.symbol,
        lookbackBars: args.lookbackBars,
      },
      outputs: {
        request: resolve(args.output),
      },
      decision: "completed",
      codeRefs: ["scripts/materialize_tradingagents_request.ts"],
      notes: [`windowEnd=${windowEnd}`],
    });
    console.log(
      [
        `request=${resolve(args.output)}`,
        `candles=${candles.length}`,
        `windowEnd=${windowEnd}`,
      ].join(" | "),
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_tradingagents_request",
      stage: "compiler",
      action: "input_materialization",
      status: "failed",
      inputs: {
        inputCsv: resolve(args.inputCsv),
        symbol: args.symbol,
      },
      outputs: {
        request: resolve(args.output),
      },
      decision: "failed",
      codeRefs: ["scripts/materialize_tradingagents_request.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

async function readCandles(path: string, lookbackBars: number): Promise<CandleRow[]> {
  const raw = await readFile(resolve(path), "utf-8");
  const lines = raw.trim().split("\n");
  const [header, ...rows] = lines;
  if (!header) return [];
  const keys = header.split(",");
  return rows
    .slice(Math.max(0, rows.length - lookbackBars))
    .map((line) => {
      const values = line.split(",");
      const row = Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ""])) as Record<
        string,
        string
      >;
      return row as unknown as CandleRow;
    })
    .filter((row) => row.iso);
}

function computePayloadHash(payload: unknown): string {
  const canonical = stableStringify(payload);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const inputCsv = raw.get("input-csv");
  const output = raw.get("output");
  if (!inputCsv) throw new Error("--input-csv is required.");
  if (!output) throw new Error("--output is required.");
  const lookbackBars = Number(raw.get("lookback-bars") ?? 240);
  return {
    inputCsv,
    output,
    lookbackBars: Number.isInteger(lookbackBars) && lookbackBars > 0 ? lookbackBars : 240,
    symbol: raw.get("symbol") ?? "BTC/USD",
    sourceId: raw.get("source-id") ?? "openalice_local_market_context",
    selectedAnalysts: (raw.get("selected-analysts") ?? "market")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean),
    researchDepth: Math.max(0, Number(raw.get("research-depth") ?? 0)),
    releaseGateMode: raw.get("release-gate-mode") ?? "paper",
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
