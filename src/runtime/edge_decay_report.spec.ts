import { describe, expect, it } from "vitest";
import {
  buildEdgeDecayReport,
  EDGE_DECAY_REPORT_SCHEMA_VERSION,
} from "./edge_decay_report.js";

describe("edge_decay_report", () => {
  it("flags degraded and broken transitions across layers", () => {
    const artifact = buildEdgeDecayReport({
      generatedAt: "2026-03-28T00:00:00.000Z",
      observations: [
        {
          layer: "research",
          sampleCount: 100,
          rawExpectancyBps: 20,
          netExpectancyBps: 16,
          hitRate: 0.58,
          sharpe: 1.4,
        },
        {
          layer: "paper",
          sampleCount: 90,
          rawExpectancyBps: 16,
          netExpectancyBps: 11,
          hitRate: 0.56,
          sharpe: 1.1,
        },
        {
          layer: "live",
          sampleCount: 70,
          rawExpectancyBps: 8,
          netExpectancyBps: -4,
          hitRate: 0.47,
          sharpe: 0.2,
        },
      ],
    });

    expect(artifact.schemaVersion).toBe(EDGE_DECAY_REPORT_SCHEMA_VERSION);
    expect(artifact.transitions).toHaveLength(3);
    expect(artifact.overallVerdict).toBe("broken");

    const researchToPaper = artifact.transitions.find(
      (item) => item.fromLayer === "research" && item.toLayer === "paper",
    );
    const paperToLive = artifact.transitions.find(
      (item) => item.fromLayer === "paper" && item.toLayer === "live",
    );
    expect(researchToPaper?.verdict).toBe("degraded");
    expect(paperToLive?.verdict).toBe("broken");
    expect(artifact.reasons).toContain("net_expectancy_broken");
  });

  it("stays stable when deltas remain inside thresholds", () => {
    const artifact = buildEdgeDecayReport({
      observations: [
        {
          layer: "research",
          sampleCount: 40,
          rawExpectancyBps: 10,
          netExpectancyBps: 8,
          hitRate: 0.55,
        },
        {
          layer: "paper",
          sampleCount: 38,
          rawExpectancyBps: 9,
          netExpectancyBps: 7,
          hitRate: 0.54,
        },
      ],
    });

    expect(artifact.overallVerdict).toBe("stable");
    expect(artifact.transitions[0].reasons).toEqual([]);
  });
});
