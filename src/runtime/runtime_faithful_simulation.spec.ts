import { afterEach, describe, expect, it, vi } from "vitest";
import { runRuntimeFaithfulSimulation } from "./runtime_faithful_simulation.js";
import type { LiveMarketDataBar } from "./live_gate_manager.js";
import {
  computePaperChampionRegistryChecksum,
  type PaperChampionRegistry,
} from "./paper_champion_registry.js";

function makeBar(tsOpenMs: number, close: number): LiveMarketDataBar {
  return {
    symbol: "BTC/USD",
    time: Math.floor(tsOpenMs / 1000),
    open: close - 0.2,
    high: close + 0.3,
    low: close - 0.4,
    close,
    volume: 1000,
    tsOpenMs,
    barIntervalMs: 60 * 60 * 1000,
    barCloseMs: tsOpenMs + 60 * 60 * 1000,
    completed: true,
    sourceDomain: "openbb",
  };
}

function makeSeries(values: number[], symbol = "BTC/USD"): LiveMarketDataBar[] {
  const start = Date.parse("2026-03-14T00:00:00.000Z");
  return values.map((close, idx) => ({
    ...makeBar(start + idx * 60 * 60 * 1000, close),
    symbol,
  }));
}

function makeRegistry(strategyFamily = "vol_gated_trend", symbols = ["BTC/USD"]): PaperChampionRegistry {
  const strategyParams =
    strategyFamily === "vol_gated_breakout"
      ? {
          allowShort: false,
          breakoutPeriod: 3,
          breakoutExitPeriod: 2,
          volWindowBars: 5,
          volBaselineBars: 5,
          volTriggerRatio: 0.5,
        }
      : {
          allowShort: false,
          trendFastPeriod: 3,
          trendSlowPeriod: 6,
          volWindowBars: 5,
          volBaselineBars: 5,
          volTriggerRatio: 0.5,
        };
  const base = {
    version: 1,
    strategy_family: strategyFamily,
    strategy_params: strategyParams,
    symbols,
    bar_interval: "1h",
    resolved_market_identity: Object.fromEntries(
      symbols.map((symbol) => [
        symbol,
        {
          internalSymbol: symbol,
          ccxtSymbol: symbol === "BTC/USD" ? "BTC/USDT:USDT" : "ETH/USDT:USDT",
          instId: symbol === "BTC/USD" ? "BTC-USDT-SWAP" : "ETH-USDT-SWAP",
          instType: "SWAP",
          settleCcy: "USDT",
          defaultMarketType: "swap",
          domainBaseUrl: "www.okx.com",
          demoMode: true,
        },
      ]),
    ),
    paper_gate_snapshot: {},
    cost_model_version: "cost.v1",
    veto_policy_version: "veto.v1",
    runtime_schema_version: "runtime.v1",
    research_dataset_hash: "dataset",
    bar_data_snapshot_id: "bars",
    feature_pipeline_version: "feature.v1",
    signal_code_commit_hash: "commit",
    candidate_list_hash: "cand",
    search_policy_hash: "policy",
    trial_count: 12,
    accepted_oos_window: { start: "2026-01-01", end: "2026-03-01" },
    accepted_metrics: { profitFactor: 1.2 },
    generated_at: "2026-03-14T00:00:00.000Z",
  } satisfies Omit<PaperChampionRegistry, "checksum">;
  return {
    ...base,
    checksum: computePaperChampionRegistryChecksum(base),
  };
}

describe("runtime_faithful_simulation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed when paper gate is not approved", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const artifact = runRuntimeFaithfulSimulation({
      registry: makeRegistry(),
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-14T00:00:00.000Z",
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
      },
      barsBySymbol: {
        "BTC/USD": makeSeries([100, 101, 102, 103, 104, 105]),
      },
      runtimeFlags: {
        runtimeHealthy: true,
        dataFresh: true,
        connectorHealthy: true,
        riskLimitsLoaded: true,
        paperExecutorEnabled: true,
      },
    });

    expect(artifact.paperGate.finalAllowPaperTrading).toBe(false);
    expect(artifact.commits).toHaveLength(0);
    expect(artifact.summary.skippedByPaperGate).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "[simulation] paper gate BLOCKED:",
      artifact.paperGate.blockingReasons,
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[simulation] data contract PASS: BTC/USD"),
    );
  });

  it("produces deterministic commits for a valid directional family", () => {
    const artifact = runRuntimeFaithfulSimulation({
      registry: makeRegistry("vol_gated_trend"),
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-14T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
      },
      barsBySymbol: {
        "BTC/USD": makeSeries([
          100, 100.4, 100.8, 101.2, 101.7, 102.1, 102.6, 103.0, 103.5, 104.0,
          104.3, 104.7, 104.9, 104.5, 104.1, 103.7, 103.2, 102.8, 102.3, 101.9,
        ]),
      },
      runtimeFlags: {
        runtimeHealthy: true,
        dataFresh: true,
        connectorHealthy: true,
        riskLimitsLoaded: true,
        paperExecutorEnabled: true,
      },
    });

    expect(artifact.paperGate.finalAllowPaperTrading).toBe(true);
    expect(artifact.commits.length).toBeGreaterThan(0);
    expect(artifact.summary.openCount).toBeGreaterThan(0);
    expect(artifact.commits[0].operations[0].idempotencyKey).toContain(
      "BTC_USD",
    );
  });

  it("blocks simulation when data contract fails", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const badBars = makeSeries([100, 101, 102, 103]).map((bar, idx) =>
      idx === 1 ? { ...bar, completed: false } : bar,
    );
    const artifact = runRuntimeFaithfulSimulation({
      registry: makeRegistry(),
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-14T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
      },
      barsBySymbol: {
        "BTC/USD": badBars,
      },
      runtimeFlags: {
        runtimeHealthy: true,
        dataFresh: true,
        connectorHealthy: true,
        riskLimitsLoaded: true,
        paperExecutorEnabled: true,
      },
    });

    expect(artifact.paperGate.finalAllowPaperTrading).toBe(false);
    expect(artifact.blockingReasons).toContain("paper_data_quality_invalid");
    expect(warnSpy).toHaveBeenCalledWith(
      "[simulation] paper gate BLOCKED:",
      artifact.paperGate.blockingReasons,
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[simulation] data contract BLOCKED: BTC/USD"),
    );
  });
});
