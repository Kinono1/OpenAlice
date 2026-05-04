export const RAMP_UP_STAGE_SEQUENCE = [5, 10, 25, 50, 100] as const;

export type RampUpStageAllocationPct = (typeof RAMP_UP_STAGE_SEQUENCE)[number];

export interface RampUpStageThreshold {
  readonly minDurationDays: number;
  readonly maxDrawdownPct: number;
}

export interface RampUpStage extends RampUpStageThreshold {
  readonly index: number;
  readonly allocationPct: RampUpStageAllocationPct;
}

export type RampUpStageThresholdOverrides = Partial<
  Record<RampUpStageAllocationPct, Partial<RampUpStageThreshold>>
>;

export interface RampUpSampleGuards {
  readonly minTradingDays: number;
  readonly minTrades: number;
}

export interface RampUpPerformanceSnapshot {
  readonly stageIndex: number;
  readonly elapsedDays: number;
  readonly tradingDays: number;
  readonly trades: number;
  readonly maxDrawdownPct: number;
}

export type RampUpDecision = "stay" | "promote" | "rollback";

export type RampUpDecisionReason =
  | "promotion_ready"
  | "insufficient_sample"
  | "drawdown_breach"
  | "max_stage_reached"
  | "min_stage_reached";

export interface RampUpGuardStatus {
  readonly durationMet: boolean;
  readonly tradingDaysMet: boolean;
  readonly tradesMet: boolean;
}

export interface RampUpEvaluation {
  readonly decision: RampUpDecision;
  readonly reason: RampUpDecisionReason;
  readonly currentStage: RampUpStage;
  readonly targetStage: RampUpStage;
  readonly guardStatus: RampUpGuardStatus;
  readonly drawdownBreached: boolean;
}

export interface RampUpEvaluatorConfig extends Partial<RampUpSampleGuards> {
  readonly stageThresholdOverrides?: RampUpStageThresholdOverrides;
}

export const DEFAULT_RAMP_UP_STAGE_THRESHOLDS: Readonly<
  Record<RampUpStageAllocationPct, RampUpStageThreshold>
> = Object.freeze({
  5: Object.freeze({ minDurationDays: 5, maxDrawdownPct: 2.0 }),
  10: Object.freeze({ minDurationDays: 8, maxDrawdownPct: 2.5 }),
  25: Object.freeze({ minDurationDays: 12, maxDrawdownPct: 3.5 }),
  50: Object.freeze({ minDurationDays: 16, maxDrawdownPct: 4.5 }),
  100: Object.freeze({ minDurationDays: 20, maxDrawdownPct: 5.0 }),
});

export const DEFAULT_RAMP_UP_GUARDS: RampUpSampleGuards = Object.freeze({
  minTradingDays: 10,
  minTrades: 20,
});

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number.`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  assertNonNegativeFinite(value, field);
  if (!Number.isInteger(value)) {
    throw new TypeError(`${field} must be an integer.`);
  }
}

export function buildRampUpStages(
  overrides: RampUpStageThresholdOverrides = {},
): ReadonlyArray<RampUpStage> {
  return Object.freeze(
    RAMP_UP_STAGE_SEQUENCE.map((allocationPct, index) => {
      const defaultThreshold = DEFAULT_RAMP_UP_STAGE_THRESHOLDS[allocationPct];
      const override = overrides[allocationPct];
      const minDurationDays = override?.minDurationDays ?? defaultThreshold.minDurationDays;
      const maxDrawdownPct = override?.maxDrawdownPct ?? defaultThreshold.maxDrawdownPct;

      assertNonNegativeFinite(minDurationDays, `stage ${allocationPct}% minDurationDays`);
      assertNonNegativeFinite(maxDrawdownPct, `stage ${allocationPct}% maxDrawdownPct`);

      return Object.freeze({
        index,
        allocationPct,
        minDurationDays,
        maxDrawdownPct,
      });
    }),
  );
}

export const DEFAULT_RAMP_UP_STAGES: ReadonlyArray<RampUpStage> = buildRampUpStages();

export function getRampUpStageByIndex(
  stageIndex: number,
  stages: ReadonlyArray<RampUpStage> = DEFAULT_RAMP_UP_STAGES,
): RampUpStage {
  assertNonNegativeInteger(stageIndex, "stageIndex");
  if (stageIndex >= stages.length) {
    throw new RangeError(
      `stageIndex ${stageIndex} is out of range. Valid stage indexes are 0-${stages.length - 1}.`,
    );
  }
  return stages[stageIndex];
}

export function evaluateRampUpSnapshot(
  snapshot: RampUpPerformanceSnapshot,
  config: RampUpEvaluatorConfig = {},
): RampUpEvaluation {
  assertNonNegativeInteger(snapshot.stageIndex, "stageIndex");
  assertNonNegativeFinite(snapshot.elapsedDays, "elapsedDays");
  assertNonNegativeInteger(snapshot.tradingDays, "tradingDays");
  assertNonNegativeInteger(snapshot.trades, "trades");
  assertNonNegativeFinite(snapshot.maxDrawdownPct, "maxDrawdownPct");

  const minTradingDays = config.minTradingDays ?? DEFAULT_RAMP_UP_GUARDS.minTradingDays;
  const minTrades = config.minTrades ?? DEFAULT_RAMP_UP_GUARDS.minTrades;
  assertNonNegativeInteger(minTradingDays, "minTradingDays");
  assertNonNegativeInteger(minTrades, "minTrades");

  const stages = config.stageThresholdOverrides
    ? buildRampUpStages(config.stageThresholdOverrides)
    : DEFAULT_RAMP_UP_STAGES;
  const currentStage = getRampUpStageByIndex(snapshot.stageIndex, stages);

  const guardStatus: RampUpGuardStatus = {
    durationMet: snapshot.elapsedDays >= currentStage.minDurationDays,
    tradingDaysMet: snapshot.tradingDays >= minTradingDays,
    tradesMet: snapshot.trades >= minTrades,
  };

  const drawdownBreached = snapshot.maxDrawdownPct > currentStage.maxDrawdownPct;
  if (drawdownBreached) {
    if (currentStage.index === 0) {
      return {
        decision: "stay",
        reason: "min_stage_reached",
        currentStage,
        targetStage: currentStage,
        guardStatus,
        drawdownBreached,
      };
    }

    return {
      decision: "rollback",
      reason: "drawdown_breach",
      currentStage,
      targetStage: stages[currentStage.index - 1],
      guardStatus,
      drawdownBreached,
    };
  }

  const sampleReady =
    guardStatus.durationMet && guardStatus.tradingDaysMet && guardStatus.tradesMet;
  if (!sampleReady) {
    return {
      decision: "stay",
      reason: "insufficient_sample",
      currentStage,
      targetStage: currentStage,
      guardStatus,
      drawdownBreached,
    };
  }

  if (currentStage.index === stages.length - 1) {
    return {
      decision: "stay",
      reason: "max_stage_reached",
      currentStage,
      targetStage: currentStage,
      guardStatus,
      drawdownBreached,
    };
  }

  return {
    decision: "promote",
    reason: "promotion_ready",
    currentStage,
    targetStage: stages[currentStage.index + 1],
    guardStatus,
    drawdownBreached,
  };
}
