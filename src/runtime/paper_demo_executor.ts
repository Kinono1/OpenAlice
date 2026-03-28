import Decimal from "decimal.js";
import type { IWallet } from "../extension/crypto-trading/wallet/interfaces.js";
import type { Operation } from "../extension/crypto-trading/wallet/types.js";
import type { DecisionTicketStore } from "../extension/crypto-trading/decision-ticket.js";
import type { TradeIdempotencyStore } from "../extension/crypto-trading/idempotency-store.js";
import {
  buildPortfolioTarget,
  type PortfolioSignalInput,
  type PortfolioTargetArtifact,
} from "../portfolio/index.js";
import type {
  RuntimeFaithfulSimulationArtifact,
  SimulationCommit,
} from "./runtime_faithful_simulation.js";
import {
  buildExecutionCostReport,
  type ExecutionCostObservation,
  type ExecutionCostReportArtifact,
} from "./execution_cost_report.js";
import {
  appendPaperExecutorJournalEntry,
  hasExecutedSimulationCommit,
  type PersistedPaperExecutorJournal,
} from "./paper_executor_journal.js";

export interface PaperExecutorPlan {
  runnableCommits: SimulationCommit[];
  skippedCommitIds: string[];
  blockingReasons: string[];
}

export interface ExecutePaperExecutorCycleOptions {
  artifact: RuntimeFaithfulSimulationArtifact;
  journal: PersistedPaperExecutorJournal;
  wallet: IWallet;
  ticketStore: DecisionTicketStore;
  accountEquity: number;
  idempotencyStore?: Pick<TradeIdempotencyStore, "get">;
}

export interface ExecutePaperExecutorCycleResult {
  journal: PersistedPaperExecutorJournal;
  executedCommits: Array<{
    simulationCommitId: string;
    walletCommitHash: string;
    operationCount: number;
  }>;
  portfolioTargets: Array<{
    simulationCommitId: string;
    portfolioTarget: PortfolioTargetArtifact;
  }>;
  executionCostReport: ExecutionCostReportArtifact | null;
  skippedCommitIds: string[];
  blockingReasons: string[];
}

function roundUsdSize(value: number): number {
  return new Decimal(value).toDecimalPlaces(2).toNumber();
}

function extractIdempotencyKeys(operations: Operation[]): string[] {
  return operations
    .map((operation) => operation.params.idempotencyKey)
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
}

async function preflightIdempotency(
  commitId: string,
  keys: string[],
  store?: Pick<TradeIdempotencyStore, "get">,
): Promise<
  | { kind: "proceed" }
  | { kind: "recovered"; keys: string[] }
  | { kind: "blocked"; reason: string }
> {
  if (!store || keys.length === 0) {
    return { kind: "proceed" };
  }

  const records = await Promise.all(
    keys.map(async (key) => ({
      key,
      record: await store.get(key),
    })),
  );
  const succeeded = records.filter((item) => item.record?.status === "succeeded");
  const inProgress = records.filter(
    (item) => item.record?.status === "in_progress",
  );
  const failed = records.filter((item) => item.record?.status === "failed");

  if (inProgress.length > 0) {
    return {
      kind: "blocked",
      reason: `paper_executor_idempotency_in_progress:${commitId}:${inProgress
        .map((item) => item.key)
        .join(",")}`,
    };
  }

  if (failed.length > 0) {
    return {
      kind: "blocked",
      reason: `paper_executor_idempotency_failed:${commitId}:${failed
        .map((item) => item.key)
        .join(",")}`,
    };
  }

  if (succeeded.length === 0) {
    return { kind: "proceed" };
  }

  if (succeeded.length === keys.length) {
    return { kind: "recovered", keys };
  }

  return {
    kind: "blocked",
    reason: `paper_executor_partial_idempotency:${commitId}:${succeeded
      .map((item) => item.key)
      .join(",")}`,
  };
}

export function selectRunnableSimulationCommits(
  artifact: RuntimeFaithfulSimulationArtifact,
  journal: PersistedPaperExecutorJournal,
): PaperExecutorPlan {
  const skippedCommitIds = artifact.commits
    .filter((commit) => hasExecutedSimulationCommit(journal, commit.commitId))
    .map((commit) => commit.commitId);
  const runnableCommits = artifact.commits.filter(
    (commit) => !skippedCommitIds.includes(commit.commitId),
  );
  return {
    runnableCommits,
    skippedCommitIds,
    blockingReasons: artifact.paperGate.finalAllowPaperTrading
      ? []
      : artifact.paperGate.blockingReasons,
  };
}

export function buildWalletOperationsFromSimulationCommit(
  commit: SimulationCommit,
  accountEquity: number,
  ticketStore: DecisionTicketStore,
  portfolioTarget?: PortfolioTargetArtifact | null,
): Operation[] {
  return commit.operations.map((op) => {
    if (op.action === "placeOrder") {
      const targetWeight = portfolioTarget?.targetWeights[op.symbol];
      const usdSize = roundUsdSize(
        typeof targetWeight === "number"
          ? accountEquity * Math.abs(targetWeight)
          : (accountEquity * op.sizePct) / 100,
      );
      const ticket = ticketStore.issue({
        symbol: op.symbol,
        action: "placeOrder",
        contextId: commit.commitId,
      });
      return {
        action: "placeOrder",
        params: {
          symbol: op.symbol,
          side: op.side,
          type: "market",
          usd_size: usdSize,
          reduceOnly: false,
          idempotencyKey: op.idempotencyKey,
          ticketId: ticket.ticketId,
        },
      };
    }

    return {
      action: "closePosition",
      params: {
        symbol: op.symbol,
        idempotencyKey: op.idempotencyKey,
      },
    };
  });
}

function buildPortfolioTargetForSimulationCommit(
  commit: SimulationCommit,
): PortfolioTargetArtifact | null {
  const openOperations = commit.operations.filter(
    (operation) => operation.action === "placeOrder",
  );
  if (openOperations.length === 0) {
    return null;
  }
  const signals: PortfolioSignalInput[] = openOperations.map((operation) => ({
    symbol: operation.symbol,
    conviction:
      operation.side === "buy"
        ? Math.max(operation.edgeScore, 0.05)
        : -Math.max(operation.edgeScore, 0.05),
    currentWeight: operation.positionBefore === 1 ? operation.sizePct / 100 : 0,
  }));
  return buildPortfolioTarget({
    signals,
    config: {
      grossExposureCap: 1,
      perSymbolCap: 0.45,
      turnoverBudget: 0.35,
    },
  });
}

function buildExecutionCostObservation(
  commits: SimulationCommit[],
  accountEquity: number,
  portfolioTargets: ExecutePaperExecutorCycleResult["portfolioTargets"],
): ExecutionCostObservation {
  const targetByCommit = new Map(
    portfolioTargets.map((entry) => [entry.simulationCommitId, entry.portfolioTarget]),
  );
  let orderCount = 0;
  let fillCount = 0;
  let notionalUsd = 0;
  let slippageUsd = 0;
  const latencyMs: number[] = [];

  for (const commit of commits) {
    for (const operation of commit.operations) {
      const targetWeight = targetByCommit.get(commit.commitId)?.targetWeights[
        operation.symbol
      ];
      const operationNotionalUsd =
        typeof targetWeight === "number"
          ? accountEquity * Math.abs(targetWeight)
          : (accountEquity * operation.sizePct) / 100;
      orderCount += 1;
      fillCount += 1;
      notionalUsd += operationNotionalUsd;
      if (operation.expectedPrice > 0) {
        slippageUsd +=
          (Math.abs(operation.executedPrice - operation.expectedPrice) /
            operation.expectedPrice) *
          operationNotionalUsd;
      }
      latencyMs.push(
        Math.max(0, operation.submitDecisionTs - operation.signalBarCloseTs),
      );
    }
  }

  return {
    layer: "paper",
    orderCount,
    fillCount,
    notionalUsd,
    feesUsd: 0,
    slippageUsd,
    latencyMs,
  };
}

export async function executePaperExecutorCycle(
  input: ExecutePaperExecutorCycleOptions,
): Promise<ExecutePaperExecutorCycleResult> {
  const plan = selectRunnableSimulationCommits(input.artifact, input.journal);
  if (plan.blockingReasons.length > 0) {
    console.warn("[paper-executor] BLOCKED:", plan.blockingReasons);
  }
  for (const commitId of plan.skippedCommitIds) {
    console.info(`[paper-executor] already-executed: ${commitId}`);
  }
  if (!input.artifact.paperGate.finalAllowPaperTrading) {
    return {
      journal: input.journal,
      executedCommits: [],
      portfolioTargets: [],
      executionCostReport: null,
      skippedCommitIds: plan.skippedCommitIds,
      blockingReasons: plan.blockingReasons,
    };
  }

  let journal = input.journal;
  const executedCommits: ExecutePaperExecutorCycleResult["executedCommits"] = [];
  const portfolioTargets: ExecutePaperExecutorCycleResult["portfolioTargets"] = [];
  const skippedCommitIds = [...plan.skippedCommitIds];
  const blockingReasons = [...plan.blockingReasons];

  for (const commit of plan.runnableCommits) {
    console.info(
      `[paper-executor] attempt: ${commit.commitId} operations=${commit.operations.length}`,
    );
    const portfolioTarget = buildPortfolioTargetForSimulationCommit(commit);
    if (portfolioTarget) {
      portfolioTargets.push({
        simulationCommitId: commit.commitId,
        portfolioTarget,
      });
    }
    const operations = buildWalletOperationsFromSimulationCommit(
      commit,
      input.accountEquity,
      input.ticketStore,
      portfolioTarget,
    );
    const idempotencyKeys = extractIdempotencyKeys(operations);
    const idempotencyPreflight = await preflightIdempotency(
      commit.commitId,
      idempotencyKeys,
      input.idempotencyStore,
    );

    if (idempotencyPreflight.kind === "recovered") {
      journal = appendPaperExecutorJournalEntry(journal, {
        simulationCommitId: commit.commitId,
        walletCommitHash: `recovered:${commit.commitId}`,
        executedAt: new Date().toISOString(),
        operationCount: operations.length,
        strategyFamily: input.artifact.strategyFamily,
        registryChecksum: input.artifact.registryChecksum,
      });
      skippedCommitIds.push(commit.commitId);
      console.info(
        `[paper-executor] recovered-from-idempotency: ${commit.commitId} keys=${idempotencyPreflight.keys.join(",")}`,
      );
      continue;
    }

    if (idempotencyPreflight.kind === "blocked") {
      console.warn(
        `[paper-executor] blocked-by-idempotency: ${commit.commitId} reason=${idempotencyPreflight.reason}`,
      );
      blockingReasons.push(idempotencyPreflight.reason);
      break;
    }

    for (const operation of operations) {
      input.wallet.add(operation);
    }
    const prepared = input.wallet.commit(
      `paper-executor:${input.artifact.strategyFamily}:${commit.commitId}`,
    );
    const pushResult = await input.wallet.push();
    if (pushResult.rejected.length > 0) {
      const reason = `paper_executor_commit_failed:${commit.commitId}`;
      console.warn(
        `[paper-executor] failed: ${commit.commitId} rejected=${pushResult.rejected.length}`,
      );
      blockingReasons.push(reason);
      break;
    }

    journal = appendPaperExecutorJournalEntry(journal, {
      simulationCommitId: commit.commitId,
      walletCommitHash: prepared.hash,
      executedAt: new Date().toISOString(),
      operationCount: operations.length,
      strategyFamily: input.artifact.strategyFamily,
      registryChecksum: input.artifact.registryChecksum,
    });
    executedCommits.push({
      simulationCommitId: commit.commitId,
      walletCommitHash: prepared.hash,
      operationCount: operations.length,
    });
    console.info(
      `[paper-executor] success: ${commit.commitId} walletCommitHash=${prepared.hash} operations=${operations.length}`,
    );
  }

  return {
    journal,
    executedCommits,
    portfolioTargets,
    executionCostReport:
      executedCommits.length > 0
        ? buildExecutionCostReport({
            observations: [
              buildExecutionCostObservation(
                plan.runnableCommits.filter((commit) =>
                  executedCommits.some(
                    (executed) =>
                      executed.simulationCommitId === commit.commitId,
                  ),
                ),
                input.accountEquity,
                portfolioTargets,
              ),
            ],
          })
        : null,
    skippedCommitIds,
    blockingReasons,
  };
}
