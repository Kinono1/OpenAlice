import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";

interface StrictRequest {
  payload: {
    symbol: string;
    marketContext: {
      lookbackBars: number;
      windowStart: string;
      windowEnd: string;
      candles: Array<{
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }>;
    };
    newsContext: {
      items: unknown[];
    };
    decisionContext: {
      releaseGateMode?: string;
    };
  };
}

interface CliArgs {
  request: string;
  output: string;
  fallbackReason: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `tradingagents_proxy.${new Date().toISOString().replace(/[:.]/g, "")}`;
  await appendExecutionJournal({
    runId,
    batchId: "btc_paradigm_tradingagents_proxy",
    stage: "research_sidecar",
    action: "proxy_sidecar",
    status: "started",
    inputs: {
      request: resolve(args.request),
      fallbackReason: args.fallbackReason,
    },
    outputs: {
      output: resolve(args.output),
    },
    decision: "started",
    codeRefs: ["scripts/materialize_tradingagents_proxy_decision.ts"],
  });

  try {
    const request = JSON.parse(await readFile(resolve(args.request), "utf-8")) as StrictRequest;
    const candles = request.payload.marketContext.candles;
    if (!Array.isArray(candles) || candles.length < 2) {
      throw new Error("Strict request must contain at least 2 candles.");
    }

    const first = candles[0];
    const last = candles[candles.length - 1];
    const closes = candles.map(item => item.close);
    const highs = candles.map(item => item.high);
    const lows = candles.map(item => item.low);
    const startClose = first.close;
    const endClose = last.close;
    const returnPct = (endClose - startClose) / Math.max(startClose, 1);
    const rangePct =
      (Math.max(...highs) - Math.min(...lows)) / Math.max(Math.min(...lows), 1);
    const driftScore = returnPct / Math.max(rangePct, 0.0001);

    let action: "long" | "flat" = "flat";
    let signal = 0;
    if (driftScore > 0.12) {
      action = "long";
      signal = 1;
    } else if (driftScore < -0.12) {
      action = "flat";
      signal = -1;
    }
    const confidence = Number(Math.max(0.35, Math.min(0.8, Math.abs(driftScore))).toFixed(4));
    const decision = {
      schemaVersion: "research_decision.v1",
      generatedAt: new Date().toISOString(),
      symbol: request.payload.symbol,
      decisionContext: {
        releaseGateMode: request.payload.decisionContext.releaseGateMode ?? "paper",
      },
      marketContext: {
        lookbackBars: request.payload.marketContext.lookbackBars,
        windowStart: request.payload.marketContext.windowStart,
        windowEnd: request.payload.marketContext.windowEnd,
      },
      provenance: {
        producer: "tradingagents.sidecar.local_proxy",
        mode: "sidecar_proxy",
        fallbackReason: args.fallbackReason,
        proxySource: "local_market_proxy",
        evidenceStrength: "proxy",
      },
      strategy: {
        signal,
        reason: `Local TradingAgents proxy derived from ${candles.length} BTC candles, returnPct=${returnPct.toFixed(4)}, rangePct=${rangePct.toFixed(4)}, driftScore=${driftScore.toFixed(4)}.`,
        selectedStrategy: "tradingagents_sidecar_proxy",
        selectorMode: "external_sidecar_proxy",
        selectorReason: "local_market_proxy",
      },
      ml: {
        available: false,
        direction: action === "long" ? "long" : "hold",
        actionable: action === "long",
        error: "proxy_decision_without_llm_runtime",
      },
      news: {
        totalNews: Array.isArray(request.payload.newsContext.items)
          ? request.payload.newsContext.items.length
          : 0,
        positiveNews: 0,
        negativeNews: 0,
        neutralNews: Array.isArray(request.payload.newsContext.items)
          ? request.payload.newsContext.items.length
          : 0,
        highRiskNews: 0,
        sentimentScore: 0,
        riskScore: Number(Math.max(0.05, Math.min(0.95, rangePct)).toFixed(4)),
        topThemes: [],
        flags: [],
        latestHeadlines: [],
      },
      releaseGate: null,
      decision: {
        action,
        confidence,
        tradeAllowed: action === "long",
        blockedBy: action === "long" ? [] : ["proxy_sidecar_no_high_conviction_long"],
        reasons: [
          "TradingAgents live sidecar was unavailable or too slow for the current session.",
          "This proxy preserves the same decision contract while using deterministic local market state.",
        ],
        suggestedExposurePct: action === "long" ? Math.round(confidence * 25) : 0,
      },
    };

    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(resolve(args.output), `${JSON.stringify(decision, null, 2)}\n`, "utf-8");
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_tradingagents_proxy",
      stage: "research_sidecar",
      action: "proxy_sidecar",
      status: "completed",
      inputs: {
        request: resolve(args.request),
        fallbackReason: args.fallbackReason,
      },
      outputs: {
        output: resolve(args.output),
      },
      decision: "completed",
      codeRefs: ["scripts/materialize_tradingagents_proxy_decision.ts"],
      notes: [`action=${action}`, `confidence=${confidence}`],
    });
    console.log(`output=${resolve(args.output)} | action=${action} | confidence=${confidence}`);
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_tradingagents_proxy",
      stage: "research_sidecar",
      action: "proxy_sidecar",
      status: "failed",
      inputs: {
        request: resolve(args.request),
      },
      outputs: {
        output: resolve(args.output),
      },
      decision: "failed",
      codeRefs: ["scripts/materialize_tradingagents_proxy_decision.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const request = raw.get("request");
  const output = raw.get("output");
  if (!request) throw new Error("--request is required.");
  if (!output) throw new Error("--output is required.");
  return {
    request,
    output,
    fallbackReason:
      raw.get("fallback-reason") ??
      "tradingagents_live_sidecar_timeout_or_runtime_unavailable",
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
