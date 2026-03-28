import { describe, expect, it, vi } from "vitest";
import { DecisionTicketStore } from "../extension/crypto-trading/decision-ticket.js";
import type { IWallet } from "../extension/crypto-trading/wallet/interfaces.js";
import type { TradeIdempotencyStore } from "../extension/crypto-trading/idempotency-store.js";
import {
  buildWalletOperationsFromSimulationCommit,
  executePaperExecutorCycle,
  selectRunnableSimulationCommits,
} from "./paper_demo_executor.js";
import type { RuntimeFaithfulSimulationArtifact } from "./runtime_faithful_simulation.js";

function makeArtifact(): RuntimeFaithfulSimulationArtifact {
  return {
    schemaVersion: "runtime_faithful_simulation.v1",
    generatedAt: "2026-03-14T00:00:00.000Z",
    strategyFamily: "vol_gated_trend",
    strategyRuntime: "volTrend",
    registryChecksum: "checksum",
    championValidation: {
      championLoaded: true,
      policyVersionMatch: true,
      checksumValid: true,
      blockingReasons: [],
    },
    paperGate: {
      version: 1,
      generatedAt: "2026-03-14T00:00:00.000Z",
      researchApproved: true,
      runtimeHealthy: true,
      dataFresh: true,
      dataQualityValid: true,
      connectorHealthy: true,
      riskLimitsLoaded: true,
      championLoaded: true,
      policyVersionMatch: true,
      paperExecutorEnabled: true,
      finalAllowPaperTrading: true,
      blockingReasons: [],
    },
    dataContractBySymbol: {},
    commonBarCount: 20,
    commits: [
      {
        commitId: "sim-1",
        barCloseTs: 1000,
        operations: [
          {
            symbol: "BTC/USD",
            action: "placeOrder",
            side: "buy",
            reduceOnly: false,
            idempotencyKey: "idem-1",
            signalBarCloseTs: 1000,
            submitDecisionTs: 1000,
            expectedPrice: 100,
            executedPrice: 101,
            sizePct: 15,
            edgeScore: 1.2,
            vetoDecision: "approve",
            vetoReasonCode: "default_approve",
            positionBefore: 0,
            positionAfter: 1,
          },
        ],
      },
      {
        commitId: "sim-2",
        barCloseTs: 2000,
        operations: [
          {
            symbol: "BTC/USD",
            action: "closePosition",
            side: "sell",
            reduceOnly: true,
            idempotencyKey: "idem-2",
            signalBarCloseTs: 2000,
            submitDecisionTs: 2000,
            expectedPrice: 102,
            executedPrice: 101,
            sizePct: 15,
            edgeScore: 0,
            vetoDecision: "approve",
            vetoReasonCode: "auto_exit",
            positionBefore: 1,
            positionAfter: 0,
          },
        ],
      },
    ],
    finalPositions: { "BTC/USD": 0 },
    summary: {
      commitCount: 2,
      operationCount: 2,
      openCount: 1,
      closeCount: 1,
      skippedByPaperGate: false,
      skippedByEventBlock: 0,
      skippedByVeto: 0,
      skippedByCorrelation: 0,
      staleIntentCount: 0,
    },
    blockingReasons: [],
  };
}

function makeWallet(overrides: Partial<IWallet> = {}): IWallet {
  return {
    add: vi.fn(),
    commit: vi.fn((message: string) => ({
      prepared: true,
      hash: `hash-${message.length}`,
      message,
      operationCount: 1,
    })),
    push: vi.fn(async () => ({
      hash: "hash",
      message: "msg",
      operationCount: 1,
      filled: [],
      partiallyFilled: [],
      pending: [],
      rejected: [],
    })),
    log: vi.fn(() => []),
    show: vi.fn(() => null),
    status: vi.fn(() => ({
      staged: [],
      pendingMessage: null,
      head: null,
      commitCount: 0,
    })),
    sync: vi.fn(async () => ({
      hash: "sync",
      updatedCount: 0,
      updates: [],
    })),
    getPendingOrderIds: vi.fn(() => []),
    exportState: vi.fn(() => ({ commits: [], head: null })),
    setCurrentRound: vi.fn(),
    simulatePriceChange: vi.fn(async () => ({
      success: true,
      currentState: { equity: 0, unrealizedPnL: 0, positions: [] },
      simulatedState: { equity: 0, unrealizedPnL: 0, positions: [] },
      summary: { totalPnlChange: 0, worstCaseSymbol: null },
    })),
    ...overrides,
  };
}

describe("paper_demo_executor", () => {
  it("selects only unexecuted simulation commits", () => {
    const plan = selectRunnableSimulationCommits(makeArtifact(), {
      version: 1,
      lastUpdatedAt: "2026-03-14T00:00:00.000Z",
      entries: [
        {
          simulationCommitId: "sim-1",
          walletCommitHash: "hash",
          executedAt: "2026-03-14T01:00:00.000Z",
          operationCount: 1,
          strategyFamily: "vol_gated_trend",
        },
      ],
    });

    expect(plan.skippedCommitIds).toEqual(["sim-1"]);
    expect(plan.runnableCommits.map((commit) => commit.commitId)).toEqual([
      "sim-2",
    ]);
  });

  it("builds wallet operations with ticket + idempotency for opens", () => {
    const ticketStore = new DecisionTicketStore({ required: true, ttlMs: 60_000 });
    const ops = buildWalletOperationsFromSimulationCommit(
      makeArtifact().commits[0],
      10_000,
      ticketStore,
    );
    expect(ops[0].action).toBe("placeOrder");
    expect(ops[0].params.idempotencyKey).toBe("idem-1");
    expect(typeof ops[0].params.ticketId).toBe("string");
    expect(ops[0].params.usd_size).toBe(1500);
  });

  it("uses decimal rounding for usd size and preserves idempotency on closes", () => {
    const artifact = makeArtifact();
    artifact.commits[0].operations[0].sizePct = 100;
    const openOps = buildWalletOperationsFromSimulationCommit(
      artifact.commits[0],
      1.005,
      new DecisionTicketStore({ required: true, ttlMs: 60_000 }),
    );
    const closeOps = buildWalletOperationsFromSimulationCommit(
      artifact.commits[1],
      10_000,
      new DecisionTicketStore({ required: true, ttlMs: 60_000 }),
    );

    expect(openOps[0].params.usd_size).toBe(1.01);
    expect(closeOps[0].params.idempotencyKey).toBe("idem-2");
  });

  it("executes runnable simulation commits and appends the journal", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const wallet = makeWallet();
    const ticketStore = new DecisionTicketStore({ required: true, ttlMs: 60_000 });
    const result = await executePaperExecutorCycle({
      artifact: makeArtifact(),
      journal: {
        version: 1,
        lastUpdatedAt: "2026-03-14T00:00:00.000Z",
        entries: [],
      },
      wallet,
      ticketStore,
      accountEquity: 10_000,
    });

    expect(result.executedCommits).toHaveLength(2);
    expect(result.portfolioTargets).toHaveLength(1);
    expect(result.executionCostReport?.schemaVersion).toBe(
      "execution_cost_report.v1",
    );
    expect(result.journal.entries).toHaveLength(2);
    expect(wallet.add).toHaveBeenCalledTimes(2);
    expect(wallet.commit).toHaveBeenCalledTimes(2);
    expect(wallet.push).toHaveBeenCalledTimes(2);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[paper-executor] attempt: sim-1"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[paper-executor] success: sim-2"),
    );
  });

  it("logs blocked executor and already executed commits", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const artifact = makeArtifact();
    artifact.paperGate.finalAllowPaperTrading = false;
    artifact.paperGate.blockingReasons = [
      "paper_research_not_approved",
      "paper_champion_registry_missing",
    ];

    const result = await executePaperExecutorCycle({
      artifact,
      journal: {
        version: 1,
        lastUpdatedAt: "2026-03-14T00:00:00.000Z",
        entries: [
          {
            simulationCommitId: "sim-1",
            walletCommitHash: "hash",
            executedAt: "2026-03-14T01:00:00.000Z",
            operationCount: 1,
            strategyFamily: "vol_gated_trend",
          },
        ],
      },
      wallet: makeWallet(),
      ticketStore: new DecisionTicketStore({ required: true, ttlMs: 60_000 }),
      accountEquity: 10_000,
    });

    expect(result.executedCommits).toHaveLength(0);
    expect(result.portfolioTargets).toHaveLength(0);
    expect(result.executionCostReport).toBeNull();
    expect(result.skippedCommitIds).toEqual(["sim-1"]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[paper-executor] BLOCKED:",
      artifact.paperGate.blockingReasons,
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[paper-executor] already-executed: sim-1",
    );
  });

  it("recovers a commit from succeeded idempotency keys without re-pushing", async () => {
    const wallet = makeWallet();
    const get = vi.fn(async () => ({
      key: "idem-1",
      status: "succeeded" as const,
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 3,
      orderId: "ord-1",
    }));

    const result = await executePaperExecutorCycle({
      artifact: {
        ...makeArtifact(),
        commits: [makeArtifact().commits[0]],
      },
      journal: {
        version: 1,
        lastUpdatedAt: "2026-03-14T00:00:00.000Z",
        entries: [],
      },
      wallet,
      ticketStore: new DecisionTicketStore({ required: true, ttlMs: 60_000 }),
      accountEquity: 10_000,
      idempotencyStore: { get } satisfies Pick<TradeIdempotencyStore, "get">,
    });

    expect(result.executedCommits).toHaveLength(0);
    expect(result.executionCostReport).toBeNull();
    expect(result.journal.entries).toHaveLength(1);
    expect(result.journal.entries[0].walletCommitHash).toBe("recovered:sim-1");
    expect(wallet.push).not.toHaveBeenCalled();
  });

  it("blocks when idempotency store shows partial prior execution", async () => {
    const wallet = makeWallet();
    const artifact = makeArtifact();
    artifact.commits = [
      {
        ...artifact.commits[0],
        operations: [
          artifact.commits[0].operations[0],
          {
            ...artifact.commits[0].operations[0],
            idempotencyKey: "idem-1b",
          },
        ],
      },
    ];
    const get = vi.fn(async (key: string) =>
      key === "idem-1"
        ? {
            key,
            status: "succeeded" as const,
            createdAt: 1,
            updatedAt: 2,
            expiresAt: 3,
            orderId: "ord-1",
          }
        : null,
    );

    const result = await executePaperExecutorCycle({
      artifact,
      journal: {
        version: 1,
        lastUpdatedAt: "2026-03-14T00:00:00.000Z",
        entries: [],
      },
      wallet,
      ticketStore: new DecisionTicketStore({ required: true, ttlMs: 60_000 }),
      accountEquity: 10_000,
      idempotencyStore: { get } satisfies Pick<TradeIdempotencyStore, "get">,
    });

    expect(result.executedCommits).toHaveLength(0);
    expect(result.executionCostReport).toBeNull();
    expect(result.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("paper_executor_partial_idempotency:sim-1"),
      ]),
    );
    expect(wallet.push).not.toHaveBeenCalled();
  });

  it("does not append success journal when batch push rejects", async () => {
    const wallet = makeWallet({
      push: vi.fn(async () => ({
        hash: "hash",
        message: "msg",
        operationCount: 1,
        filled: [],
        partiallyFilled: [],
        pending: [],
        rejected: [
          {
            action: "placeOrder",
            success: false,
            status: "rejected",
            error: "duplicate",
          },
        ],
      })),
    });

    const result = await executePaperExecutorCycle({
      artifact: {
        ...makeArtifact(),
        commits: [makeArtifact().commits[0]],
      },
      journal: {
        version: 1,
        lastUpdatedAt: "2026-03-14T00:00:00.000Z",
        entries: [],
      },
      wallet,
      ticketStore: new DecisionTicketStore({ required: true, ttlMs: 60_000 }),
      accountEquity: 10_000,
    });

    expect(result.executedCommits).toHaveLength(0);
    expect(result.executionCostReport).toBeNull();
    expect(result.journal.entries).toHaveLength(0);
    expect(result.blockingReasons).toContain(
      "paper_executor_commit_failed:sim-1",
    );
  });
});
