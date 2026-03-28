import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCanaryChecksum,
  assertCanaryPhaseTransition,
  createDraftCanaryState,
  evaluateLiveCanaryGate,
  safeReadCanaryState,
  writeCanaryState,
} from "./canary_state.js";

describe("canary_state", () => {
  it("writes and reads a checksum-validated canary state atomically", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openalice-canary-state-"));
    const filePath = join(tempDir, "canary_state.json");

    const written = await writeCanaryState({
      ...createDraftCanaryState(new Date("2026-03-18T00:00:00.000Z")),
      phase: "preflight_passed",
      environment: "paper",
      window: {
        minObservationMinutes: 1440,
      },
      lastTransitionAt: "2026-03-18T00:00:00.000Z",
    }, filePath);

    const loaded = await safeReadCanaryState(filePath);

    expect(written.checksum.length).toBe(64);
    expect(loaded).toEqual({ ok: true, state: written });
  });

  it("fails closed when the checksum does not match", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openalice-canary-checksum-"));
    const filePath = join(tempDir, "canary_state.json");
    const base = applyCanaryChecksum({
      version: 1,
      phase: "micro_live_running",
      environment: "micro_live",
      allowedSymbols: ["BTC/USD"],
      limits: {
        maxSymbols: 1,
        maxConcurrentOpens: 1,
        maxNotionalUsd: 25,
        maxEquityPct: 0.25,
      },
      window: {
        startedAt: "2026-03-18T00:00:00.000Z",
        minObservationMinutes: 240,
        expiresAt: "2026-03-20T00:00:00.000Z",
      },
      artifacts: {},
      metrics: {
        eventCounts: {
          heartbeatErrors: 0,
          gateCircuitOpen: 0,
          cronPaused: 0,
          pnlReconciliationAlerts: 0,
          paperExecutorFailures: 0,
          idempotencyDuplicates: 0,
        },
      },
      blockingReasons: [],
      approvedBy: "tester",
      lastTransitionAt: "2026-03-18T00:00:00.000Z",
    });

    await writeFile(
      filePath,
      `${JSON.stringify({ ...base, approvedBy: "tampered" }, null, 2)}\n`,
      "utf-8",
    );

    const loaded = await safeReadCanaryState(filePath);
    expect(loaded).toEqual({ ok: false, reason: "checksum_mismatch" });
  });

  it("fails closed on malformed JSON", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openalice-canary-parse-"));
    const filePath = join(tempDir, "canary_state.json");
    await writeFile(filePath, '{"phase":"micro_live_running"', "utf-8");

    const loaded = await safeReadCanaryState(filePath);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.reason).toBe("parse_error");
    }
  });

  it("enforces transition legality", () => {
    expect(() =>
      assertCanaryPhaseTransition("draft", "micro_live_running"),
    ).toThrow("Invalid canary phase transition");
    expect(() =>
      assertCanaryPhaseTransition("paper_passed", "micro_live_approved"),
    ).not.toThrow();
  });

  it("blocks live opens when micro-live has expired or exceeds limits", () => {
    const state = applyCanaryChecksum({
      version: 1,
      phase: "micro_live_running",
      environment: "micro_live",
      allowedSymbols: ["BTC/USD"],
      limits: {
        maxSymbols: 1,
        maxConcurrentOpens: 1,
        maxNotionalUsd: 25,
        maxEquityPct: 0.25,
      },
      window: {
        startedAt: "2026-03-18T00:00:00.000Z",
        minObservationMinutes: 240,
        expiresAt: "2026-03-18T01:00:00.000Z",
      },
      artifacts: {},
      metrics: {
        eventCounts: {
          heartbeatErrors: 0,
          gateCircuitOpen: 0,
          cronPaused: 0,
          pnlReconciliationAlerts: 0,
          paperExecutorFailures: 0,
          idempotencyDuplicates: 0,
        },
      },
      blockingReasons: [],
      approvedBy: "tester",
      lastTransitionAt: "2026-03-18T00:00:00.000Z",
    });

    const expired = evaluateLiveCanaryGate({
      state,
      request: {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 10,
      },
      now: new Date("2026-03-18T02:00:00.000Z"),
      accountEquity: 10_000,
      openPositionSymbols: [],
      expectedNotionalUsd: 10,
    });
    const overLimit = evaluateLiveCanaryGate({
      state: {
        ...state,
        window: {
          ...state.window,
          expiresAt: "2026-03-20T00:00:00.000Z",
        },
      },
      request: {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 50,
      },
      now: new Date("2026-03-18T00:10:00.000Z"),
      accountEquity: 10_000,
      openPositionSymbols: [],
      expectedNotionalUsd: 50,
    });

    expect(expired).toEqual({
      approved: false,
      reason: "canary_state_expired",
    });
    expect(overLimit.approved).toBe(false);
    expect(overLimit.reason).toContain("canary_notional_limit_exceeded");
  });
});
