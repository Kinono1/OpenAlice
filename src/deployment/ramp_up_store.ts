import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  evaluateRampUpSnapshot,
  getRampUpStageByIndex,
  type RampUpEvaluation,
  type RampUpEvaluatorConfig,
  type RampUpStage,
} from "./ramp_up.js";
import { createDefaultRampUpState, type RampUpDailyRecord, type RampUpState } from "./ramp_up_state.js";

export interface RampUpRecordInput {
  date: string;
  dayReturnPct: number;
  tradeCount: number;
}

export class RampUpStore {
  static async load(filePath = "data/runtime/ramp_up_state.json"): Promise<RampUpStore> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as RampUpState;
      return new RampUpStore(filePath, parsed);
    } catch (err: unknown) {
      if (isEnoent(err)) {
        return new RampUpStore(filePath, createDefaultRampUpState());
      }
      throw err;
    }
  }

  private constructor(
    private readonly filePath: string,
    private state: RampUpState,
  ) {}

  getState(): RampUpState {
    return structuredClone(this.state);
  }

  getCurrentStage(): RampUpStage {
    return getRampUpStageByIndex(this.state.stageIndex);
  }

  getCurrentStageIndex(): number {
    return this.state.stageIndex;
  }

  getStageLabelByIndex(stageIndex: number): string {
    const stage = getRampUpStageByIndex(stageIndex);
    return `${stage.allocationPct}%`;
  }

  getCurrentStageLabel(): string {
    return `${this.getCurrentStage().allocationPct}%`;
  }

  async setStageByLabel(stageLabel: string, effectiveDate?: string): Promise<void> {
    const normalized = stageLabel.trim();
    const pct = Number(normalized.replace("%", ""));
    if (!Number.isFinite(pct)) {
      throw new Error(`Invalid stage label: ${stageLabel}`);
    }

    const stages = [5, 10, 25, 50, 100];
    const stageIndex = stages.indexOf(pct);
    if (stageIndex < 0) {
      throw new Error(`Unsupported stage percentage: ${pct}`);
    }

    await this.setStageIndex(stageIndex, effectiveDate);
  }

  async setStageIndex(stageIndex: number, effectiveDate?: string): Promise<void> {
    getRampUpStageByIndex(stageIndex);
    this.state.stageIndex = stageIndex;
    this.state.stageStartDate = effectiveDate ?? new Date().toISOString().slice(0, 10);
    await this.persist();
  }

  async recordDay(
    input: RampUpRecordInput,
    config: RampUpEvaluatorConfig = {},
  ): Promise<RampUpEvaluation> {
    assertDate(input.date);
    if (!Number.isFinite(input.dayReturnPct)) {
      throw new Error("dayReturnPct must be finite.");
    }
    if (!Number.isInteger(input.tradeCount) || input.tradeCount < 0) {
      throw new Error("tradeCount must be a non-negative integer.");
    }

    upsertRecord(this.state.dailyRecords, {
      date: input.date,
      dayReturnPct: input.dayReturnPct,
      tradeCount: input.tradeCount,
    });

    const stageRecords = this.state.dailyRecords
      .filter((record) => record.date >= this.state.stageStartDate && record.date <= input.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    const elapsedDays = Math.max(1, dayDiffInclusive(this.state.stageStartDate, input.date));
    const tradingDays = stageRecords.filter((record) => record.tradeCount > 0).length;
    const trades = stageRecords.reduce((sum, record) => sum + record.tradeCount, 0);
    const maxDrawdownPct = computeMaxDrawdownPct(stageRecords);

    const evaluation = evaluateRampUpSnapshot(
      {
        stageIndex: this.state.stageIndex,
        elapsedDays,
        tradingDays,
        trades,
        maxDrawdownPct,
      },
      config,
    );

    if (evaluation.decision === "promote" || evaluation.decision === "rollback") {
      this.state.stageIndex = evaluation.targetStage.index;
      this.state.stageStartDate = input.date;
    }

    this.state.lastEvaluation = {
      date: input.date,
      evaluation,
    };
    await this.persist();
    return evaluation;
  }

  async persist(): Promise<void> {
    this.state.dailyRecords.sort((a, b) => a.date.localeCompare(b.date));
    this.state.lastUpdatedAt = new Date().toISOString();
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf-8");
  }
}

function upsertRecord(target: RampUpDailyRecord[], record: RampUpDailyRecord): void {
  const idx = target.findIndex((item) => item.date === record.date);
  if (idx >= 0) {
    target[idx] = record;
    return;
  }
  target.push(record);
}

function computeMaxDrawdownPct(records: RampUpDailyRecord[]): number {
  if (records.length < 1) {
    return 0;
  }

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const record of records) {
    equity *= 1 + record.dayReturnPct / 100;
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return maxDrawdown * 100;
}

function dayDiffInclusive(start: string, end: string): number {
  assertDate(start);
  assertDate(end);
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  const diff = Math.floor((endMs - startMs) / 86_400_000);
  return diff + 1;
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date format: ${value}. Expected YYYY-MM-DD`);
  }
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
