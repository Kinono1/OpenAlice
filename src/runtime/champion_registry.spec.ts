import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateChampionRegistryCoverage,
  loadChampionRegistry,
  normalizeChampionRegistry,
  writeChampionRegistry,
} from "./champion_registry.js";

const validRegistry = {
  version: 1 as const,
  generatedAt: "2026-03-28T00:00:00.000Z",
  entries: [
    {
      strategyId: "BTC_TREND",
      strategyFamily: "trend",
      strategyName: "BTC Trend",
      symbols: ["BTC/USD"],
      candidateId: "C1",
    },
    {
      strategyId: "ETH_ENSEMBLE",
      strategyFamily: "ensemble",
      strategyName: "ETH Ensemble",
      symbols: ["ETH/USD"],
      candidateId: "C2",
    },
  ],
  sourceVerdictPath: "/tmp/experiment_verdict.v2.json",
  releaseGateStatusPath: "/tmp/release_gate_status.json",
};

describe("champion_registry", () => {
  it("normalizes a valid registry", () => {
    const registry = normalizeChampionRegistry(validRegistry);
    expect(registry.entries).toHaveLength(2);
    expect(registry.entries[0].strategyId).toBe("BTC_TREND");
  });

  it("rejects duplicate champion symbol assignments", () => {
    expect(() =>
      normalizeChampionRegistry({
        ...validRegistry,
        entries: [
          validRegistry.entries[0],
          {
            ...validRegistry.entries[1],
            strategyId: "ETH_DUPLICATE",
            symbols: ["BTC/USD"],
          },
        ],
      }),
    ).toThrow("Champion registry symbol BTC/USD must map to exactly one entry.");
  });

  it("returns missing when file does not exist", async () => {
    const result = await loadChampionRegistry(join(tmpdir(), "missing-registry.json"));
    expect(result).toEqual({ kind: "missing" });
  });

  it("returns invalid for malformed payload", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "champion-registry-invalid-"));
    const filePath = join(tempDir, "registry.json");
    await writeFile(
      filePath,
      `${JSON.stringify({ version: 1, generatedAt: "2026-03-28T00:00:00.000Z", entries: [] })}\n`,
      "utf-8",
    );

    const result = await loadChampionRegistry(filePath);
    expect(result.kind).toBe("invalid");
    expect(result).toMatchObject({
      kind: "invalid",
    });
  });

  it("writes and loads a valid registry", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "champion-registry-valid-"));
    const filePath = join(tempDir, "registry.json");
    await writeChampionRegistry(validRegistry, { filePath });

    const result = await loadChampionRegistry(filePath);
    expect(result).toMatchObject({
      kind: "valid",
    });
    if (result.kind === "valid") {
      expect(result.registry.entries[1].strategyFamily).toBe("ensemble");
    }
  });

  it("overwrites existing registry atomically with a new valid payload", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "champion-registry-overwrite-"));
    const filePath = join(tempDir, "registry.json");

    await writeChampionRegistry(validRegistry, { filePath });
    await writeChampionRegistry(
      {
        ...validRegistry,
        entries: [
          {
            strategyId: "BTC_BREAKOUT",
            strategyFamily: "breakout",
            symbols: ["BTC/USD"],
          },
          {
            strategyId: "ETH_MEAN_REV",
            strategyFamily: "ensemble",
            symbols: ["ETH/USD"],
          },
        ],
      },
      { filePath },
    );

    const raw = JSON.parse(await readFile(filePath, "utf-8")) as {
      entries: Array<{ strategyId: string }>;
    };
    expect(raw.entries).toMatchObject([
      { strategyId: "BTC_BREAKOUT" },
      { strategyId: "ETH_MEAN_REV" },
    ]);
  });

  it("evaluates registry coverage against required portfolio symbols", () => {
    const coverage = evaluateChampionRegistryCoverage(validRegistry, {
      requiredSymbols: ["BTC/USD", "ETH/USD"],
      expectedStrategyIdsBySymbol: {
        "BTC/USD": "BTC_TREND",
        "ETH/USD": "ETH_ENSEMBLE",
      },
    });

    expect(coverage.ok).toBe(true);
    expect(coverage.entriesBySymbol["BTC/USD"]?.strategyId).toBe("BTC_TREND");
    expect(coverage.entriesBySymbol["ETH/USD"]?.strategyId).toBe("ETH_ENSEMBLE");
  });

  it("fails coverage when a required symbol is missing or mismatched", () => {
    const coverage = evaluateChampionRegistryCoverage(validRegistry, {
      requiredSymbols: ["BTC/USD", "ETH/USD"],
      expectedStrategyIdsBySymbol: {
        "BTC/USD": "BTC_TREND",
        "ETH/USD": "ETH_BREAKOUT",
      },
    });

    expect(coverage.ok).toBe(false);
    expect(coverage.reasons).toContain("registry_strategy_mismatch:ETH/USD");
  });
});
