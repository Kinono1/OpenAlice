import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  computeDailyExecutionSummary,
  evaluateSlippageDriftGate,
  writeDailyExecutionReport,
  type ExecutionDailySummary,
  type OrderExecutionRecord,
  type SlippageDriftGateConfig,
  type SlippageGateDecision,
} from "./execution_quality.js";
import {
  createDefaultExecutionQualityState,
  type ExecutionQualityState,
} from "./execution_quality_state.js";

export interface FinalizeExecutionDateOptions {
  writeDailyReport?: boolean;
  reportBaseDir?: string;
}

export class ExecutionQualityStore {
  static async load(
    filePath = "data/runtime/execution_quality_state.json",
  ): Promise<ExecutionQualityStore> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as ExecutionQualityState;
      return new ExecutionQualityStore(filePath, parsed);
    } catch (err: unknown) {
      if (isEnoent(err)) {
        return new ExecutionQualityStore(filePath, createDefaultExecutionQualityState());
      }
      throw err;
    }
  }

  private constructor(
    private readonly filePath: string,
    private state: ExecutionQualityState,
  ) {}

  getState(): ExecutionQualityState {
    return structuredClone(this.state);
  }

  getDailySummaries(): ExecutionDailySummary[] {
    return [...this.state.dailySummaries].sort((a, b) => a.date.localeCompare(b.date));
  }

  async addRecord(record: OrderExecutionRecord, date?: string): Promise<void> {
    const key = date ?? toDateKey(record.completedAtMs ?? record.firstFillAtMs ?? record.submittedAtMs);
    this.state.recordsByDate[key] = this.state.recordsByDate[key] ?? [];
    this.state.recordsByDate[key].push(record);
    await this.persist();
  }

  async finalizeDate(
    date: string,
    opts: FinalizeExecutionDateOptions = {},
  ): Promise<ExecutionDailySummary | null> {
    const records = this.state.recordsByDate[date] ?? [];
    if (records.length < 1) {
      return this.getSummary(date);
    }

    const summary = computeDailyExecutionSummary(date, records);
    upsertSummary(this.state.dailySummaries, summary);
    delete this.state.recordsByDate[date];
    await this.persist();

    if (opts.writeDailyReport ?? true) {
      await writeDailyExecutionReport(summary, {
        baseDir: opts.reportBaseDir ?? "data",
      });
    }

    return summary;
  }

  getSummary(date: string): ExecutionDailySummary | null {
    return this.state.dailySummaries.find((item) => item.date === date) ?? null;
  }

  async evaluateGate(config: SlippageDriftGateConfig): Promise<SlippageGateDecision> {
    const decision = evaluateSlippageDriftGate(this.getDailySummaries(), config);
    this.state.lastGateDecision = decision;
    await this.persist();
    return decision;
  }

  getLastGateDecision(): SlippageGateDecision | null {
    return this.state.lastGateDecision;
  }

  async persist(): Promise<void> {
    this.state.dailySummaries.sort((a, b) => a.date.localeCompare(b.date));
    this.state.lastUpdatedAt = new Date().toISOString();
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf-8");
  }
}

function upsertSummary(target: ExecutionDailySummary[], summary: ExecutionDailySummary): void {
  const idx = target.findIndex((item) => item.date === summary.date);
  if (idx >= 0) {
    target[idx] = summary;
    return;
  }
  target.push(summary);
}

function toDateKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
