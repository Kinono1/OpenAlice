import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPromotionMetadata,
  sha256Hex,
  stableSerialize,
} from "./paper_promotion_metadata.js";
import {
  DSR_METHOD_VERSION,
  PBO_METHOD_VERSION,
  RUNTIME_SCHEMA_VERSION,
  VETO_POLICY_VERSION,
} from "./paper_runtime_versions.js";

describe("paper_promotion_metadata", () => {
  it("builds promotion metadata when inputs are complete and git is clean", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "promotion-metadata-"));
    const csvPath = join(tempDir, "bars.csv");
    await writeFile(csvPath, "timestamp,open,high,low,close,volume\n1,1,1,1,1,1\n");

    const result = await buildPromotionMetadata(
      {
        repoRoot: tempDir,
        candidatesFilePath: join(tempDir, "candidates.json"),
        candidatesFilePayload: {
          dataset: { inputCsv: csvPath, symbol: "BTC/USD", lookbackBars: 3600 },
          candidates: [{ strategyId: "C1" }, { strategyId: "C2" }],
          thresholds: { fdrQMax: 0.1 },
          wfo: { trainBars: 840 },
          significance: { partitions: 8 },
          riskSimulation: { method: "moving_block_bootstrap" },
          costModel: { feeRate: 0.0004 },
          stageCRound4Mapping: { schemaVersion: "stage_c_round4_mapping.v1" },
          trial_count: 47,
        },
        datasetInputCsvPath: csvPath,
        costModel: { feeRate: 0.0004 },
        fdrMethod: "cv_storey_bh",
      },
      {
        getGitState: async () => ({
          head: "abc123",
          isClean: true,
        }),
        readJson: async () => ({}),
        sha256File: async () => "f".repeat(64),
      },
    );

    expect(result.ready).toBe(true);
    expect(result.blockingReasons).toHaveLength(0);
    expect(result.metadata?.trialCount).toBe(47);
    expect(result.metadata?.candidateListHash).toBe(
      sha256Hex(stableSerialize([{ strategyId: "C1" }, { strategyId: "C2" }])),
    );
    expect(result.metadata?.vetoPolicyVersion).toBe(VETO_POLICY_VERSION);
    expect(result.metadata?.runtimeSchemaVersion).toBe(RUNTIME_SCHEMA_VERSION);
    expect(result.metadata?.pboMethod).toBe(PBO_METHOD_VERSION);
    expect(result.metadata?.dsrMethod).toBe(DSR_METHOD_VERSION);
  });

  it("falls back to bestTripletSource trialId when direct trial count is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "promotion-metadata-"));
    const csvPath = join(tempDir, "bars.csv");
    await writeFile(csvPath, "timestamp,open,high,low,close,volume\n1,1,1,1,1,1\n");
    const bestTripletPath = join(tempDir, "best_triplet.json");
    await writeFile(
      bestTripletPath,
      JSON.stringify({ trialId: 99 }, null, 2),
      "utf-8",
    );

    const result = await buildPromotionMetadata(
      {
        repoRoot: tempDir,
        candidatesFilePath: join(tempDir, "candidates.json"),
        candidatesFilePayload: {
          dataset: { inputCsv: csvPath, symbol: "BTC/USD", lookbackBars: 3600 },
          candidates: [{ strategyId: "C1" }],
          costModel: { feeRate: 0.0004 },
          stageCRound4Mapping: { schemaVersion: "stage_c_round4_mapping.v1" },
          hypothesisCompile: {
            inputs: {
              bestTripletSource: bestTripletPath,
            },
          },
        },
        datasetInputCsvPath: csvPath,
        costModel: { feeRate: 0.0004 },
        fdrMethod: "bh",
      },
      {
        getGitState: async () => ({
          head: "abc123",
          isClean: true,
        }),
        readJson: async (path: string) =>
          JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf-8")),
        sha256File: async () => "f".repeat(64),
      },
    );

    expect(result.ready).toBe(true);
    expect(result.metadata?.trialCount).toBe(99);
  });

  it("refuses to build ready metadata when git is dirty", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "promotion-metadata-"));
    const csvPath = join(tempDir, "bars.csv");
    await writeFile(csvPath, "timestamp,open,high,low,close,volume\n1,1,1,1,1,1\n");

    const result = await buildPromotionMetadata(
      {
        repoRoot: tempDir,
        candidatesFilePath: join(tempDir, "candidates.json"),
        candidatesFilePayload: {
          dataset: { inputCsv: csvPath, symbol: "BTC/USD", lookbackBars: 3600 },
          candidates: [{ strategyId: "C1" }],
          stageCRound4Mapping: { schemaVersion: "stage_c_round4_mapping.v1" },
          trial_count: 7,
        },
        datasetInputCsvPath: csvPath,
        costModel: { feeRate: 0.0004 },
        fdrMethod: "bh",
      },
      {
        getGitState: async () => ({
          head: "abc123",
          isClean: false,
        }),
        readJson: async () => ({}),
        sha256File: async () => "f".repeat(64),
      },
    );

    expect(result.ready).toBe(false);
    expect(result.metadata).toBeNull();
    expect(result.blockingReasons).toContain("promotion_metadata_git_dirty");
  });
});
