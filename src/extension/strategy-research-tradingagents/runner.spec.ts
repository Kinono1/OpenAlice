import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TradingAgentsSidecarRunError,
  TradingAgentsSidecarRunner,
} from "./runner.js";
import {
  computeTradingAgentsRequestInputHash,
  type TradingAgentsStrictResearchRequest,
} from "./types.js";

const createdDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "openalice-ta-runner-"));
  createdDirs.push(dir);
  return dir;
}

function makeRequest(): TradingAgentsStrictResearchRequest {
  const payload = {
    symbol: "BTC/USD",
    marketContext: {
      lookbackBars: 240,
      windowStart: "2026-03-16T12:00:00.000Z",
      windowEnd: "2026-03-26T12:00:00.000Z",
      candles: [],
    },
    newsContext: {
      lookback: "72h",
      items: [],
    },
    decisionContext: {
      releaseGateMode: "paper" as const,
      requireReleaseGatePass: true,
      selectedAnalysts: ["market", "news"] as const,
      researchDepth: 2,
    },
  };
  return {
    schemaVersion: "tradingagents_sidecar_request.v1",
    requestMeta: {
      schemaVersion: "tradingagents_sidecar_request.v1",
      sourceId: "tradingagents.sidecar",
      requestId: "req-1",
      sidecarRunId: "run-1",
      generatedAt: "2026-03-26T12:00:00.000Z",
      inputHash: computeTradingAgentsRequestInputHash(payload),
    },
    payload,
  };
}

function makeResearchDecision(symbol = "BTC/USD") {
  return {
    schemaVersion: "research_decision.v1" as const,
    generatedAt: "2026-03-26T12:00:00.000Z",
    symbol,
    decisionContext: {
      releaseGateMode: "paper" as const,
    },
    marketContext: {
      lookbackBars: 240,
      windowStart: "2026-03-16T12:00:00.000Z",
      windowEnd: "2026-03-26T12:00:00.000Z",
    },
    provenance: {
      producer: "tradingagents.sidecar",
      mode: "sidecar" as const,
      sourceId: "tradingagents.sidecar",
      requestId: "req-1",
      sidecarRunId: "run-1",
      inputHash: "hash-1",
      sourceRequestSchemaVersion: "tradingagents_sidecar_request.v1",
    },
    strategy: {
      signal: 1 as const,
      reason: "Constructive sidecar verdict.",
    },
    ml: {
      available: false,
      direction: "hold" as const,
    },
    news: {
      totalNews: 0,
      positiveNews: 0,
      negativeNews: 0,
      neutralNews: 0,
      highRiskNews: 0,
      sentimentScore: 0,
      riskScore: 0,
      topThemes: [],
      flags: [],
    },
    releaseGate: null,
    decision: {
      action: "long" as const,
      confidence: 0.65,
      tradeAllowed: true,
      blockedBy: [],
      reasons: ["Constructive sidecar verdict."],
      suggestedExposurePct: 25,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("TradingAgentsSidecarRunner", () => {
  it("persists request/raw/normalized artifacts and returns a research decision", async () => {
    const baseDir = await makeTempDir();
    const executeCommand = vi.fn(async () => ({
      stdout: JSON.stringify(makeResearchDecision()),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
      noOutputTimedOut: false,
    }));

    const runner = new TradingAgentsSidecarRunner(
      {
        workingDirectory: "/tmp/tradingagents-src",
        entrypoint: "scripts/run_openalice_research_sidecar.py",
        artifactDir: baseDir,
        timeoutMs: 1000,
        noOutputTimeoutMs: 500,
        mode: "full",
        envAllowlist: ["OPENAI_API_KEY"],
        releaseGateStatusPath: "/tmp/release-gate.json",
      },
      {
        executeCommand,
        loadGateStatus: async () => ({
          version: 1,
          generatedAt: "2026-03-26T11:59:00.000Z",
          allowPaperTrading: true,
          allowLiveTrading: false,
          failedChecks: [],
          warningChecks: [],
        }),
        now: () => new Date("2026-03-26T12:00:00.000Z"),
        uuid: () => "12345678-1234-1234-1234-123456789abc",
      },
    );

    const result = await runner.run(makeRequest());

    expect(result).toHaveProperty("researchDecision");
    expect((result as any).researchDecision.decision.tradeAllowed).toBe(true);
    expect((result as any).rawOutput).toMatchObject({
      status: "completed",
      sourceId: "tradingagents.sidecar",
    });

    const [argv, options] = executeCommand.mock.calls[0];
    expect(argv).toContain("--request");
    expect(argv).toContain(join(baseDir, "requests", "run-1.request.json"));
    expect(argv).toContain("--output");
    expect(argv).toContain(
      join(baseDir, "sidecar-runs", "run-1", "process_output.json"),
    );
    expect(argv).not.toContain("--ticker");
    expect(options.cwd).toBe(join(baseDir, "sidecar-runs", "run-1"));
    expect(options.env.TRADINGAGENTS_DISABLE_DOTENV_AUTOLOAD).toBe("1");
    expect(options.env.PYTHONPATH).toContain("/tmp/tradingagents-src");

    const requestJson = await readFile(
      join(baseDir, "requests", "run-1.request.json"),
      "utf-8",
    );
    const decisionJson = await readFile(
      join(baseDir, "normalized", "run-1.research_decision.json"),
      "utf-8",
    );
    const metadataJson = await readFile(
      join(baseDir, "sidecar-runs", "run-1", "run_metadata.json"),
      "utf-8",
    );
    expect(JSON.parse(requestJson).payload.symbol).toBe("BTC/USD");
    expect(JSON.parse(requestJson).requestMeta.inputHash).toBe(
      computeTradingAgentsRequestInputHash(JSON.parse(requestJson).payload),
    );
    expect(JSON.parse(decisionJson).decision.action).toBe("long");
    expect(JSON.parse(metadataJson).artifactPaths.requestPath).toBe(
      join(baseDir, "requests", "run-1.request.json"),
    );
  });

  it("writes a fallback artifact with failure taxonomy metadata on timeout", async () => {
    const baseDir = await makeTempDir();
    const executeCommand = vi.fn(async () => ({
      stdout: "",
      stderr: "timed out waiting for sidecar",
      code: 124,
      signal: null,
      killed: true,
      termination: "timeout" as const,
      noOutputTimedOut: false,
    }));

    const runner = new TradingAgentsSidecarRunner(
      {
        workingDirectory: "/tmp/tradingagents-src",
        entrypoint: "scripts/run_openalice_research_sidecar.py",
        artifactDir: baseDir,
        timeoutMs: 1000,
        noOutputTimeoutMs: 500,
        mode: "full",
        envAllowlist: ["OPENAI_API_KEY"],
        releaseGateStatusPath: "/tmp/release-gate.json",
      },
      {
        executeCommand,
        now: () => new Date("2026-03-26T12:00:00.000Z"),
        uuid: () => "unused",
      },
    );

    let thrown: TradingAgentsSidecarRunError | null = null;
    try {
      await runner.run(makeRequest());
    } catch (error) {
      thrown = error as TradingAgentsSidecarRunError;
    }

    expect(thrown).toBeInstanceOf(TradingAgentsSidecarRunError);
    expect(thrown?.artifact.failureCode).toBe("sidecar_timeout");
    expect(thrown?.artifact.operatorVisible).toBe(true);
    expect(thrown?.artifact.timedOut).toBe(true);
    expect(thrown?.artifact.requestId).toBe("req-1");
    expect(thrown?.artifact.sidecarRunId).toBe("run-1");

    const fallbackJson = await readFile(
      join(baseDir, "fallbacks", "run-1.fallback.json"),
      "utf-8",
    );
    expect(JSON.parse(fallbackJson)).toMatchObject({
      schemaVersion: "tradingagents_sidecar_failure.v1",
      failureCode: "sidecar_timeout",
      operatorVisible: true,
      timedOut: true,
      requestId: "req-1",
      sidecarRunId: "run-1",
      inputHash: computeTradingAgentsRequestInputHash(makeRequest().payload),
    });
  });
});
