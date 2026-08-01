import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IAnalysisContext } from "../analysis-tools/interfaces.js";
import type { IMarketDataProvider, MarketData, NewsItem } from "../analysis-kit/data/interfaces.js";
import { createExpertQuantTools } from "./adapter.js";
import { admissionDecisionId } from "../../runtime/admission.js";

function makeCandles(count: number): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = 0.18 + ((i % 11) - 5) * 0.02;
    const open = price;
    const close = Math.max(1, price + drift);
    out.push({
      symbol: "BTC/USD",
      time: 1_700_000_000 + i * 3600,
      open,
      high: Math.max(open, close) + 0.12,
      low: Math.min(open, close) - 0.12,
      close,
      volume: 1_000 + i,
    });
    price = close;
  }
  return out;
}

const candles = makeCandles(600);

const marketDataProvider: IMarketDataProvider = {
  async getMarketData() {
    return candles[candles.length - 1];
  },
  async getMarketDataRange(_startTime: Date, _endTime: Date, _symbol: string) {
    return candles;
  },
  getAvailableSymbols() {
    return ["BTC/USD"];
  },
};

const mockNews: NewsItem[] = [
  {
    time: new Date("2026-02-22T09:00:00.000Z"),
    title: "Spot ETF records net inflow and institutional accumulation",
    content: "Inflow remains positive and market sentiment stabilizes.",
    metadata: { source: "TechFlow", category: "crypto-news" },
  },
  {
    time: new Date("2026-02-22T10:00:00.000Z"),
    title: "Ethereum roadmap upgrade gains developer support",
    content: "Upgrade and adoption narrative improve medium-term confidence.",
    metadata: { source: "TechFlow", category: "crypto-news" },
  },
];

const ctx: IAnalysisContext = {
  getPlayheadTime: () => new Date("2026-02-22T12:00:00.000Z"),
  getLatestOHLCV: async () => [],
  getNewsV2: async () => mockNews,
  getAvailableSymbols: () => ["BTC/USD"],
  calculatePreviousTime: (lookback: number) => {
    const now = new Date("2026-02-22T12:00:00.000Z");
    now.setHours(now.getHours() - lookback);
    return now;
  },
  marketDataProvider,
};

describe("expert-quant-tools adapter integration", () => {
  it("returns structured expert decision output", async () => {
    const tools = createExpertQuantTools(ctx);

    const result = await (tools.expertQuantDecision as any).execute({
      symbol: "BTC/USD",
      lookbackBars: 500,
      useMl: false,
      requireReleaseGatePass: false,
      policy: {
        minCompositeScore: 0.15,
        allowShort: true,
      },
    });

    expect(result.symbol).toBe("BTC/USD");
    expect(result).toHaveProperty("strategy");
    expect(result).toHaveProperty("news");
    expect(result).toHaveProperty("decision");
    expect(result).toHaveProperty("runtimeTruth");
    expect(result.decision).toHaveProperty("action");
    expect(["long", "short", "flat"]).toContain(result.decision.action);
    expect(typeof result.decision.confidence).toBe("number");
    expect(result.news.totalNews).toBeGreaterThan(0);
    expect(result.runtimeTruth.promotionGate.pass).toBe(false);
    expect(result.runtimeTruth.executionPlan.kind).toBe("blocked");
  });

  it("surfaces active formal runtime truth when upstream artifacts pass", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "expert-quant-runtime-truth-"));
    const validationRunsPath = join(tempDir, "strategy_validation_runs.json");
    const experimentVerdictPath = join(tempDir, "experiment_verdict.v2.json");
    const releaseGateStatusPath = join(tempDir, "release_gate_status.json");
    const championRegistryPath = join(tempDir, "paper_champion_registry.json");
    const admissionDecisionPath = join(tempDir, "admission_decision.v1.json");

    await writeFile(
      validationRunsPath,
      JSON.stringify(
        {
          champion: { strategyId: "S1" },
          candidates: [
            {
              strategyId: "S1",
              strategyName: "Trend",
              strategy: "trend",
              promotionEligible: true,
              admissionIntent: "promotion",
              runtimeMode: "real_runtime",
              sourceLineage: "openalice_native",
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      experimentVerdictPath,
      JSON.stringify(
        {
          schemaVersion: "experiment_verdict.v2",
          result: "GO",
        },
        null,
        2,
      ),
    );
    await writeFile(
      releaseGateStatusPath,
      JSON.stringify(
        {
          version: 1,
          generatedAt: "2026-02-22T12:00:00.000Z",
          allowPaperTrading: true,
          allowLiveTrading: true,
          failedChecks: [],
          warningChecks: [],
        },
        null,
        2,
      ),
    );
    await writeFile(
      championRegistryPath,
      JSON.stringify(
        {
          version: 1,
          generatedAt: "2026-02-22T12:00:00.000Z",
          entries: [
            {
              strategyId: "S1",
              strategyFamily: "trend",
              symbols: ["BTC/USD"],
            },
          ],
        },
        null,
        2,
      ),
    );
    const admissionCore = {
      candidateId: "S1",
      evaluatedAt: "2026-02-22T12:00:00.000Z",
      expiresAt: "2026-02-22T12:05:00.000Z",
      sourceCommit: "a".repeat(40),
      dirtyStateHash: "b".repeat(64),
      releaseManifestHash: "c".repeat(64),
      stage: "paper_allowed" as const,
      paperTradingAllowed: true,
      liveTradingAllowed: false,
      liveExecutionArmed: false,
      gateResults: [
        {
          gateId: "promotion_v2_6",
          status: "pass" as const,
          evidenceRefs: ["d".repeat(64)],
          reasonCodes: [],
        },
      ],
      blockingReasons: [],
      evidenceRefs: ["d".repeat(64)],
      approvalRefs: [],
      accountScope: [],
      assetScope: ["BTC/USD"],
    };
    await writeFile(
      admissionDecisionPath,
      JSON.stringify({
        schemaVersion: "admission_decision.v1",
        decisionId: admissionDecisionId(admissionCore),
        ...admissionCore,
      }),
    );

    const tools = createExpertQuantTools(ctx);
    const result = await (tools.expertQuantDecision as any).execute({
      symbol: "BTC/USD",
      lookbackBars: 500,
      useMl: false,
      requireReleaseGatePass: false,
      validationRunsPath,
      experimentVerdictPath,
      releaseGateStatusPath,
      championRegistryPath,
      admissionDecisionPath,
      paperBasisEquityUsd: 1_000,
      paperMaxTurnoverPct: 1,
      policy: {
        minCompositeScore: 0.15,
        allowShort: true,
      },
    });

    expect(result.runtimeTruth.promotionGate.pass).toBe(true);
    expect(result.runtimeTruth.paperGate.allowPaperTrading).toBe(true);
    expect(result.runtimeTruth.executionPlan.kind).toBe("active");
    expect(result.runtimeTruth.snapshot.paperExecutorStatus.summary).toMatchObject({
      releaseGate: "PASS",
      paperGate: "PASS",
    });
  });
});
