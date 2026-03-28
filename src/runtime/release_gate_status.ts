import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReleaseGateCheck, ReleaseGateResult } from "../backtest/release_gate.js";

export interface PersistedReleaseGateStatus {
  version: 1;
  generatedAt: string;
  allowPaperTrading: boolean;
  allowLiveTrading: boolean;
  failedChecks: ReleaseGateCheck["name"][];
  warningChecks: ReleaseGateCheck["name"][];
  sourceReportPath?: string;
  expiresAt?: string;
}

export type ReleaseGateMode = "paper" | "live";
export type ReleaseGateProvenance =
  | "missing"
  | "research_owned"
  | "runtime_owned"
  | "unknown";

const STRICT_UTC_ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export async function loadReleaseGateStatus(
  filePath = "data/runtime/release_gate_status.json",
): Promise<PersistedReleaseGateStatus | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizeReleaseGateStatus(JSON.parse(raw));
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }
}

export async function writeReleaseGateStatus(
  gate: ReleaseGateResult,
  opts?: {
    filePath?: string;
    sourceReportPath?: string;
    expiresAt?: string;
  },
): Promise<PersistedReleaseGateStatus> {
  const payload: PersistedReleaseGateStatus = {
    version: 1,
    generatedAt: new Date().toISOString(),
    allowPaperTrading: gate.allowPaperTrading,
    allowLiveTrading: gate.allowLiveTrading,
    failedChecks: gate.failedChecks,
    warningChecks: gate.warningChecks,
    sourceReportPath: opts?.sourceReportPath,
    expiresAt: opts?.expiresAt,
  };

  const filePath = opts?.filePath ?? "data/runtime/release_gate_status.json";
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return payload;
}

function evaluateGateExpiry(
  status: PersistedReleaseGateStatus | null,
  now: Date,
): { blocking: boolean; reason?: string } | null {
  if (!status) {
    return {
      blocking: true,
      reason: "release_gate_status_missing",
    };
  }

  if (status.expiresAt) {
    const expiresAt = parseStrictIsoUtcTimestamp(status.expiresAt);
    if (now.getTime() > expiresAt) {
      return {
        blocking: true,
        reason: `release_gate_status_expired:${status.expiresAt}`,
      };
    }
  }

  return null;
}

export function isPaperReleaseGateStatusBlocking(
  status: PersistedReleaseGateStatus | null,
  now: Date = new Date(),
): { blocking: boolean; reason?: string } {
  const expiry = evaluateGateExpiry(status, now);
  if (expiry) {
    return expiry;
  }

  if (!status) {
    return {
      blocking: true,
      reason: "release_gate_status_missing",
    };
  }

  if (!status.allowPaperTrading) {
    return {
      blocking: true,
      reason: `paper_release_gate_failed:${status.failedChecks.join(",") || "unknown"}`,
    };
  }

  return { blocking: false };
}

export function isLiveReleaseGateStatusBlocking(
  status: PersistedReleaseGateStatus | null,
  now: Date = new Date(),
): { blocking: boolean; reason?: string } {
  const expiry = evaluateGateExpiry(status, now);
  if (expiry) {
    return expiry;
  }

  if (!status) {
    return {
      blocking: true,
      reason: "release_gate_status_missing",
    };
  }

  if (!status.allowLiveTrading) {
    return {
      blocking: true,
      reason: `release_gate_failed:${status.failedChecks.join(",") || "unknown"}`,
    };
  }

  return { blocking: false };
}

export function isReleaseGateStatusBlocking(
  status: PersistedReleaseGateStatus | null,
  now: Date = new Date(),
  mode?: ReleaseGateMode,
): { blocking: boolean; reason?: string } {
  if (mode === "paper") {
    return isPaperReleaseGateStatusBlocking(status, now);
  }
  if (mode === "live") {
    return isLiveReleaseGateStatusBlocking(status, now);
  }

  const expiry = evaluateGateExpiry(status, now);
  if (expiry) {
    return expiry;
  }

  if (!status) {
    return {
      blocking: true,
      reason: "release_gate_status_missing",
    };
  }

  if (!status.allowPaperTrading && !status.allowLiveTrading) {
    return {
      blocking: true,
      reason: `release_gate_failed:${status.failedChecks.join(",") || "unknown"}`,
    };
  }

  return { blocking: false };
}

export function normalizeReleaseGateStatus(
  raw: unknown,
): PersistedReleaseGateStatus {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid release gate status payload.");
  }
  const value = raw as Partial<PersistedReleaseGateStatus>;
  if (value.version !== 1) {
    throw new Error("Unsupported release gate status version.");
  }
  if (
    typeof value.generatedAt !== "string" ||
    typeof value.allowPaperTrading !== "boolean" ||
    typeof value.allowLiveTrading !== "boolean" ||
    !Array.isArray(value.failedChecks) ||
    !Array.isArray(value.warningChecks)
  ) {
    throw new Error("Malformed release gate status.");
  }
  assertStrictIsoUtc("generatedAt", value.generatedAt);
  if (value.expiresAt !== undefined) {
    assertStrictIsoUtc("expiresAt", value.expiresAt);
  }
  return {
    version: 1,
    generatedAt: value.generatedAt,
    allowPaperTrading: value.allowPaperTrading,
    allowLiveTrading: value.allowLiveTrading,
    failedChecks: value.failedChecks,
    warningChecks: value.warningChecks,
    sourceReportPath: value.sourceReportPath,
    expiresAt: value.expiresAt,
  };
}

export function classifyReleaseGateProvenance(
  status: PersistedReleaseGateStatus | null,
): { classification: ReleaseGateProvenance; reason?: string } {
  if (!status) {
    return {
      classification: "missing",
      reason: "release_gate_status_missing",
    };
  }

  const source = status.sourceReportPath?.trim();
  if (!source) {
    return {
      classification: "unknown",
      reason: "release_gate_source_report_missing",
    };
  }

  const normalized = source.replace(/\\/g, "/");
  if (
    normalized.includes("/data/runtime/") ||
    normalized.endsWith("/runtime_faithful_simulation.latest.json") ||
    normalized.endsWith("/paper_executor_status.latest.json") ||
    normalized.endsWith("/paper_diagnostic_status.latest.json")
  ) {
    return {
      classification: "runtime_owned",
      reason: `release_gate_provenance_runtime_owned:${source}`,
    };
  }

  if (
    normalized.includes("/data/research/") ||
    normalized.includes("/docs/research/")
  ) {
    return {
      classification: "research_owned",
    };
  }

  return {
    classification: "unknown",
    reason: `release_gate_provenance_unknown:${source}`,
  };
}

export function isReleaseGateResearchOwned(
  status: PersistedReleaseGateStatus | null,
): { ok: boolean; classification: ReleaseGateProvenance; reason?: string } {
  const provenance = classifyReleaseGateProvenance(status);
  return {
    ok: provenance.classification === "research_owned",
    classification: provenance.classification,
    reason: provenance.reason,
  };
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function parseStrictIsoUtcTimestamp(value: string): number {
  assertStrictIsoUtc("timestamp", value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid strict ISO-8601 UTC timestamp: ${value}`);
  }
  return parsed;
}

function assertStrictIsoUtc(field: string, value: string): void {
  if (!STRICT_UTC_ISO_8601.test(value)) {
    throw new Error(`${field} must be a strict ISO-8601 UTC timestamp.`);
  }
}
