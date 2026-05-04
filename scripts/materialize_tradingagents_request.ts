import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";
import {
  readCandles,
  readNewsItems,
} from "./lib/tradingagents_request.js";

interface CliArgs {
  dryRun: boolean;
  inputCsv: string;
  output: string;
  lookbackBars: number;
  symbol: string;
  sourceId: string;
  selectedAnalysts: string[];
  researchDepth: number;
  releaseGateMode: string;
  newsJson?: string;
  windowStart?: string;
  windowEnd?: string;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: "tradingagents_request",
      command: "materialize_tradingagents_request",
      executionMode: {
        dryRun: true,
        writesExecutionJournal: false,
        readsInputCsv: false,
        readsNewsJson: false,
        writesRequestArtifact: false,
        promotionEligible: false,
      },
      output: args.output || null,
      optIn: {
        materializeRequest: "--dryRun false",
      },
    }, null, 2));
    return;
  }

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
      newsJson: args.newsJson ? resolve(args.newsJson) : null,
      windowStart: args.windowStart ?? null,
      windowEnd: args.windowEnd ?? null,
    },
    outputs: {
      request: resolve(args.output),
    },
    decision: "started",
    codeRefs: ["scripts/materialize_tradingagents_request.ts"],
  });

  try {
    const candles = await readCandles(args.inputCsv, {
      lookbackBars: args.lookbackBars,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
    });
    if (candles.length < 1) {
      throw new Error(
        `No candles available in ${args.inputCsv} for requested strict window.`,
      );
    }
    const newsItems = await readNewsItems(args.newsJson);
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
        items: newsItems,
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
  const dryRun = parseBoolArg(raw.get("dryRun"), true);
  const inputCsv = raw.get("input-csv");
  const output = raw.get("output");
  if (!dryRun) {
    if (!inputCsv) throw new Error("--input-csv is required.");
    if (!output) throw new Error("--output is required.");
  }
  const lookbackBars = Number(raw.get("lookback-bars") ?? 240);
  return {
    dryRun,
    inputCsv: inputCsv ?? "",
    output: output ?? "",
    lookbackBars: Number.isInteger(lookbackBars) && lookbackBars > 0 ? lookbackBars : 240,
    symbol: raw.get("symbol") ?? "BTC/USD",
    sourceId: raw.get("source-id") ?? "openalice_local_market_context",
    selectedAnalysts: (raw.get("selected-analysts") ?? "market")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean),
    researchDepth: Math.max(0, Number(raw.get("research-depth") ?? 0)),
    releaseGateMode: raw.get("release-gate-mode") ?? "paper",
    newsJson: raw.get("news-json"),
    windowStart: raw.get("window-start"),
    windowEnd: raw.get("window-end"),
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const withoutPrefix = token.slice(2);
    const eq = withoutPrefix.indexOf("=");
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1));
      continue;
    }
    const key = withoutPrefix;
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

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
};
