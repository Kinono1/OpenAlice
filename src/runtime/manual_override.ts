import { readFile } from "node:fs/promises";

export interface ManualOverride {
  pauseNewOpens: boolean;
  ignoreReleaseGate?: boolean;
  ignoreRegimeShift?: boolean;
  forceCapitalRampStage?: string;
  forceVolatilityQuantile?: number;
  forceDailyLossPct?: number;
  forceCvarDailyLossPct?: number;
  forceConsecutiveLossDays?: number;
  forceConsecutiveLossPct?: number;
  note?: string;
  updatedAt?: string;
}

export const DEFAULT_MANUAL_OVERRIDE: ManualOverride = {
  pauseNewOpens: false,
};

export async function loadManualOverride(
  filePath = "data/runtime/manual_override.json"
): Promise<ManualOverride> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizeManualOverride(JSON.parse(raw));
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return { ...DEFAULT_MANUAL_OVERRIDE };
    }
    throw err;
  }
}

export function normalizeManualOverride(raw: unknown): ManualOverride {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_MANUAL_OVERRIDE };
  }

  const value = raw as Record<string, unknown>;
  const out: ManualOverride = {
    pauseNewOpens: Boolean(value.pauseNewOpens),
    ignoreReleaseGate: Boolean(value.ignoreReleaseGate),
    ignoreRegimeShift: Boolean(value.ignoreRegimeShift),
  };

  if (
    typeof value.forceCapitalRampStage === "string" &&
    value.forceCapitalRampStage.trim()
  ) {
    out.forceCapitalRampStage = value.forceCapitalRampStage.trim();
  }
  if (isFiniteNumber(value.forceVolatilityQuantile)) {
    out.forceVolatilityQuantile = value.forceVolatilityQuantile;
  }
  if (isFiniteNumber(value.forceDailyLossPct)) {
    out.forceDailyLossPct = value.forceDailyLossPct;
  }
  if (isFiniteNumber(value.forceCvarDailyLossPct)) {
    out.forceCvarDailyLossPct = value.forceCvarDailyLossPct;
  }
  if (isFiniteNumber(value.forceConsecutiveLossDays)) {
    out.forceConsecutiveLossDays = Math.max(
      0,
      Math.floor(value.forceConsecutiveLossDays)
    );
  }
  if (isFiniteNumber(value.forceConsecutiveLossPct)) {
    out.forceConsecutiveLossPct = value.forceConsecutiveLossPct;
  }
  if (typeof value.note === "string" && value.note.trim()) {
    out.note = value.note.trim();
  }
  if (typeof value.updatedAt === "string" && value.updatedAt.trim()) {
    out.updatedAt = value.updatedAt.trim();
  }

  return out;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
