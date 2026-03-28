import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateMicroLiveCanary,
  evaluatePaperCanary,
  summarizeCanaryEvents,
} from "./canary_eval.js";
import { applyCanaryChecksum } from "./canary_state.js";

function makeCanaryConfig() {
  return {
    enabled: true,
    statePath: "data/runtime/canary_state.json",
    paper: {
      observationMinMinutes: 60,
      maxHeartbeatErrors: 0,
      maxGateCircuitOpen: 0,
      maxCronPaused: 0,
      maxPnlReconciliationAlerts: 0,
      maxPaperExecutorFailures: 0,
      maxIdempotencyDuplicates: 0,
      maxPendingOrderAgeMinutes: 15,
    },
    microLive: {
      maxSymbols: 1,
      maxConcurrentOpens: 1,
      maxNotionalUsd: 25,
      maxEquityPct: 0.25,
      observationMinMinutes: 60,
      maxHeartbeatErrors: 0,
      maxGateCircuitOpen: 0,
      maxCronPaused: 0,
      maxPnlReconciliationAlerts: 0,
      maxIdempotencyDuplicates: 0,
      maxStalePendingOrderAgeMinutes: 15,
      approvalTtlHours: 48,
    },
  } as const;
}

describe("canary_eval", () => {
  it("summarizes event counts inside the observation window", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "canary-events-"));
    const eventLogPath = join(tempDir, "events.jsonl");
    await writeFile(
      eventLogPath,
      [
        JSON.stringify({ seq: 1, ts: 1000, type: "heartbeat.error", payload: {} }),
        JSON.stringify({ seq: 2, ts: 2000, type: "gate.circuit_open", payload: {} }),
        JSON.stringify({ seq: 3, ts: 3000, type: "idempotency.duplicate", payload: {} }),
        JSON.stringify({ seq: 4, ts: 4000, type: "pnl.reconciliation.alert", payload: {} }),
      ].join("\n"),
      "utf-8",
    );

    const summary = await summarizeCanaryEvents(eventLogPath, 1500, 3500);
    expect(summary).toEqual({
      heartbeatErrors: 0,
      gateCircuitOpen: 1,
      cronPaused: 0,
      pnlReconciliationAlerts: 0,
      paperExecutorFailures: 0,
      idempotencyDuplicates: 1,
    });
  });

  it("passes paper canary when artifacts, health, and observation window are all clean", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "paper-canary-pass-"));
    const eventLogPath = join(tempDir, "events.jsonl");
    const preflightPath = join(tempDir, "preflight.json");
    const diagnosticPath = join(tempDir, "paper_diagnostic_status.latest.json");
    const executorPath = join(tempDir, "paper_executor_status.latest.json");
    const walletPath = join(tempDir, "wallet.json");

    await writeFile(eventLogPath, "", "utf-8");
    await writeFile(preflightPath, `${JSON.stringify({ passed: true }, null, 2)}\n`, "utf-8");
    await writeFile(
      diagnosticPath,
      `${JSON.stringify({
        generatedAt: "2026-03-18T01:00:00.000Z",
        preflight: {
          releaseGateState: "pass",
          championRegistryState: "pass",
          championRegistryReasons: [],
        },
        summary: {
          releaseGate: "PASS",
          paperGate: "PASS",
          blockingReasons: [],
        },
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      executorPath,
      `${JSON.stringify({
        generatedAt: "2026-03-18T01:00:00.000Z",
        blockingReasons: [],
        summary: {
          executor: {
            executed: 1,
            skipped: 0,
            blocked: 0,
          },
        },
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      walletPath,
      `${JSON.stringify({ commits: [], head: null }, null, 2)}\n`,
      "utf-8",
    );

    const state = applyCanaryChecksum({
      version: 1,
      phase: "paper_running",
      environment: "paper",
      allowedSymbols: ["BTC/USD"],
      limits: {},
      window: {
        startedAt: "2026-03-18T00:00:00.000Z",
        minObservationMinutes: 60,
      },
      artifacts: {
        gatesPreflightReportPath: preflightPath,
        paperDiagnosticStatusPath: diagnosticPath,
        paperExecutorStatusPath: executorPath,
        walletStatePath: walletPath,
      },
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
      lastTransitionAt: "2026-03-18T00:00:00.000Z",
    });

    const result = await evaluatePaperCanary({
      config: makeCanaryConfig(),
      state,
      now: new Date("2026-03-18T01:30:00.000Z"),
      eventLogPath,
      walletStatePath: walletPath,
      runtimeHealth: {
        connectorsHealthy: true,
        heartbeatEnabled: true,
        cryptoAccountReadable: true,
      },
    });

    expect(result.passed).toBe(true);
    expect(result.blockingReasons).toEqual([]);
  });

  it("blocks micro-live canary when runtime health degrades", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "micro-canary-block-"));
    const eventLogPath = join(tempDir, "events.jsonl");
    const walletPath = join(tempDir, "wallet.json");
    await writeFile(eventLogPath, "", "utf-8");
    await writeFile(
      walletPath,
      `${JSON.stringify({ commits: [], head: null }, null, 2)}\n`,
      "utf-8",
    );

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
        minObservationMinutes: 60,
        expiresAt: "2026-03-20T00:00:00.000Z",
      },
      artifacts: {
        walletStatePath: walletPath,
      },
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

    const result = await evaluateMicroLiveCanary({
      config: makeCanaryConfig(),
      state,
      now: new Date("2026-03-18T01:30:00.000Z"),
      eventLogPath,
      walletStatePath: walletPath,
      runtimeHealth: {
        connectorsHealthy: false,
        heartbeatEnabled: true,
        cryptoAccountReadable: true,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.blockingReasons).toContain("canary_connectors_unhealthy");
  });
});
