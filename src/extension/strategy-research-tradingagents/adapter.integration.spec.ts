import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IAnalysisContext } from "../analysis-tools/interfaces.js";
import type { MarketData, NewsItem } from "../analysis-kit/data/interfaces.js";
import {
  buildTradingAgentsResearchRequest,
  createTradingAgentsResearchTools,
} from "./adapter.js";
import {
  computeTradingAgentsRequestInputHash,
  validateTradingAgentsStrictResearchRequest,
  type ITradingAgentsResearchRunner,
} from "./types.js";

function makeCandles(count: number): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + 1;
    out.push({
      symbol: "BTC/USD",
      time: 1_700_000_000 + i * 3600,
      open,
      high: close + 0.5,
      low: open - 0.5,
      close,
      volume: 1000 + i,
    });
    price = close;
  }
  return out;
}

const candles = makeCandles(240);
const news: NewsItem[] = [
  {
    time: new Date("2026-03-26T10:00:00.000Z"),
    title: "ETF inflows stay positive",
    content: "Flows remain constructive and sentiment is stable.",
    metadata: { source: "TechFlow" },
  },
];

const ctx: IAnalysisContext = {
  marketDataProvider: {
    async getMarketData() {
      return candles[candles.length - 1];
    },
    async getMarketDataRange() {
      return candles;
    },
  },
  getPlayheadTime() {
    return new Date("2026-03-26T12:00:00.000Z");
  },
  calculatePreviousTime(lookbackBars: number) {
    const now = new Date("2026-03-26T12:00:00.000Z");
    now.setHours(now.getHours() - lookbackBars);
    return now;
  },
  async getNewsV2() {
    return news;
  },
};

class MockRunner implements ITradingAgentsResearchRunner {
  request: unknown;
  rawOutput?: unknown;

  async run(request: any) {
    this.request = request;
    const payload = request.payload ?? request;
    const researchDecision = {
      schemaVersion: "research_decision.v1" as const,
      generatedAt: "2026-03-26T12:00:00.000Z",
      symbol: payload.symbol,
      decisionContext: {
        releaseGateMode: payload.decisionContext.releaseGateMode,
      },
      marketContext: {
        lookbackBars: payload.marketContext.lookbackBars,
        windowStart: payload.marketContext.windowStart,
        windowEnd: payload.marketContext.windowEnd,
      },
      provenance: {
        producer: "tradingagents.sidecar",
        mode: "sidecar" as const,
        sourceId: "tradingagents.sidecar",
        requestId: request.requestMeta?.requestId,
        sidecarRunId: request.requestMeta?.sidecarRunId,
        inputHash: request.requestMeta?.inputHash,
        sourceRequestSchemaVersion: request.schemaVersion,
      },
      strategy: {
        signal: 1 as const,
        reason: "Bull and bear debate resolved long.",
      },
      ml: {
        available: false,
        direction: "hold" as const,
      },
      news: {
        totalNews: 1,
        positiveNews: 1,
        negativeNews: 0,
        neutralNews: 0,
        highRiskNews: 0,
        sentimentScore: 0.2,
        riskScore: 0.1,
        topThemes: [{ theme: "institutional_flow", count: 1 }],
        flags: [],
      },
      releaseGate: null,
      decision: {
        action: "long" as const,
        confidence: 0.6,
        tradeAllowed: true,
        blockedBy: [],
        reasons: ["debate consensus long"],
        suggestedExposurePct: 30,
      },
    };

    if (this.rawOutput) {
      return {
        researchDecision,
        rawOutput: this.rawOutput,
      };
    }

    return researchDecision;
  }
}

const createdDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "openalice-ta-adapter-"));
  createdDirs.push(dir);
  return dir;
}

async function cleanupCreatedDirs() {
  await Promise.all(
    createdDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
}

describe("strategy-research-tradingagents adapter", () => {
  it("builds a sidecar request with candles and news context", async () => {
    const request = await buildTradingAgentsResearchRequest(ctx, {
      symbol: "BTC/USD",
      lookbackBars: 120,
      newsLookback: "48h",
      selectedAnalysts: ["market", "news"],
      researchDepth: 2,
      releaseGateMode: "paper",
      requireReleaseGatePass: true,
    });

    expect(request.schemaVersion).toBe("tradingagents_sidecar_request.v1");
    expect(validateTradingAgentsStrictResearchRequest(request as any)).toEqual([]);
    expect(request.payload.marketContext.candles).toHaveLength(240);
    expect(request.payload.newsContext.items).toHaveLength(1);
    expect(request.payload.decisionContext.selectedAnalysts).toEqual([
      "market",
      "news",
    ]);
    expect(request.requestMeta.inputHash).toBe(
      computeTradingAgentsRequestInputHash(request.payload),
    );
  });

  it("returns a validated research_decision payload from the runner", async () => {
    const artifactDir = await makeTempDir();
    const disagreementPath = join(
      artifactDir,
      "disagreements",
      "run-1.research_disagreement.json",
    );
    const runner = new MockRunner();
    runner.rawOutput = {
      artifactPaths: {
        disagreementPath,
      },
    };
    const tools = createTradingAgentsResearchTools(ctx, runner);

    try {
      const result = await (tools.tradingAgentsResearchAnalyze as any).execute({
        symbol: "BTC/USD",
        lookbackBars: 120,
        newsLookback: "48h",
        selectedAnalysts: ["market", "news"],
        researchDepth: 2,
        releaseGateMode: "paper",
        requireReleaseGatePass: true,
      });

      expect(result.researchDecision.schemaVersion).toBe("research_decision.v1");
      expect(result.researchDecision.provenance.mode).toBe("sidecar");
      expect(result.request.schemaVersion).toBe(
        "tradingagents_sidecar_request.v1",
      );
      expect(result.request.sourceId).toBe("tradingagents.sidecar");
      expect(result.request.symbol).toBe("BTC/USD");
      expect(result.request.selectedAnalysts).toEqual(["market", "news"]);
      expect(result.rawOutput).toMatchObject({
        status: "completed",
        sourceId: "tradingagents.sidecar",
        disagreementArtifactPath: disagreementPath,
      });
      expect((result.rawOutput as any).disagreementPersistError).toBeUndefined();
      expect((result.rawOutput as any).disagreement.schemaVersion).toBe(
        "research_disagreement.v1",
      );
      expect((runner.request as any).schemaVersion).toBe(
        "tradingagents_sidecar_request.v1",
      );
      expect((runner.request as any).requestMeta.inputHash).toBe(
        computeTradingAgentsRequestInputHash((runner.request as any).payload),
      );

      const persistedDisagreement = JSON.parse(
        await readFile(disagreementPath, "utf-8"),
      );
      expect(persistedDisagreement.schemaVersion).toBe(
        "research_disagreement.v1",
      );
      expect(persistedDisagreement.symbol).toBe("BTC/USD");
    } finally {
      await cleanupCreatedDirs();
    }
  });

  it("returns baseline fallback metadata when the sidecar call fails", async () => {
    const runner: ITradingAgentsResearchRunner = {
      async run() {
        throw new Error("sidecar_timeout:Timed out waiting for sidecar output");
      },
    };
    const tools = createTradingAgentsResearchTools(ctx, runner);

    const result = await (tools.tradingAgentsResearchAnalyze as any).execute({
      symbol: "BTC/USD",
      lookbackBars: 120,
      newsLookback: "48h",
      selectedAnalysts: ["market", "news"],
      researchDepth: 2,
      releaseGateMode: "paper",
      requireReleaseGatePass: true,
    });

    expect(result.researchDecision.provenance.mode).toBe("native");
    expect(result.request.schemaVersion).toBe("tradingagents_sidecar_request.v1");
    expect(result.request.sourceId).toBe("tradingagents.sidecar");
    expect(result.rawOutput).toMatchObject({
      status: "fallback_triggered",
      sourceId: "tradingagents.sidecar",
      fallback: {
        schemaVersion: "tradingagents_fallback_summary.v1",
        failureCode: "sidecar_boot_failed",
        operatorVisible: true,
      },
    });
    expect((result.rawOutput as any).fallback.requestId).toBe(
      result.request.requestId,
    );
    expect((result.rawOutput as any).fallback.sidecarRunId).toBe(
      result.request.sidecarRunId,
    );
    expect((result.rawOutput as any).fallback.inputHash).toBe(
      result.request.inputHash,
    );
  });

  it("blocks automatic donor runs when the latest verdict is killed", async () => {
    const runner = new MockRunner();
    const tools = createTradingAgentsResearchTools(ctx, runner, {
      loadVerdict: async () => ({
        schemaVersion: "tradingagents_verdict.v1",
        generatedAt: "2026-03-26T12:00:00.000Z",
        sourceId: "tradingagents.sidecar",
        state: "killed",
        automaticRunsBlocked: true,
        paperInfluenceAllowed: false,
        reasons: ["shadow_kill_overlap_hit_rate_below_min"],
        evidence: {
          effectivePaperDays: 12,
          donorAttemptCount: 42,
          overlapCount: 24,
          donorOverlapHitRate: 0.4,
          directionalHitRateDelta: -0.2,
          fallbackInvalidRatio: 0.2,
        },
      }),
    });

    const result = await (tools.tradingAgentsResearchAnalyze as any).execute({
      symbol: "BTC/USD",
      lookbackBars: 120,
      newsLookback: "48h",
      selectedAnalysts: ["market", "news"],
      researchDepth: 2,
      releaseGateMode: "paper",
      requireReleaseGatePass: true,
    });

    expect(runner.request).toBeUndefined();
    expect(result.researchDecision.provenance.mode).toBe("native");
    expect(result.rawOutput).toMatchObject({
      status: "blocked_by_verdict",
      verdict: {
        state: "killed",
      },
      fallback: {
        failureCode: "blocked_by_source_role",
        operatorVisible: true,
      },
    });
  });
});
