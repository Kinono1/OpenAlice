import type { RampUpEvaluation } from "./ramp_up.js";

export interface RampUpDailyRecord {
  date: string;
  dayReturnPct: number;
  tradeCount: number;
}

export interface RampUpState {
  version: 1;
  stageIndex: number;
  stageStartDate: string;
  dailyRecords: RampUpDailyRecord[];
  lastEvaluation: {
    date: string;
    evaluation: RampUpEvaluation;
  } | null;
  lastUpdatedAt: string;
}

export function createDefaultRampUpState(now: Date = new Date()): RampUpState {
  const date = now.toISOString().slice(0, 10);
  return {
    version: 1,
    stageIndex: 0,
    stageStartDate: date,
    dailyRecords: [],
    lastEvaluation: null,
    lastUpdatedAt: now.toISOString(),
  };
}
