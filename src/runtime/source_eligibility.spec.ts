import { describe, expect, it } from "vitest";
import {
  deriveManifestSourceDefaults,
  resolveSourceEligibility,
} from "./source_eligibility.js";

describe("source_eligibility", () => {
  it("hard-blocks proxy runtime research decisions", () => {
    const eligibility = resolveSourceEligibility({
      provenance: {
        mode: "sidecar_proxy",
        producer: "tradingagents.sidecar.local_proxy",
        evidenceStrength: "proxy",
        fallbackReason: "tradingagents_runtime_invalid_model_config",
      },
    });

    expect(eligibility.sourceValidity.runtimeMode).toBe("proxy_runtime");
    expect(eligibility.sourceValidity.sourceLineage).toBe("donor_proxy");
    expect(eligibility.promotionEligible).toBe(false);
    expect(eligibility.eligibilityBlockers).toContain("runtime_not_real");
    expect(eligibility.eligibilityBlockers).toContain("non_donor_native_source");
  });

  it("derives non-native proxy defaults from CryptoTrade manifest notes", () => {
    const defaults = deriveManifestSourceDefaults([
      "source_paradigm=cryptotrade_reflection_narrative_v2",
      "reflection_source=openalice_paper_history",
      "not_donor_native=true",
    ]);
    const eligibility = resolveSourceEligibility({}, defaults);

    expect(eligibility.sourceValidity.sourceLineage).toBe("openalice_history_proxy");
    expect(eligibility.donorNative).toBe(false);
    expect(eligibility.admissionIntent).toBe("exploratory");
    expect(eligibility.promotionEligible).toBe(false);
    expect(eligibility.eligibilityBlockers).toContain("non_donor_native_source");
  });

  it("keeps explicit native promotion artifacts eligible", () => {
    const defaults = deriveManifestSourceDefaults([
      "runtime_mode=real_runtime",
      "source_lineage=openalice_native",
      "admission_intent=promotion",
      "promotion_eligible=true",
    ]);
    const eligibility = resolveSourceEligibility(
      {},
      defaults,
    );

    expect(eligibility.sourceValidity.runtimeMode).toBe("real_runtime");
    expect(eligibility.sourceValidity.sourceLineage).toBe("openalice_native");
    expect(eligibility.admissionIntent).toBe("promotion");
    expect(eligibility.promotionEligible).toBe(true);
    expect(eligibility.eligibilityBlockers).toEqual([]);
  });

  it("fails closed when source metadata is missing", () => {
    const eligibility = resolveSourceEligibility({});

    expect(eligibility.sourceValidity.runtimeMode).toBe("unknown");
    expect(eligibility.sourceValidity.sourceLineage).toBe("unknown");
    expect(eligibility.admissionIntent).toBe("exploratory");
    expect(eligibility.promotionEligible).toBe(false);
    expect(eligibility.eligibilityBlockers).toContain("missing_source_metadata");
    expect(eligibility.eligibilityBlockers).toContain("runtime_not_real");
  });

  it("fails closed when promotion is requested without runtime and lineage metadata", () => {
    const eligibility = resolveSourceEligibility({
      sourceEligibility: {
        admissionIntent: "promotion",
        promotionEligible: true,
      },
    });

    expect(eligibility.sourceValidity.runtimeMode).toBe("unknown");
    expect(eligibility.sourceValidity.sourceLineage).toBe("unknown");
    expect(eligibility.admissionIntent).toBe("promotion");
    expect(eligibility.promotionEligible).toBe(false);
    expect(eligibility.eligibilityBlockers).toContain("missing_source_metadata");
    expect(eligibility.eligibilityBlockers).toContain("unknown_lineage_not_promotable");
    expect(eligibility.eligibilityBlockers).toContain("runtime_not_real");
  });

  it("blocks control lineage from promotion even when runtime is real", () => {
    const eligibility = resolveSourceEligibility({
      role: "benchmark_control",
      sourceEligibility: {
        admissionIntent: "promotion",
        promotionEligible: true,
      },
    });

    expect(eligibility.sourceValidity.sourceLineage).toBe("control");
    expect(eligibility.promotionEligible).toBe(false);
    expect(eligibility.eligibilityBlockers).toContain("control_lineage_not_promotable");
  });

  it("blocks unknown lineage from promotion when provenance is unavailable", () => {
    const eligibility = resolveSourceEligibility({
      provenance: {
        mode: "sidecar_failure",
        failureCode: "missing_inputs",
      },
      sourceEligibility: {
        admissionIntent: "promotion",
        promotionEligible: true,
      },
    });

    expect(eligibility.sourceValidity.sourceLineage).toBe("unknown");
    expect(eligibility.promotionEligible).toBe(false);
    expect(eligibility.eligibilityBlockers).toContain("unknown_lineage_not_promotable");
  });
});
