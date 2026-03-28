import type { MarketData } from "../extension/analysis-kit/data/interfaces.js";
import {
  evaluateStrategy,
  getStrategyMinimumBars,
} from "../extension/strategy-tools/strategies.js";
import type {
  StrategyDecision,
  StrategyName,
  StrategyParams,
} from "../extension/strategy-tools/types.js";
import type { LiveMarketDataBar } from "./live_gate_manager.js";
import {
  evaluatePaperGateStatus,
  type PersistedPaperGateStatus,
} from "./paper_gate_status.js";
import {
  type PaperChampionRegistry,
  type RuntimeChampionExpectations,
  validatePaperChampionRegistryForRuntime,
} from "./paper_champion_registry.js";
import type { PersistedReleaseGateStatus } from "./release_gate_status.js";
import {
  isExecutionIntentStale,
  validateExecutionIntent,
  type ExecutionIntent,
} from "./execution_semantics.js";
import {
  evaluateDataContract,
  type DataContractConfig,
} from "./data_contract.js";

export interface SimulationRuntimeFlags {
  runtimeHealthy: boolean;
  dataFresh: boolean;
  connectorHealthy: boolean;
  riskLimitsLoaded: boolean;
  paperExecutorEnabled: boolean;
}

export interface SimulationVetoDecision {
  decision: "approve" | "downsize" | "skip";
  reasonCode: string;
}

export interface SimulationCandidateIntent extends ExecutionIntent {
  expectedPrice: number;
  action: "placeOrder" | "closePosition";
  sizePct: number;
  edgeScore: number;
  strategy: StrategyName;
}

export interface SimulationOperation {
  symbol: string;
  action: "placeOrder" | "closePosition";
  side: "buy" | "sell";
  reduceOnly: boolean;
  idempotencyKey: string;
  signalBarCloseTs: number;
  submitDecisionTs: number;
  expectedPrice: number;
  executedPrice: number;
  sizePct: number;
  edgeScore: number;
  vetoDecision: SimulationVetoDecision["decision"];
  vetoReasonCode: string;
  positionBefore: 0 | 1;
  positionAfter: 0 | 1;
}

export interface SimulationCommit {
  commitId: string;
  barCloseTs: number;
  operations: SimulationOperation[];
}

export interface RuntimeFaithfulSimulationArtifact {
  schemaVersion: "runtime_faithful_simulation.v1";
  generatedAt: string;
  strategyFamily: string;
  strategyRuntime: StrategyName | null;
  registryChecksum?: string;
  championValidation: ReturnType<typeof validatePaperChampionRegistryForRuntime>;
  paperGate: PersistedPaperGateStatus;
  dataContractBySymbol: Record<string, ReturnType<typeof evaluateDataContract>>;
  commonBarCount: number;
  commits: SimulationCommit[];
  finalPositions: Record<string, 0 | 1>;
  summary: {
    commitCount: number;
    operationCount: number;
    openCount: number;
    closeCount: number;
    skippedByPaperGate: boolean;
    skippedByEventBlock: number;
    skippedByVeto: number;
    skippedByCorrelation: number;
    staleIntentCount: number;
  };
  blockingReasons: string[];
}

export interface RuntimeFaithfulSimulationInput {
  registry: PaperChampionRegistry | null;
  releaseGateStatus: PersistedReleaseGateStatus | null;
  barsBySymbol: Record<string, LiveMarketDataBar[]>;
  runtimeFlags: SimulationRuntimeFlags;
  expectations?: RuntimeChampionExpectations;
  dataContractConfig?: Partial<DataContractConfig>;
  vetoDecider?: (
    candidate: SimulationCandidateIntent,
  ) => SimulationVetoDecision;
  eventBlockChecker?: (
    symbol: string,
    signalBarCloseTs: number,
  ) => string[];
}

function logDataContractSummaries(
  dataContractBySymbol: Record<string, ReturnType<typeof evaluateDataContract>>,
): void {
  for (const [symbol, result] of Object.entries(dataContractBySymbol)) {
    const status = result.dataQualityValid ? "PASS" : "BLOCKED";
    const reasons =
      result.blockingReasons.length > 0
        ? ` reasons=${result.blockingReasons.join(",")}`
        : "";
    console.info(`[simulation] data contract ${status}: ${symbol}${reasons}`);
  }
}

function logSimulationSummary(
  artifact: Pick<
    RuntimeFaithfulSimulationArtifact,
    "paperGate" | "blockingReasons" | "dataContractBySymbol" | "summary"
  >,
): void {
  if (!artifact.paperGate.finalAllowPaperTrading) {
    console.warn("[simulation] paper gate BLOCKED:", artifact.paperGate.blockingReasons);
  }
  logDataContractSummaries(artifact.dataContractBySymbol);
  console.info(
    `[simulation] summary: commits=${artifact.summary.commitCount} operations=${artifact.summary.operationCount} skippedByPaperGate=${artifact.summary.skippedByPaperGate} skippedByEventBlock=${artifact.summary.skippedByEventBlock} skippedByVeto=${artifact.summary.skippedByVeto} skippedByCorrelation=${artifact.summary.skippedByCorrelation} staleIntentCount=${artifact.summary.staleIntentCount}`,
  );
  if (artifact.blockingReasons.length > 0) {
    console.info(
      `[simulation] blocking reasons: ${artifact.blockingReasons.join(",")}`,
    );
  }
}

const FIXED_OPEN_SIZE_PCT = 15;
const DOWNSIZED_OPEN_SIZE_PCT = 7.5;
const MAX_CONCURRENT_POSITIONS = 2;
const CORRELATED_EXPOSURE_CAP_PCT = 25;
const CORRELATION_THRESHOLD = 0.75;
const FAST_CORR_LOOKBACK = 24 * 7;
const SLOW_CORR_LOOKBACK = 24 * 30;
const SYMBOL_PRIORITY = ["BTC/USD", "ETH/USD", "SOL/USD"];

const STRATEGY_FAMILY_TO_RUNTIME: Record<string, StrategyName | null> = {
  vol_gated_breakout: "volBreakout",
  vol_gated_trend: "volTrend",
  mixed_directional_gate: null,
};

function defaultVetoDecider(): SimulationVetoDecision {
  return {
    decision: "approve",
    reasonCode: "default_approve",
  };
}

function toTsOpenMs(bar: LiveMarketDataBar): number {
  return bar.tsOpenMs ?? bar.time * 1000;
}

function toBarIntervalMs(bar: LiveMarketDataBar): number {
  return bar.barIntervalMs ?? 60 * 60 * 1000;
}

function toBarCloseMs(bar: LiveMarketDataBar): number {
  return bar.barCloseMs ?? toTsOpenMs(bar) + toBarIntervalMs(bar);
}

function toMarketData(bar: LiveMarketDataBar): MarketData {
  return {
    symbol: bar.symbol,
    time: Math.floor(toTsOpenMs(bar) / 1000),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}

function buildAlignedTimeline(
  barsBySymbol: Record<string, LiveMarketDataBar[]>,
  symbols: string[],
): { closeTimeline: number[]; indexBySymbolAndCloseTs: Record<string, Map<number, number>> } {
  const indexBySymbolAndCloseTs: Record<string, Map<number, number>> = {};
  const sets: Array<Set<number>> = [];

  for (const symbol of symbols) {
    const bars = [...(barsBySymbol[symbol] ?? [])].sort(
      (a, b) => toBarCloseMs(a) - toBarCloseMs(b),
    );
    const closeToIndex = new Map<number, number>();
    for (let idx = 0; idx < bars.length; idx++) {
      closeToIndex.set(toBarCloseMs(bars[idx]), idx);
    }
    indexBySymbolAndCloseTs[symbol] = closeToIndex;
    sets.push(new Set(closeToIndex.keys()));
  }

  if (sets.length === 0) {
    return { closeTimeline: [], indexBySymbolAndCloseTs };
  }

  const [first, ...rest] = sets;
  const closeTimeline = [...first]
    .filter((ts) => rest.every((set) => set.has(ts)))
    .sort((a, b) => a - b);

  return { closeTimeline, indexBySymbolAndCloseTs };
}

function computeEdgeScore(decision: StrategyDecision): number {
  const indicators = decision.indicators;
  let score = 0;
  const smaDiffPct =
    typeof indicators.smaDiffPct === "number" ? Math.abs(indicators.smaDiffPct) : 0;
  const volRatio =
    typeof indicators.volRatio === "number" ? Math.max(0, indicators.volRatio - 1) : 0;
  const close =
    typeof indicators.close === "number" ? indicators.close : undefined;
  const breakoutHigh =
    typeof indicators.breakoutHigh === "number" ? indicators.breakoutHigh : undefined;

  score += smaDiffPct / 10;
  score += volRatio;
  if (
    typeof close === "number" &&
    typeof breakoutHigh === "number" &&
    breakoutHigh > 0 &&
    close > breakoutHigh
  ) {
    score += ((close - breakoutHigh) / breakoutHigh) * 100;
  }
  return Number(score.toFixed(6));
}

function deriveIdempotencyKey(
  symbol: string,
  signalBarCloseTs: number,
  action: "placeOrder" | "closePosition",
): string {
  const safeSymbol = symbol.replace(/[^A-Za-z0-9]+/g, "_");
  return `${safeSymbol}:${signalBarCloseTs}:${action}`;
}

function correlationFromSeries(valuesA: number[], valuesB: number[]): number {
  const n = Math.min(valuesA.length, valuesB.length);
  if (n < 3) return 0;
  const a = valuesA.slice(valuesA.length - n);
  const b = valuesB.slice(valuesB.length - n);
  const meanA = a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i++) {
    const centeredA = a[i] - meanA;
    const centeredB = b[i] - meanB;
    covariance += centeredA * centeredB;
    varianceA += centeredA * centeredA;
    varianceB += centeredB * centeredB;
  }
  if (varianceA <= 0 || varianceB <= 0) return 0;
  return covariance / Math.sqrt(varianceA * varianceB);
}

function computeRollingCorrelation(
  alignedCloses: Record<string, number[]>,
  left: string,
  right: string,
  currentIndex: number,
  lookbackBars: number,
): number {
  if (currentIndex < 2) return 0;
  const start = Math.max(1, currentIndex - lookbackBars + 1);
  const leftReturns: number[] = [];
  const rightReturns: number[] = [];
  for (let idx = start; idx <= currentIndex; idx++) {
    const leftPrev = alignedCloses[left][idx - 1];
    const leftCurrent = alignedCloses[left][idx];
    const rightPrev = alignedCloses[right][idx - 1];
    const rightCurrent = alignedCloses[right][idx];
    if (
      leftPrev > 0 &&
      leftCurrent > 0 &&
      rightPrev > 0 &&
      rightCurrent > 0
    ) {
      leftReturns.push(Math.log(leftCurrent / leftPrev));
      rightReturns.push(Math.log(rightCurrent / rightPrev));
    }
  }
  return correlationFromSeries(leftReturns, rightReturns);
}

function symbolPriority(symbol: string): number {
  const idx = SYMBOL_PRIORITY.indexOf(symbol);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

function toStrategyName(strategyFamily: string): StrategyName | null {
  return STRATEGY_FAMILY_TO_RUNTIME[strategyFamily] ?? null;
}

export function runRuntimeFaithfulSimulation(
  input: RuntimeFaithfulSimulationInput,
): RuntimeFaithfulSimulationArtifact {
  const registry = input.registry;
  const championValidation = validatePaperChampionRegistryForRuntime(
    registry,
    input.expectations,
  );
  const symbols = registry?.symbols ?? Object.keys(input.barsBySymbol);
  const dataContractBySymbol: Record<string, ReturnType<typeof evaluateDataContract>> = {};
  for (const symbol of symbols) {
    dataContractBySymbol[symbol] = evaluateDataContract(
      input.barsBySymbol[symbol] ?? [],
      input.dataContractConfig,
    );
  }

  const allDataQualityValid = Object.values(dataContractBySymbol).every(
    (result) => result.dataQualityValid,
  );
  const paperGate = evaluatePaperGateStatus({
    releaseGateStatus: input.releaseGateStatus,
    runtimeHealthy: input.runtimeFlags.runtimeHealthy,
    dataFresh: input.runtimeFlags.dataFresh,
    dataQualityValid: allDataQualityValid,
    connectorHealthy: input.runtimeFlags.connectorHealthy,
    riskLimitsLoaded: input.runtimeFlags.riskLimitsLoaded,
    paperExecutorEnabled: input.runtimeFlags.paperExecutorEnabled,
    championValidation,
  });

  const strategyRuntime = registry ? toStrategyName(registry.strategy_family) : null;
  const blockingReasons = [...paperGate.blockingReasons];
  if (registry && !strategyRuntime) {
    blockingReasons.push(
      `runtime_faithful_simulation_unsupported_family:${registry.strategy_family}`,
    );
  }

  if (!registry || !paperGate.finalAllowPaperTrading || !strategyRuntime) {
    const artifact: RuntimeFaithfulSimulationArtifact = {
      schemaVersion: "runtime_faithful_simulation.v1",
      generatedAt: new Date().toISOString(),
      strategyFamily: registry?.strategy_family ?? "unknown",
      strategyRuntime,
      registryChecksum: registry?.checksum,
      championValidation,
      paperGate,
      dataContractBySymbol,
      commonBarCount: 0,
      commits: [],
      finalPositions: Object.fromEntries(symbols.map((symbol) => [symbol, 0])),
      summary: {
        commitCount: 0,
        operationCount: 0,
        openCount: 0,
        closeCount: 0,
        skippedByPaperGate: !paperGate.finalAllowPaperTrading,
        skippedByEventBlock: 0,
        skippedByVeto: 0,
        skippedByCorrelation: 0,
        staleIntentCount: 0,
      },
      blockingReasons,
    };
    logSimulationSummary(artifact);
    return artifact;
  }

  const barsBySymbol = Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      [...(input.barsBySymbol[symbol] ?? [])].sort(
        (a, b) => toBarCloseMs(a) - toBarCloseMs(b),
      ),
    ]),
  );
  const { closeTimeline, indexBySymbolAndCloseTs } = buildAlignedTimeline(
    barsBySymbol,
    symbols,
  );
  const alignedCloses: Record<string, number[]> = Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      closeTimeline.map((closeTs) => {
        const idx = indexBySymbolAndCloseTs[symbol].get(closeTs)!;
        return barsBySymbol[symbol][idx].close;
      }),
    ]),
  );

  const params = (registry.strategy_params ?? {}) as StrategyParams;
  const minBars = getStrategyMinimumBars(strategyRuntime, params);
  const positionState: Record<string, 0 | 1> = Object.fromEntries(
    symbols.map((symbol) => [symbol, 0]),
  );
  const commits: SimulationCommit[] = [];
  let skippedByEventBlock = 0;
  let skippedByVeto = 0;
  let skippedByCorrelation = 0;
  let staleIntentCount = 0;

  for (let timelineIdx = minBars; timelineIdx < closeTimeline.length - 1; timelineIdx++) {
    const closeTs = closeTimeline[timelineIdx];
    const nextCloseTs = closeTimeline[timelineIdx + 1];
    const operations: SimulationOperation[] = [];
    const openCandidates: Array<{
      symbol: string;
      decision: StrategyDecision;
      intent: SimulationCandidateIntent;
    }> = [];

    for (const symbol of symbols) {
      const currentIdx = indexBySymbolAndCloseTs[symbol].get(closeTs)!;
      const nextIdx = indexBySymbolAndCloseTs[symbol].get(nextCloseTs)!;
      const series = barsBySymbol[symbol]
        .slice(0, currentIdx + 1)
        .map(toMarketData);
      const decision = evaluateStrategy({
        strategy: strategyRuntime,
        candles: series,
        index: series.length - 1,
        currentPosition: positionState[symbol],
        params,
      });
      const eventBlockReasons = input.eventBlockChecker?.(symbol, closeTs) ?? [];
      if (eventBlockReasons.length > 0 && positionState[symbol] === 0 && decision.signal === 1) {
        skippedByEventBlock += 1;
        continue;
      }

      const currentBar = barsBySymbol[symbol][currentIdx];
      const nextBar = barsBySymbol[symbol][nextIdx];
      const signalBarCloseTs = toBarCloseMs(currentBar);
      const submitDecisionTs = signalBarCloseTs;

      if (positionState[symbol] === 0 && decision.signal === 1) {
        openCandidates.push({
          symbol,
          decision,
          intent: {
            symbol,
            side: "buy",
            reduceOnly: false,
            idempotencyKey: deriveIdempotencyKey(symbol, signalBarCloseTs, "placeOrder"),
            signalBarCloseTs,
            submitDecisionTs,
            submitDeadlineMs: 15_000,
            orderStaleMs: 30_000,
            expectedPrice: currentBar.close,
            action: "placeOrder",
            sizePct: FIXED_OPEN_SIZE_PCT,
            edgeScore: computeEdgeScore(decision),
            strategy: strategyRuntime,
          },
        });
      } else if (positionState[symbol] === 1 && decision.signal === 0) {
        const intent: SimulationCandidateIntent = {
          symbol,
          side: "sell",
          reduceOnly: true,
          idempotencyKey: deriveIdempotencyKey(symbol, signalBarCloseTs, "closePosition"),
          signalBarCloseTs,
          submitDecisionTs,
          submitDeadlineMs: 15_000,
          orderStaleMs: 30_000,
          expectedPrice: currentBar.close,
          action: "closePosition",
          sizePct: FIXED_OPEN_SIZE_PCT,
          edgeScore: 0,
          strategy: strategyRuntime,
        };
        const validation = validateExecutionIntent(intent);
        if (!validation.valid || isExecutionIntentStale(intent, submitDecisionTs)) {
          staleIntentCount += 1;
          continue;
        }
        operations.push({
          symbol,
          action: "closePosition",
          side: "sell",
          reduceOnly: true,
          idempotencyKey: intent.idempotencyKey!,
          signalBarCloseTs,
          submitDecisionTs,
          expectedPrice: intent.expectedPrice,
          executedPrice: nextBar.open,
          sizePct: intent.sizePct,
          edgeScore: 0,
          vetoDecision: "approve",
          vetoReasonCode: "auto_exit",
          positionBefore: 1,
          positionAfter: 0,
        });
        positionState[symbol] = 0;
      }
    }

    openCandidates.sort((a, b) => {
      if (b.intent.edgeScore !== a.intent.edgeScore) {
        return b.intent.edgeScore - a.intent.edgeScore;
      }
      return symbolPriority(a.symbol) - symbolPriority(b.symbol);
    });

    for (const candidate of openCandidates) {
      const openSymbols = symbols.filter((symbol) => positionState[symbol] === 1);
      if (openSymbols.length >= MAX_CONCURRENT_POSITIONS) {
        continue;
      }
      const currentCorrBlocked = openSymbols.some((openSymbol) => {
        const fastCorr = computeRollingCorrelation(
          alignedCloses,
          openSymbol,
          candidate.symbol,
          timelineIdx,
          FAST_CORR_LOOKBACK,
        );
        const slowCorr = computeRollingCorrelation(
          alignedCloses,
          openSymbol,
          candidate.symbol,
          timelineIdx,
          SLOW_CORR_LOOKBACK,
        );
        return (
          Math.max(Math.abs(fastCorr), Math.abs(slowCorr)) >= CORRELATION_THRESHOLD &&
          FIXED_OPEN_SIZE_PCT + FIXED_OPEN_SIZE_PCT > CORRELATED_EXPOSURE_CAP_PCT
        );
      });

      let vetoDecision = (input.vetoDecider ?? defaultVetoDecider)(candidate.intent);
      let sizePct =
        vetoDecision.decision === "downsize"
          ? DOWNSIZED_OPEN_SIZE_PCT
          : candidate.intent.sizePct;

      if (currentCorrBlocked && sizePct + FIXED_OPEN_SIZE_PCT > CORRELATED_EXPOSURE_CAP_PCT) {
        skippedByCorrelation += 1;
        continue;
      }
      if (vetoDecision.decision === "skip") {
        skippedByVeto += 1;
        continue;
      }

      const validation = validateExecutionIntent(candidate.intent);
      if (!validation.valid || isExecutionIntentStale(candidate.intent, candidate.intent.submitDecisionTs)) {
        staleIntentCount += 1;
        continue;
      }

      const nextIdx = indexBySymbolAndCloseTs[candidate.symbol].get(nextCloseTs)!;
      const nextBar = barsBySymbol[candidate.symbol][nextIdx];
      operations.push({
        symbol: candidate.symbol,
        action: "placeOrder",
        side: "buy",
        reduceOnly: false,
        idempotencyKey: candidate.intent.idempotencyKey!,
        signalBarCloseTs: candidate.intent.signalBarCloseTs,
        submitDecisionTs: candidate.intent.submitDecisionTs,
        expectedPrice: candidate.intent.expectedPrice,
        executedPrice: nextBar.open,
        sizePct,
        edgeScore: candidate.intent.edgeScore,
        vetoDecision: vetoDecision.decision,
        vetoReasonCode: vetoDecision.reasonCode,
        positionBefore: 0,
        positionAfter: 1,
      });
      positionState[candidate.symbol] = 1;
    }

    if (operations.length > 0) {
      commits.push({
        commitId: `sim-${closeTs}-${operations.length}`,
        barCloseTs: closeTs,
        operations,
      });
    }
  }

  const flatOperations = commits.flatMap((commit) => commit.operations);
  const openCount = flatOperations.filter((op) => op.action === "placeOrder").length;
  const closeCount = flatOperations.filter((op) => op.action === "closePosition").length;

  const artifact: RuntimeFaithfulSimulationArtifact = {
    schemaVersion: "runtime_faithful_simulation.v1",
    generatedAt: new Date().toISOString(),
    strategyFamily: registry.strategy_family,
    strategyRuntime,
    registryChecksum: registry.checksum,
    championValidation,
    paperGate,
    dataContractBySymbol,
    commonBarCount: closeTimeline.length,
    commits,
    finalPositions: positionState,
    summary: {
      commitCount: commits.length,
      operationCount: flatOperations.length,
      openCount,
      closeCount,
      skippedByPaperGate: false,
      skippedByEventBlock,
      skippedByVeto,
      skippedByCorrelation,
      staleIntentCount,
    },
    blockingReasons,
  };
  logSimulationSummary(artifact);
  return artifact;
}
