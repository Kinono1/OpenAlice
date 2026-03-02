import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RampUpEvaluation } from "../deployment/ramp_up.js";
import type { ExecutionDailySummary, SlippageGateDecision } from "../live/execution_quality.js";
import type { IdempotencyGovernanceSummary } from "./idempotency_event_summary.js";
import type { ManualOverride } from "./manual_override.js";
import type { ConsecutiveLossStats, RiskBreakerState } from "./risk_breaker_state.js";
import type { RegimeShiftResult } from "./regime_shift.js";

export interface DailyGateSummary {
  date: string;
  generatedAt: string;
  capitalRampStage: string;
  executionSummary: ExecutionDailySummary | null;
  executionGateDecision: SlippageGateDecision | null;
  rampEvaluation: RampUpEvaluation | null;
  regimeShift: RegimeShiftResult | null;
  riskBreaker: RiskBreakerState;
  consecutiveLossStats: ConsecutiveLossStats;
  manualOverride: ManualOverride;
  idempotencyEvents?: IdempotencyGovernanceSummary;
  notes?: string[];
}

export interface DailyGateSummaryWriteResult {
  path: string;
  written: boolean;
}

export async function writeDailyGateSummary(
  summary: DailyGateSummary,
  opts?: { baseDir?: string },
): Promise<DailyGateSummaryWriteResult> {
  assertDate(summary.date);

  const baseDir = opts?.baseDir ?? "data/runtime";
  const outDir = join(baseDir, "gate_summaries");
  const outputPath = join(outDir, `${summary.date}.json`);

  await mkdir(outDir, { recursive: true });
  const payload = `${JSON.stringify(summary, null, 2)}\n`;

  try {
    await writeFile(outputPath, payload, { encoding: "utf-8", flag: "wx" });
    return { path: outputPath, written: true };
  } catch (err: unknown) {
    if (isEexist(err)) {
      return { path: outputPath, written: false };
    }
    throw err;
  }
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date ${value}. Expected YYYY-MM-DD.`);
  }
}

function isEexist(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
}
