import { describe, expect, it } from "vitest";
import {
  buildAlphaCandidateId,
  buildSeedAlphaCandidates,
} from "./candidates";

describe("strategy candidates", () => {
  it("builds deterministic candidate ids", () => {
    const first = buildAlphaCandidateId({
      family: "core_trend",
      strategy: "trend",
      params: { trendFastPeriod: 20, trendSlowPeriod: 50, allowShort: true },
    });
    const second = buildAlphaCandidateId({
      family: "core_trend",
      strategy: "trend",
      params: { allowShort: true, trendSlowPeriod: 50, trendFastPeriod: 20 },
    });

    expect(first).toBe(second);
  });

  it("builds a stable ordered seed list", () => {
    const seeds = buildSeedAlphaCandidates();
    expect(seeds.length).toBeGreaterThan(6);
    expect(seeds[0]?.candidateId).toBe(
      "core_trend:trend:trendFastPeriod=10|trendSlowPeriod=30",
    );
    expect(seeds[seeds.length - 1]?.strategy).toBe("volBreakout");
  });

  it("overrides allowShort across all seed candidates", () => {
    const seeds = buildSeedAlphaCandidates({ allowShort: false });
    for (const seed of seeds) {
      expect(seed.params.allowShort).toBe(false);
    }
  });
});
