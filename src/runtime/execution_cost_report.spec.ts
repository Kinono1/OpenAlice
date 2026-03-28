import { describe, expect, it } from "vitest";
import {
  buildExecutionCostReport,
  EXECUTION_COST_REPORT_SCHEMA_VERSION,
} from "./execution_cost_report.js";

describe("execution_cost_report", () => {
  it("builds normalized layer metrics and pairwise comparisons", () => {
    const artifact = buildExecutionCostReport({
      generatedAt: "2026-03-28T00:00:00.000Z",
      observations: [
        {
          layer: "research",
          orderCount: 10,
          fillCount: 10,
          notionalUsd: 10_000,
          feesUsd: 2,
          slippageUsd: 1,
          fundingUsd: 0.5,
          latencyMs: [10, 15, 20, 25, 30],
        },
        {
          layer: "paper",
          orderCount: 10,
          fillCount: 9,
          notionalUsd: 10_000,
          feesUsd: 2.5,
          slippageUsd: 2,
          fundingUsd: 0.5,
          latencyMs: [20, 30, 40, 50, 60],
        },
        {
          layer: "live",
          orderCount: 10,
          fillCount: 7,
          notionalUsd: 10_000,
          feesUsd: 3,
          slippageUsd: 6,
          fundingUsd: 1,
          latencyMs: [40, 60, 80, 120, 200],
        },
      ],
    });

    expect(artifact.schemaVersion).toBe(EXECUTION_COST_REPORT_SCHEMA_VERSION);
    expect(artifact.layers).toHaveLength(3);
    expect(artifact.comparisons).toHaveLength(3);

    const research = artifact.layers.find((item) => item.layer === "research");
    const live = artifact.layers.find((item) => item.layer === "live");
    expect(research?.totalCostBps).toBe(3.5);
    expect(live?.totalCostBps).toBe(10);
    expect(live?.fillRate).toBe(0.7);

    const paperToLive = artifact.comparisons.find(
      (item) => item.fromLayer === "paper" && item.toLayer === "live",
    );
    expect(paperToLive?.totalCostBpsDelta).toBe(5);
    expect(paperToLive?.fillRateDelta).toBe(-0.2);
    expect(artifact.warnings).toContain("low_fill_rate:live");
  });

  it("returns null bps when notional is unavailable", () => {
    const artifact = buildExecutionCostReport({
      observations: [
        {
          layer: "research",
          orderCount: 2,
          fillCount: 2,
          notionalUsd: 0,
          feesUsd: 1,
          slippageUsd: 1,
        },
      ],
    });

    expect(artifact.layers[0].feeBps).toBeNull();
    expect(artifact.layers[0].totalCostBps).toBeNull();
    expect(artifact.comparisons).toHaveLength(0);
  });
});
