import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CryptoOrder,
  CryptoPosition,
  CryptoTicker,
  ICryptoTradingEngine,
} from "../extension/crypto-trading/interfaces.js";
import { refreshRuntimeTruthMainline } from "./runtime_truth_mainline.js";

describe("runtime_truth_mainline", () => {
  it("writes blocked snapshots when no portfolio target file exists", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runtime-truth-mainline-"));
    await writeFile(
      join(tempDir, "strategy_validation_runs.json"),
      JSON.stringify({
        champion: { strategyId: "S1" },
        candidates: [{ strategyId: "S1", strategy: "trend" }],
      }),
    );
    await writeFile(
      join(tempDir, "experiment_verdict.v2.json"),
      JSON.stringify({ schemaVersion: "experiment_verdict.v2", result: "NO_GO" }),
    );
    await writeFile(
      join(tempDir, "release_gate_status.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
      }),
    );

    const result = await refreshRuntimeTruthMainline(
      createEngine(),
      createLiveGateManagerStub(),
      {
        symbols: ["BTC/USD", "ETH/USD"],
        validationRunsPath: join(tempDir, "strategy_validation_runs.json"),
        verdictPath: join(tempDir, "experiment_verdict.v2.json"),
        releaseGateStatusPath: join(tempDir, "release_gate_status.json"),
        registryPath: join(tempDir, "missing_registry.json"),
        portfolioTargetPath: join(tempDir, "missing_target.json"),
        snapshotBaseDir: tempDir,
        now: new Date("2026-03-29T00:00:00.000Z"),
      },
    );

    expect(result.portfolioTargetSource).toBe("fallback_zero_target");
    expect(result.truth.promotionGate.pass).toBe(false);
    expect(result.truth.executionPlan.kind).toBe("blocked");
    expect(result.phaseReadiness.research).toMatchObject({
      status: "blocked",
    });

    const snapshot = JSON.parse(
      await readFile(join(tempDir, "paper_gate_status.json"), "utf-8"),
    ) as { finalAllowPaperTrading: boolean };
    expect(snapshot.finalAllowPaperTrading).toBe(false);
  });

  it("uses an explicit portfolio target file when present", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runtime-truth-mainline-target-"));
    await writeFile(
      join(tempDir, "strategy_validation_runs.json"),
      JSON.stringify({
        champion: { strategyId: "S1" },
        candidates: [{ strategyId: "S1", strategy: "trend" }],
      }),
    );
    await writeFile(
      join(tempDir, "experiment_verdict.v2.json"),
      JSON.stringify({ schemaVersion: "experiment_verdict.v2", result: "GO" }),
    );
    await writeFile(
      join(tempDir, "release_gate_status.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      }),
    );
    await writeFile(
      join(tempDir, "paper_champion_registry.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        entries: [
          { strategyId: "S1", strategyFamily: "trend", symbols: ["BTC/USD"] },
        ],
      }),
    );
    await writeFile(
      join(tempDir, "paper_portfolio_target.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        basisEquityUsd: 1000,
        targetGrossExposure: 0.5,
        targetNetExposure: 0.5,
        maxTurnoverPct: 1,
        positions: [
          {
            symbol: "BTC/USD",
            targetWeight: 0.5,
            targetNotionalUsd: 500,
          },
        ],
      }),
    );

    const result = await refreshRuntimeTruthMainline(
      createEngine(),
      createLiveGateManagerStub(),
      {
        symbols: ["BTC/USD", "ETH/USD"],
        validationRunsPath: join(tempDir, "strategy_validation_runs.json"),
        verdictPath: join(tempDir, "experiment_verdict.v2.json"),
        releaseGateStatusPath: join(tempDir, "release_gate_status.json"),
        registryPath: join(tempDir, "paper_champion_registry.json"),
        portfolioTargetPath: join(tempDir, "paper_portfolio_target.json"),
        snapshotBaseDir: tempDir,
        proofTracking: {
          status: "tracking",
          elapsedDays: 7,
          targetDays: 90,
          netPnlPositive: true,
        },
        now: new Date("2026-03-29T00:00:00.000Z"),
      },
    );

    expect(result.portfolioTargetSource).toBe("file");
    expect(result.truth.executionPlan.kind).toBe("active");
    expect(result.phaseReadiness).toMatchObject({
      research: {
        status: "ready",
      },
      paper: {
        status: "active_ready",
      },
      liveTinyCapital: {
        status: "tiny_cap_ready",
      },
      proofTracking: {
        status: "tracking",
        elapsedDays: 7,
      },
    });
    const snapshot = JSON.parse(
      await readFile(join(tempDir, "paper_executor_status.latest.json"), "utf-8"),
    ) as { summary: { releaseGate: string; paperGate: string } };
    expect(snapshot.summary.releaseGate).toBe("PASS");
    expect(snapshot.summary.paperGate).toBe("PASS");
  });
});

function createLiveGateManagerStub() {
  return {
    buildRuntimePlanningState: vi.fn().mockResolvedValue({
      regimeSeverity: "stable",
      regimeReason: null,
      capitalRampStage: "5%",
      releaseGateStatus: null,
      releaseGateBlocked: false,
      releaseGateBlockedReason: null,
    }),
  };
}

function createEngine(
  positions: CryptoPosition[] = [],
): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn() as unknown as ICryptoTradingEngine["placeOrder"],
    getPositions: vi.fn().mockResolvedValue(positions),
    getOrders: vi.fn().mockResolvedValue([] as CryptoOrder[]),
    getAccount: vi.fn() as unknown as ICryptoTradingEngine["getAccount"],
    cancelOrder: vi.fn() as unknown as ICryptoTradingEngine["cancelOrder"],
    adjustLeverage: vi.fn() as unknown as ICryptoTradingEngine["adjustLeverage"],
    getTicker: vi.fn().mockImplementation(async (symbol: string) => ({
      symbol,
      last: symbol === "ETH/USD" ? 100 : 200,
      bid: symbol === "ETH/USD" ? 99 : 199,
      ask: symbol === "ETH/USD" ? 101 : 201,
      high: symbol === "ETH/USD" ? 105 : 205,
      low: symbol === "ETH/USD" ? 95 : 195,
      volume: 1000,
      timestamp: new Date("2026-03-29T00:00:00.000Z"),
    } satisfies CryptoTicker)),
    getFundingRate: vi.fn() as unknown as ICryptoTradingEngine["getFundingRate"],
    getOrderBook: vi.fn() as unknown as ICryptoTradingEngine["getOrderBook"],
  };
}
