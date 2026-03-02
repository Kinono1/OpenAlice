import type {
  ExecutionDailySummary,
  OrderExecutionRecord,
  SlippageGateDecision,
} from "./execution_quality.js";

export interface ExecutionQualityState {
  version: 1;
  recordsByDate: Record<string, OrderExecutionRecord[]>;
  dailySummaries: ExecutionDailySummary[];
  lastGateDecision: SlippageGateDecision | null;
  lastUpdatedAt: string;
}

export function createDefaultExecutionQualityState(
  now: Date = new Date(),
): ExecutionQualityState {
  return {
    version: 1,
    recordsByDate: {},
    dailySummaries: [],
    lastGateDecision: null,
    lastUpdatedAt: now.toISOString(),
  };
}
