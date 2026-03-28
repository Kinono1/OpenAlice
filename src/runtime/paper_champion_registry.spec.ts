import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computePaperChampionRegistryChecksum,
  loadPaperChampionRegistry,
  validatePaperChampionRegistryForRuntime,
  writePaperChampionRegistry,
  type PaperChampionRegistry,
} from "./paper_champion_registry.js";

function makeRegistry(): PaperChampionRegistry {
  return {
    version: 1,
    strategy_family: "vol_gated_breakout",
    strategy_params: { breakoutPeriod: 20, breakoutExitPeriod: 10 },
    symbols: ["BTC/USD", "ETH/USD"],
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
      "ETH/USD": {
        internalSymbol: "ETH/USD",
        ccxtSymbol: "ETH/USDT:USDT",
        instId: "ETH-USDT-SWAP",
        instType: "SWAP",
        settleCcy: "USDT",
        defaultMarketType: "swap",
        domainBaseUrl: "www.okx.com",
        demoMode: true,
      },
    },
    paper_gate_snapshot: { researchApproved: true },
    cost_model_version: "cost.v1",
    veto_policy_version: "veto.v1",
    runtime_schema_version: "runtime.v1",
    research_dataset_hash: "dataset-hash",
    bar_data_snapshot_id: "bars-001",
    feature_pipeline_version: "feature.v1",
    signal_code_commit_hash: "commit-123",
    candidate_list_hash: "cand-123",
    search_policy_hash: "search-123",
    trial_count: 15,
    accepted_oos_window: { start: "2025-01-01", end: "2025-03-31" },
    accepted_metrics: { profitFactor: 1.2 },
    generated_at: "2026-03-13T00:00:00.000Z",
  };
}

describe("paper_champion_registry", () => {
  it("writes and reloads a checksum-validated champion registry", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "paper-champion-"));
    const path = join(tempDir, "paper_champion_registry.json");

    const written = await writePaperChampionRegistry(makeRegistry(), {
      filePath: path,
    });
    expect(written.checksum).toBe(
      computePaperChampionRegistryChecksum(written),
    );

    const loaded = await loadPaperChampionRegistry(path);
    expect(loaded?.checksum).toBe(written.checksum);
    expect(loaded?.resolved_market_identity["BTC/USD"].instId).toBe(
      "BTC-USDT-SWAP",
    );
  });

  it("marks policy mismatch separately from champion load failure", () => {
    const base = makeRegistry();
    const validation = validatePaperChampionRegistryForRuntime(
      {
        ...base,
        checksum: computePaperChampionRegistryChecksum(base),
      },
      {
      symbols: ["BTC/USD", "ETH/USD"],
      resolvedMarketIdentity: {
        "BTC/USD": { instId: "BTC-USDT-SWAP" },
        "ETH/USD": { instId: "ETH-USDT-SWAP" },
      },
      vetoPolicyVersion: "veto.v2",
      runtimeSchemaVersion: "runtime.v1",
      signalCodeCommitHash: "commit-123",
      },
    );

    expect(validation.championLoaded).toBe(true);
    expect(validation.policyVersionMatch).toBe(false);
    expect(validation.blockingReasons).toContain(
      "paper_champion_registry_policy_version_mismatch",
    );
  });

  it("fails champion load on identity mismatch or checksum mismatch", () => {
    const registry = {
      ...makeRegistry(),
      checksum: "bad-checksum",
    };
    const validation = validatePaperChampionRegistryForRuntime(registry, {
      symbols: ["BTC/USD"],
      resolvedMarketIdentity: {
        "BTC/USD": { instId: "BTC-USD-SWAP" },
      },
    });

    expect(validation.championLoaded).toBe(false);
    expect(validation.checksumValid).toBe(false);
    expect(validation.blockingReasons).toContain(
      "paper_champion_registry_checksum_invalid",
    );
    expect(validation.blockingReasons).toContain(
      "paper_champion_registry_identity_mismatch:BTC/USD:instId",
    );
  });

  it("persists optional challenger lifecycle fields in the checksum payload", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "paper-champion-"));
    const path = join(tempDir, "paper_champion_registry.lifecycle.json");
    const registry = {
      ...makeRegistry(),
      candidate_id: "candidate-1",
      candidate_rank: 1,
      candidate_verdict: "promote" as const,
      challengers: [
        {
          candidate_id: "candidate-2",
          rank: 2,
          verdict: "watch" as const,
          strategy: "volTrend",
          family: "vol_gated_trend",
        },
      ],
    };

    const written = await writePaperChampionRegistry(registry, {
      filePath: path,
    });
    const loaded = await loadPaperChampionRegistry(path);

    expect(written.checksum).toBe(
      computePaperChampionRegistryChecksum(written),
    );
    expect(loaded?.candidate_id).toBe("candidate-1");
    expect(loaded?.candidate_rank).toBe(1);
    expect(loaded?.candidate_verdict).toBe("promote");
    expect(loaded?.challengers).toEqual([
      {
        candidate_id: "candidate-2",
        rank: 2,
        verdict: "watch",
        strategy: "volTrend",
        family: "vol_gated_trend",
      },
    ]);
  });
});
