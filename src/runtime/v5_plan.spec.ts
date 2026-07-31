import { describe, it, expect } from "vitest";
import {
  cryptoDlSignalV1Schema,
  cryptoDlSidecarEnvelopeV1Schema,
  cryptoDlSidecarStatusV1Schema,
  signalHealthV1Schema,
  executionTopOfBookEvidenceV1Schema,
  validateSidecarEnvelope,
  computeCurrentSlotId,
} from "./sidecar_signal.js";
import { pctToBps, floatToBps, bpsToPct, awayFromZeroRounding } from "../domain/trading/risk.js";

// ── Helpers ──────────────────────────────────────────────────────────

function validSignal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    source: "cryptotrade",
    strategy_id: "crypto_dl",
    symbol: "BTC/USDT",
    as_of: now.toISOString(),
    target_position_bps: 200,
    confidence_bps: 8000,
    model_id: "v1",
    thesis: "momentum continuation",
    label_horizon_bars: 6,
    bar_interval_ms: 3600000,
    target_start_delay_bars: 1,
    target_start_at: now.toISOString(),
    target_end_at: new Date(now.getTime() + 86400000).toISOString(),
    ...overrides,
  };
}

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    schema_version: 1,
    slot_id: computeCurrentSlotId(now),
    run_id: "test-run",
    generated_at: now.toISOString(),
    ttl_ms: 3600000,
    signals: [validSignal()],
    producer: "test-producer",
    ...overrides,
  };
}

// ── 1. validateSidecarEnvelope — five gate layers ────────────────────

describe("v5 plan - validateSidecarEnvelope gate layers", () => {
  it("gate 1: rejects non-object input (bare array)", () => {
    const result = validateSidecarEnvelope([{ symbol: "XRP/USDT", position_pct: 0.1 }]);
    expect(result.valid).toBe(false);
  });

  it("gate 1: schema validation — missing required fields", () => {
    const result = validateSidecarEnvelope({});
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("gate 2: rejects expired TTL", () => {
    const old = new Date(Date.now() - 86400000).toISOString();
    const envelope = validEnvelope({
      generated_at: old,
      ttl_ms: 100,
    });
    const result = validateSidecarEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.reason!.toLowerCase()).toContain("ttl");
  });

  it("gate 2: accepts fresh TTL", () => {
    const envelope = validEnvelope();
    const result = validateSidecarEnvelope(envelope);
    expect(result.valid).toBe(true);
  });

  it("gate 3: rejects old slot_id", () => {
    const envelope = validEnvelope({
      slot_id: "slot-20200101-00",
    });
    const result = validateSidecarEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.reason!.toLowerCase()).toContain("slot");
  });

  it("gate 3: accepts current slot_id", () => {
    const envelope = validEnvelope();
    const result = validateSidecarEnvelope(envelope);
    expect(result.valid).toBe(true);
  });

  it("gate 4: rejects missing label_horizon_bars", () => {
    const signals: Record<string, unknown>[] = [
      validSignal({ label_horizon_bars: undefined }),
    ];
    const envelope = validEnvelope({ signals });
    const result = validateSidecarEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.reason!.toLowerCase()).toContain("label_horizon_bars");
  });

  it("gate 4: rejects zero label_horizon_bars", () => {
    const signals: Record<string, unknown>[] = [
      validSignal({ label_horizon_bars: 0 }),
    ];
    const envelope = validEnvelope({ signals });
    const result = validateSidecarEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.reason!.toLowerCase()).toContain("label_horizon_bars");
  });

  it("gate 4: rejects missing bar_interval_ms", () => {
    const signals: Record<string, unknown>[] = [
      validSignal({ bar_interval_ms: undefined }),
    ];
    const envelope = validEnvelope({ signals });
    const result = validateSidecarEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.reason!.toLowerCase()).toContain("bar_interval_ms");
  });

  it("gate 5: passes all gates for fully valid envelope", () => {
    const envelope = validEnvelope();
    const result = validateSidecarEnvelope(envelope);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ── 2. computeCurrentSlotId — hourly slot boundaries ─────────────────

describe("v5 plan - computeCurrentSlotId boundaries", () => {
  it("slot 00: hour 0 to 3", () => {
    expect(computeCurrentSlotId(new Date("2026-05-11T00:00:00Z"))).toBe("slot-20260511-00");
    expect(computeCurrentSlotId(new Date("2026-05-11T01:30:00Z"))).toBe("slot-20260511-00");
    expect(computeCurrentSlotId(new Date("2026-05-11T03:59:59Z"))).toBe("slot-20260511-00");
  });

  it("slot 04: hour 4 to 7", () => {
    expect(computeCurrentSlotId(new Date("2026-05-11T04:00:00Z"))).toBe("slot-20260511-04");
    expect(computeCurrentSlotId(new Date("2026-05-11T05:30:00Z"))).toBe("slot-20260511-04");
    expect(computeCurrentSlotId(new Date("2026-05-11T07:59:59Z"))).toBe("slot-20260511-04");
  });

  it("slot 08: hour 8 to 11", () => {
    expect(computeCurrentSlotId(new Date("2026-05-11T08:00:00Z"))).toBe("slot-20260511-08");
    expect(computeCurrentSlotId(new Date("2026-05-11T10:30:00Z"))).toBe("slot-20260511-08");
    expect(computeCurrentSlotId(new Date("2026-05-11T11:59:59Z"))).toBe("slot-20260511-08");
  });

  it("slot 12: hour 12 to 15", () => {
    expect(computeCurrentSlotId(new Date("2026-05-11T12:00:00Z"))).toBe("slot-20260511-12");
    expect(computeCurrentSlotId(new Date("2026-05-11T14:00:00Z"))).toBe("slot-20260511-12");
    expect(computeCurrentSlotId(new Date("2026-05-11T15:59:59Z"))).toBe("slot-20260511-12");
  });

  it("slot 16: hour 16 to 19", () => {
    expect(computeCurrentSlotId(new Date("2026-05-11T16:00:00Z"))).toBe("slot-20260511-16");
    expect(computeCurrentSlotId(new Date("2026-05-11T18:30:00Z"))).toBe("slot-20260511-16");
    expect(computeCurrentSlotId(new Date("2026-05-11T19:59:59Z"))).toBe("slot-20260511-16");
  });

  it("slot 20: hour 20 to 23", () => {
    expect(computeCurrentSlotId(new Date("2026-05-11T20:00:00Z"))).toBe("slot-20260511-20");
    expect(computeCurrentSlotId(new Date("2026-05-11T22:30:00Z"))).toBe("slot-20260511-20");
    expect(computeCurrentSlotId(new Date("2026-05-11T23:59:59Z"))).toBe("slot-20260511-20");
  });

  it("defaults to current time when no argument provided", () => {
    const slot = computeCurrentSlotId();
    expect(slot).toMatch(/^slot-\d{8}-(0[048]|1[26]|20)$/);
  });

  it("handles end-of-month boundary", () => {
    expect(computeCurrentSlotId(new Date("2026-01-31T23:59:59Z"))).toBe("slot-20260131-20");
    expect(computeCurrentSlotId(new Date("2026-02-01T00:00:00Z"))).toBe("slot-20260201-00");
  });

  it("handles year boundary", () => {
    expect(computeCurrentSlotId(new Date("2026-12-31T23:59:59Z"))).toBe("slot-20261231-20");
    expect(computeCurrentSlotId(new Date("2027-01-01T00:00:00Z"))).toBe("slot-20270101-00");
  });
});

// ── 3. Bps conversion utilities ──────────────────────────────────────

describe("v5 plan - integer bps conversions", () => {
  describe("pctToBps", () => {
    it("converts whole percentages", () => {
      expect(pctToBps(0)).toBe(0);
      expect(pctToBps(1)).toBe(100);
      expect(pctToBps(50)).toBe(5000);
      expect(pctToBps(100)).toBe(10000);
    });

    it("converts fractional percentages", () => {
      expect(pctToBps(0.02)).toBe(2);
      expect(pctToBps(0.5)).toBe(50);
      expect(pctToBps(99.99)).toBe(9999);
    });

    it("handles negative percentages", () => {
      expect(pctToBps(-50)).toBe(-5000);
      expect(pctToBps(-100)).toBe(-10000);
    });
  });

  describe("floatToBps", () => {
    it("converts decimal fractions", () => {
      expect(floatToBps(0)).toBe(0);
      expect(floatToBps(0.5)).toBe(5000);
      expect(floatToBps(1.0)).toBe(10000);
      expect(floatToBps(0.02)).toBe(200);
    });

    it("handles small values with precision", () => {
      expect(floatToBps(0.0001)).toBe(1);
      expect(floatToBps(0.00015, 1)).toBe(2);
    });

    it("handles negative fractions", () => {
      expect(floatToBps(-0.5)).toBe(-5000);
      expect(floatToBps(-1.0)).toBe(-10000);
    });

    it("handles overflow values", () => {
      expect(floatToBps(2.5)).toBe(25000);
      expect(floatToBps(10.0)).toBe(100000);
    });
  });

  describe("bpsToPct", () => {
    it("converts bps back to percentage", () => {
      expect(bpsToPct(0)).toBe(0);
      expect(bpsToPct(100)).toBe(1);
      expect(bpsToPct(5000)).toBe(50);
      expect(bpsToPct(10000)).toBe(100);
    });

    it("handles negative bps", () => {
      expect(bpsToPct(-5000)).toBe(-50);
      expect(bpsToPct(-10000)).toBe(-100);
    });
  });

  describe("awayFromZeroRounding", () => {
    it("rounds positive values away from zero", () => {
      expect(awayFromZeroRounding(0.5)).toBe(1);
      expect(awayFromZeroRounding(1.5)).toBe(2);
      expect(awayFromZeroRounding(9999.999999)).toBe(10000);
      expect(awayFromZeroRounding(10000.000001)).toBe(10000);
    });

    it("rounds negative values away from zero", () => {
      expect(awayFromZeroRounding(-0.5)).toBe(-1);
      expect(awayFromZeroRounding(-1.5)).toBe(-2);
      expect(awayFromZeroRounding(-9999.999999)).toBe(-10000);
    });

    it("handles exact integers", () => {
      expect(awayFromZeroRounding(0)).toBe(0);
      expect(awayFromZeroRounding(42)).toBe(42);
      expect(awayFromZeroRounding(-42)).toBe(-42);
    });

    it("rounds .5 cases consistently away from zero", () => {
      // Away-from-zero: .5 goes up for positive, down for negative
      expect(awayFromZeroRounding(2.5)).toBe(3);
      expect(awayFromZeroRounding(-2.5)).toBe(-3);
      // Math.round(2.5) would be 3 (same), Math.round(-2.5) would be -2 (different!)
    });
  });

  describe("round-trip consistency", () => {
    it("pctToBps then bpsToPct returns original for common values", () => {
      const values = [0, 1, 5, 25, 50, 75, 99.99, 100];
      for (const v of values) {
        expect(bpsToPct(pctToBps(v))).toBeCloseTo(v, 10);
      }
    });

    it("floatToBps then bpsToPct returns original for common values", () => {
      const values = [0, 0.01, 0.25, 0.5, 0.75, 1.0];
      for (const v of values) {
        expect(bpsToPct(floatToBps(v))).toBeCloseTo(v * 100, 10);
      }
    });
  });
});

// ── 4. cryptoDlSignalV1Schema — valid/invalid signals ────────────────

describe("v5 plan - CryptoDlSignalV1 schema", () => {
  it("accepts fully valid signal", () => {
    const result = cryptoDlSignalV1Schema.parse(validSignal());
    expect(result).toBeDefined();
    expect(result.source).toBe("cryptotrade");
    expect(result.target_position_bps).toBe(200);
  });

  it("accepts zero target_position_bps (neutral signal)", () => {
    const result = cryptoDlSignalV1Schema.parse(validSignal({ target_position_bps: 0 }));
    expect(result.target_position_bps).toBe(0);
  });

  it("accepts negative target_position_bps (short)", () => {
    const result = cryptoDlSignalV1Schema.parse(validSignal({ target_position_bps: -300 }));
    expect(result.target_position_bps).toBe(-300);
  });

  it("accepts zero confidence_bps", () => {
    const result = cryptoDlSignalV1Schema.parse(validSignal({ confidence_bps: 0 }));
    expect(result.confidence_bps).toBe(0);
  });

  it("accepts max confidence_bps (10000)", () => {
    const result = cryptoDlSignalV1Schema.parse(validSignal({ confidence_bps: 10000 }));
    expect(result.confidence_bps).toBe(10000);
  });

  it("rejects non-integer target_position_bps", () => {
    expect(() => cryptoDlSignalV1Schema.parse(validSignal({ target_position_bps: 200.5 }))).toThrow();
  });

  it("rejects confidence_bps below 0", () => {
    expect(() => cryptoDlSignalV1Schema.parse(validSignal({ confidence_bps: -1 }))).toThrow();
  });

  it("rejects confidence_bps above 10000", () => {
    expect(() => cryptoDlSignalV1Schema.parse(validSignal({ confidence_bps: 10001 }))).toThrow();
  });

  it("rejects missing source", () => {
    const { source: _, ...noSource } = validSignal();
    expect(() => cryptoDlSignalV1Schema.parse(noSource)).toThrow();
  });

  it("rejects wrong source value", () => {
    expect(() => cryptoDlSignalV1Schema.parse(validSignal({ source: "tradingagents" }))).toThrow();
  });

  it("rejects missing target_position_bps", () => {
    const { target_position_bps: _, ...noBps } = validSignal();
    expect(() => cryptoDlSignalV1Schema.parse(noBps)).toThrow();
  });

  it("rejects missing label_horizon_bars", () => {
    expect(() => cryptoDlSignalV1Schema.parse(validSignal({ label_horizon_bars: undefined }))).toThrow();
  });

  it("rejects missing bar_interval_ms", () => {
    expect(() => cryptoDlSignalV1Schema.parse(validSignal({ bar_interval_ms: undefined }))).toThrow();
  });

  it("rejects missing model_id", () => {
    expect(() => cryptoDlSignalV1Schema.parse(validSignal({ model_id: "" }))).toThrow();
  });

  it("rejects empty symbol", () => {
    expect(() => cryptoDlSignalV1Schema.parse(validSignal({ symbol: "" }))).toThrow();
  });
});

// ── 5. cryptoDlSidecarEnvelopeV1Schema — valid/invalid envelopes ─────

describe("v5 plan - CryptoDlSidecarEnvelopeV1 schema", () => {
  it("accepts valid envelope with signals", () => {
    const result = cryptoDlSidecarEnvelopeV1Schema.parse(validEnvelope());
    expect(result.schema_version).toBe(1);
    expect(result.signals).toHaveLength(1);
  });

  it("accepts valid envelope with empty signals array", () => {
    const envelope = validEnvelope({ signals: [] });
    const result = cryptoDlSidecarEnvelopeV1Schema.parse(envelope);
    expect(result.signals).toHaveLength(0);
  });

  it("accepts envelope with multiple signals", () => {
    const envelope = validEnvelope({
      signals: [validSignal({ symbol: "BTC/USDT" }), validSignal({ symbol: "ETH/USDT" })],
    });
    const result = cryptoDlSidecarEnvelopeV1Schema.parse(envelope);
    expect(result.signals).toHaveLength(2);
  });

  it("accepts optional model_metadata", () => {
    const envelope = validEnvelope({
      model_metadata: { version: "1.0.0", run_id: "abc123" },
    });
    const result = cryptoDlSidecarEnvelopeV1Schema.parse(envelope);
    expect(result.model_metadata).toBeDefined();
  });

  it("rejects wrong schema_version", () => {
    expect(() => cryptoDlSidecarEnvelopeV1Schema.parse(validEnvelope({ schema_version: 2 }))).toThrow();
  });

  it("rejects missing slot_id", () => {
    const { slot_id: _, ...noSlot } = validEnvelope();
    expect(() => cryptoDlSidecarEnvelopeV1Schema.parse(noSlot)).toThrow();
  });

  it("rejects missing generated_at", () => {
    const { generated_at: _, ...noGen } = validEnvelope();
    expect(() => cryptoDlSidecarEnvelopeV1Schema.parse(noGen)).toThrow();
  });

  it("rejects invalid datetime in generated_at", () => {
    expect(() =>
      cryptoDlSidecarEnvelopeV1Schema.parse(validEnvelope({ generated_at: "not-a-date" })),
    ).toThrow();
  });

  it("rejects non-positive ttl_ms", () => {
    expect(() =>
      cryptoDlSidecarEnvelopeV1Schema.parse(validEnvelope({ ttl_ms: 0 })),
    ).toThrow();
  });

  it("rejects missing ttl_ms", () => {
    const { ttl_ms: _, ...noTTL } = validEnvelope();
    expect(() => cryptoDlSidecarEnvelopeV1Schema.parse(noTTL)).toThrow();
  });
});

// ── 6. signalHealthV1Schema — all status values ──────────────────────

describe("v5 plan - SignalHealthV1 schema", () => {
  const healthFields = {
    model_id: "m1",
    signal_id: "sig-1",
    target_end_at: new Date(Date.now() + 86400000).toISOString(),
    as_of: new Date().toISOString(),
    label_horizon_bars: 6,
    bar_interval_ms: 3600000,
  };

  it("accepts status: pending", () => {
    const result = signalHealthV1Schema.parse({ status: "pending", ...healthFields });
    expect(result.status).toBe("pending");
  });

  it("accepts status: warmup", () => {
    const result = signalHealthV1Schema.parse({ status: "warmup", ...healthFields });
    expect(result.status).toBe("warmup");
  });

  it("accepts status: healthy", () => {
    const result = signalHealthV1Schema.parse({ status: "healthy", ...healthFields });
    expect(result.status).toBe("healthy");
  });

  it("accepts status: decayed", () => {
    const result = signalHealthV1Schema.parse({ status: "decayed", ...healthFields });
    expect(result.status).toBe("decayed");
  });

  it("accepts status: blocked", () => {
    const result = signalHealthV1Schema.parse({ status: "blocked", ...healthFields });
    expect(result.status).toBe("blocked");
  });

  it("rejects invalid status value", () => {
    expect(() =>
      signalHealthV1Schema.parse({ status: "unknown", ...healthFields }),
    ).toThrow();
  });

  it("rejects missing status", () => {
    const { status: _, ...noStatus } = { status: "pending", ...healthFields };
    expect(() => signalHealthV1Schema.parse(noStatus)).toThrow();
  });

  it("accepts optional rank_ic", () => {
    const result = signalHealthV1Schema.parse({ status: "healthy", ...healthFields, rank_ic: 0.05 });
    expect(result.rank_ic).toBe(0.05);
  });

  it("accepts optional direction_accuracy", () => {
    const result = signalHealthV1Schema.parse({ status: "healthy", ...healthFields, direction_accuracy: 0.55 });
    expect(result.direction_accuracy).toBe(0.55);
  });

  it("accepts optional signal_decay", () => {
    const result = signalHealthV1Schema.parse({ status: "healthy", ...healthFields, signal_decay: 0.1 });
    expect(result.signal_decay).toBe(0.1);
  });

  it("accepts optional blocked_reason", () => {
    const result = signalHealthV1Schema.parse({
      status: "blocked",
      ...healthFields,
      blocked_reason: "insufficient_confidence",
    });
    expect(result.blocked_reason).toBe("insufficient_confidence");
  });
});

// ── 7. executionTopOfBookEvidenceV1Schema — valid snapshot ───────────

describe("v5 plan - ExecutionTopOfBookEvidenceV1 schema", () => {
  const validSnapshot = {
    bid: 85000.5,
    ask: 85100.25,
    mid: 85050.375,
    spread_bps: 12,
    snapshot_source: "okx",
    snapshot_at: new Date().toISOString(),
    snapshot_age_ms: 150,
  };

  it("accepts valid top-of-book snapshot", () => {
    const result = executionTopOfBookEvidenceV1Schema.parse(validSnapshot);
    expect(result.bid).toBe(85000.5);
    expect(result.ask).toBe(85100.25);
    expect(result.mid).toBe(85050.375);
  });

  it("accepts integer spread_bps", () => {
    const result = executionTopOfBookEvidenceV1Schema.parse(validSnapshot);
    expect(result.spread_bps).toBe(12);
  });

  it("accepts zero snapshot_age_ms", () => {
    const result = executionTopOfBookEvidenceV1Schema.parse({ ...validSnapshot, snapshot_age_ms: 0 });
    expect(result.snapshot_age_ms).toBe(0);
  });

  it("rejects negative snapshot_age_ms", () => {
    expect(() =>
      executionTopOfBookEvidenceV1Schema.parse({ ...validSnapshot, snapshot_age_ms: -1 }),
    ).toThrow();
  });

  it("rejects missing bid", () => {
    const { bid: _, ...noBid } = validSnapshot;
    expect(() => executionTopOfBookEvidenceV1Schema.parse(noBid)).toThrow();
  });

  it("rejects missing ask", () => {
    const { ask: _, ...noAsk } = validSnapshot;
    expect(() => executionTopOfBookEvidenceV1Schema.parse(noAsk)).toThrow();
  });

  it("rejects missing snapshot_source", () => {
    const { snapshot_source: _, ...noSource } = validSnapshot;
    expect(() => executionTopOfBookEvidenceV1Schema.parse(noSource)).toThrow();
  });

  it("rejects invalid datetime for snapshot_at", () => {
    expect(() =>
      executionTopOfBookEvidenceV1Schema.parse({ ...validSnapshot, snapshot_at: "bad-date" }),
    ).toThrow();
  });
});

// ── 8. sidecar status schema ─────────────────────────────────────────

describe("v5 plan - CryptoDlSidecarStatusV1 schema", () => {
  it("accepts ready: false as valid status object", () => {
    const status = {
      status: "running",
      slot_id: "slot-20260511-00",
      run_id: "test-run",
      started_at: new Date().toISOString(),
      finished_at: null,
      ready: false,
      signals_count: 0,
    };
    const result = cryptoDlSidecarStatusV1Schema.parse(status);
    expect(result.ready).toBe(false);
  });

  it("accepts ready: true", () => {
    const status = {
      status: "completed",
      slot_id: "slot-20260511-04",
      run_id: "test-run",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      ready: true,
      signals_count: 5,
    };
    const result = cryptoDlSidecarStatusV1Schema.parse(status);
    expect(result.ready).toBe(true);
  });

  it("accepts optional error fields", () => {
    const status = {
      status: "failed",
      slot_id: "slot-20260511-08",
      run_id: "test-run",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      ready: false,
      signals_count: 0,
      errorClass: "TimeoutError",
      errorMessage: "signal computation timed out",
    };
    const result = cryptoDlSidecarStatusV1Schema.parse(status);
    expect(result.errorClass).toBe("TimeoutError");
    expect(result.errorMessage).toBe("signal computation timed out");
  });

  it("rejects missing slot_id", () => {
    expect(() =>
      cryptoDlSidecarStatusV1Schema.parse({
        status: "running",
        run_id: "test",
        started_at: new Date().toISOString(),
        finished_at: null,
        ready: false,
        signals_count: 0,
      }),
    ).toThrow();
  });

  it("rejects negative signals_count", () => {
    expect(() =>
      cryptoDlSidecarStatusV1Schema.parse({
        status: "running",
        slot_id: "slot-20260511-00",
        run_id: "test",
        started_at: new Date().toISOString(),
        finished_at: null,
        ready: false,
        signals_count: -1,
      }),
    ).toThrow();
  });
});

// ── Note on aggregateCryptoDlSignals ─────────────────────────────────
// aggregateCryptoDlSignals is defined as a local function inside the
// main async IIFE in scripts/paper_trade_cross_sectional.ts (line 2757).
// It is NOT exported, so it cannot be directly unit-tested via import.
// The function performs confidence-weighted aggregation of crypto_dl
// signals grouped by symbol, applying a 40% disagreement threshold for
// suppression. Integration testing of the full paper_trade_cross_sectional
// pipeline (including v5 envelope ingestion) covers this function.
