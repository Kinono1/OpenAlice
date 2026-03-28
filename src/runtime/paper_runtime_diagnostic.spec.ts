import { describe, expect, it, vi } from "vitest";
import {
  resolveDiagnosticLookbackBars,
  resolveDiagnosticSymbols,
  runPaperRuntimeDiagnostic,
} from "./paper_runtime_diagnostic.js";
import type { PaperChampionRegistry } from "./paper_champion_registry.js";

function makeConfig() {
  return {
    engine: {
      pairs: ["BTC/USD"],
      timeframe: "1h",
    },
    crypto: {
      allowedSymbols: ["BTC/USD"],
    },
    openbb: {
      apiUrl: "http://localhost:6900",
      providers: {
        crypto: "yfinance",
      },
      providerKeys: {},
    },
  } as any;
}

function makeRegistry(): PaperChampionRegistry {
  return {
    version: 1,
    checksum: "checksum",
    strategy_family: "vol_gated_trend",
    strategy_params: {
      allowShort: false,
      trendFastPeriod: 3,
      trendSlowPeriod: 6,
      volWindowBars: 5,
      volBaselineBars: 5,
      volTriggerRatio: 0.5,
    },
    symbols: ["BTC/USD"],
    bar_interval: "1h",
    resolved_market_identity: {
      "BTC/USD": {
        internalSymbol: "BTC/USD",
        ccxtSymbol: "BTC/USDT:USDT",
        instId: "BTC-USDT-SWAP",
        instType: "SWAP",
        settleCcy: "USDT",
        defaultMarketType: "swap",
        domainBaseUrl: "www.okx.com",
        demoMode: true,
      },
    },
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
    accepted_oos_window: {},
    accepted_metrics: {},
    generated_at: "2026-03-15T00:00:00.000Z",
  };
}

function makeBars() {
  const start = Date.parse("2026-03-15T00:00:00.000Z");
  return Array.from({ length: 20 }, (_, idx) => ({
    symbol: "BTC/USD",
    time: Math.floor((start + idx * 60 * 60 * 1000) / 1000),
    open: 100 + idx,
    high: 101 + idx,
    low: 99 + idx,
    close: 100.5 + idx,
    volume: 1000,
    tsOpenMs: start + idx * 60 * 60 * 1000,
    barIntervalMs: 60 * 60 * 1000,
    barCloseMs: start + (idx + 1) * 60 * 60 * 1000,
    completed: true,
    sourceDomain: "openbb",
  }));
}

function createDeps(overrides: Record<string, unknown> = {}) {
  const getMarketDataRange = vi.fn(async () => makeBars());
  return {
    deps: {
      loadConfig: vi.fn(async () => makeConfig()),
      loadPaperChampionRegistry: vi.fn(async () => null),
      loadReleaseGateStatus: vi.fn(async () => null),
      createMarketContext: vi.fn(() => ({
        getPlayheadTime: () => new Date("2026-03-15T20:00:00.000Z"),
        calculatePreviousTime: (lookbackBars: number) =>
          new Date(
            Date.parse("2026-03-15T20:00:00.000Z") -
              lookbackBars * 60 * 60 * 1000,
          ),
        getAvailableSymbols: () => ["BTC/USD"],
        marketDataProvider: {
          getMarketDataRange,
        },
      })),
      now: () => new Date("2026-03-15T20:00:00.000Z"),
      ...overrides,
    },
    getMarketDataRange,
  };
}

describe("paper_runtime_diagnostic", () => {
  it("falls back to config symbols when registry is missing", () => {
    expect(resolveDiagnosticSymbols(null, makeConfig())).toEqual(["BTC/USD"]);
  });

  it("uses registry-derived lookback when registry is present", () => {
    expect(resolveDiagnosticLookbackBars(makeRegistry())).toBeGreaterThanOrEqual(
      200,
    );
  });

  it("runs a blocked diagnostic when registry and release gate are missing", async () => {
    const { deps, getMarketDataRange } = createDeps();

    const result = await runPaperRuntimeDiagnostic({}, deps as any);

    expect(getMarketDataRange).toHaveBeenCalledTimes(1);
    expect(result.statusArtifact.preflight.releaseGateState).toBe("missing");
    expect(result.statusArtifact.preflight.championRegistryState).toBe("missing");
    expect(result.summary.blockingReasons).toContain("paper_research_not_approved");
    expect(result.summary.blockingReasons).toContain(
      "paper_champion_registry_missing",
    );
  });

  it("reports a passing release gate and blocked champion validation", async () => {
    const registry = makeRegistry();
    registry.checksum = "bad-checksum";
    const { deps } = createDeps({
      loadPaperChampionRegistry: vi.fn(async () => registry),
      loadReleaseGateStatus: vi.fn(async () => ({
        version: 1,
        generatedAt: "2026-03-15T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
      })),
    });

    const result = await runPaperRuntimeDiagnostic({}, deps as any);

    expect(result.statusArtifact.preflight.releaseGateState).toBe("pass");
    expect(result.statusArtifact.preflight.championRegistryState).toBe("blocked");
    expect(result.statusArtifact.preflight.championRegistryReasons).toContain(
      "paper_champion_registry_checksum_invalid",
    );
  });

  it("propagates market-data failures as program errors", async () => {
    const { deps } = createDeps({
      createMarketContext: vi.fn(() => ({
        getPlayheadTime: () => new Date("2026-03-15T20:00:00.000Z"),
        calculatePreviousTime: () => new Date("2026-03-15T00:00:00.000Z"),
        getAvailableSymbols: () => ["BTC/USD"],
        marketDataProvider: {
          getMarketDataRange: vi.fn(async () => {
            throw new Error("openbb unreachable");
          }),
        },
      })),
    });

    await expect(runPaperRuntimeDiagnostic({}, deps as any)).rejects.toThrow(
      "openbb unreachable",
    );
  });
});
