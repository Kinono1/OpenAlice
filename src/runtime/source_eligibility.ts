export type RuntimeMode = "real_runtime" | "proxy_runtime" | "unavailable" | "unknown";

export type SourceLineage =
  | "openalice_native"
  | "donor_native"
  | "donor_proxy"
  | "openalice_history_proxy"
  | "control"
  | "unknown";

export type AdmissionIntent = "exploratory" | "promotion";

export interface SourceValidity {
  runtimeMode: RuntimeMode;
  sourceLineage: SourceLineage;
  evidenceStrength: string;
  fallbackReason: string | null;
  blockers: string[];
}

export interface SourceEligibility {
  sourceValidity: SourceValidity;
  donorNative: boolean;
  promotionEligible: boolean;
  admissionIntent: AdmissionIntent;
  eligibilityBlockers: string[];
}

export interface SourceEligibilityLike {
  sourceEligibility?: Partial<SourceEligibility>;
  sourceValidity?: Partial<SourceValidity>;
  runtimeMode?: unknown;
  sourceLineage?: unknown;
  evidenceStrength?: unknown;
  fallbackReason?: unknown;
  donorNative?: unknown;
  promotionEligible?: unknown;
  admissionIntent?: unknown;
  eligibilityBlockers?: unknown;
  role?: unknown;
  provenance?: {
    mode?: unknown;
    producer?: unknown;
    evidenceStrength?: unknown;
    fallbackReason?: unknown;
    proxySource?: unknown;
    failureCode?: unknown;
  };
}

export interface ManifestSourceDefaults {
  sourceValidity?: Partial<SourceValidity>;
  donorNative?: boolean;
  promotionEligible?: boolean;
  admissionIntent?: AdmissionIntent;
  eligibilityBlockers?: string[];
}

export function resolveSourceEligibility(
  input: SourceEligibilityLike | null | undefined,
  defaults?: ManifestSourceDefaults,
): SourceEligibility {
  const runtimeMode =
    normalizeRuntimeMode(input?.sourceEligibility?.sourceValidity?.runtimeMode) ??
    normalizeRuntimeMode(input?.sourceValidity?.runtimeMode) ??
    normalizeRuntimeMode(input?.runtimeMode) ??
    normalizeRuntimeMode(defaults?.sourceValidity?.runtimeMode) ??
    normalizeRuntimeMode(input?.provenance?.mode) ??
    "unknown";
  const sourceLineage =
    normalizeSourceLineage(input?.sourceEligibility?.sourceValidity?.sourceLineage) ??
    normalizeSourceLineage(input?.sourceValidity?.sourceLineage) ??
    normalizeSourceLineage(input?.sourceLineage) ??
    normalizeSourceLineage(defaults?.sourceValidity?.sourceLineage) ??
    inferSourceLineage(input, runtimeMode);
  const evidenceStrength = stringOrNullish(
    input?.sourceEligibility?.sourceValidity?.evidenceStrength,
    input?.sourceValidity?.evidenceStrength,
    input?.evidenceStrength,
    defaults?.sourceValidity?.evidenceStrength,
    input?.provenance?.evidenceStrength,
  ) ?? (runtimeMode === "real_runtime" ? "live_or_internal" : "missing_source_metadata");
  const fallbackReason = stringOrNullish(
    input?.sourceEligibility?.sourceValidity?.fallbackReason,
    input?.sourceValidity?.fallbackReason,
    input?.fallbackReason,
    defaults?.sourceValidity?.fallbackReason,
    input?.provenance?.fallbackReason,
    input?.provenance?.failureCode,
  );
  const donorNative =
    boolOrUndefined(input?.sourceEligibility?.donorNative) ??
    boolOrUndefined(input?.donorNative) ??
    defaults?.donorNative ??
    sourceLineage === "donor_native";
  const admissionIntent =
    normalizeAdmissionIntent(input?.sourceEligibility?.admissionIntent) ??
    normalizeAdmissionIntent(input?.admissionIntent) ??
    defaults?.admissionIntent ??
    "exploratory";

  const sourceValidityBlockers = unique([
    ...toStringArray(defaults?.sourceValidity?.blockers),
    ...toStringArray(input?.sourceEligibility?.sourceValidity?.blockers),
    ...toStringArray(input?.sourceValidity?.blockers),
    ...runtimeModeBlockers(runtimeMode, fallbackReason),
  ]);

  const explicitBlockers = unique([
    ...toStringArray(defaults?.eligibilityBlockers),
    ...toStringArray(input?.sourceEligibility?.eligibilityBlockers),
    ...toStringArray(input?.eligibilityBlockers),
  ]);
  const basePromotionEligible =
    boolOrUndefined(input?.sourceEligibility?.promotionEligible) ??
    boolOrUndefined(input?.promotionEligible) ??
    defaults?.promotionEligible ??
    false;
  const derivedBlockers = deriveEligibilityBlockers({
    runtimeMode,
    sourceLineage,
    donorNative,
    admissionIntent,
    basePromotionEligible,
  });
  const eligibilityBlockers = unique([
    ...sourceValidityBlockers,
    ...explicitBlockers,
    ...derivedBlockers,
  ]);

  return {
    sourceValidity: {
      runtimeMode,
      sourceLineage,
      evidenceStrength,
      fallbackReason,
      blockers: sourceValidityBlockers,
    },
    donorNative,
    admissionIntent,
    promotionEligible: basePromotionEligible && eligibilityBlockers.length === 0,
    eligibilityBlockers,
  };
}

export function deriveManifestSourceDefaults(
  notes: unknown,
): ManifestSourceDefaults {
  const parsed = parseNotes(notes);
  const explicitRuntime = normalizeRuntimeMode(parsed.get("runtime_mode") ?? parsed.get("runtimeMode"));
  const explicitLineage = normalizeSourceLineage(parsed.get("source_lineage") ?? parsed.get("sourceLineage"));
  const explicitIntent = normalizeAdmissionIntent(parsed.get("admission_intent") ?? parsed.get("admissionIntent"));
  const explicitPromotionEligible = boolOrUndefined(
    parsed.get("promotion_eligible") ?? parsed.get("promotionEligible"),
  );
  const sourceParadigm = (parsed.get("source_paradigm") ?? parsed.get("source_id") ?? "").toLowerCase();
  const compilerMode = (parsed.get("compiler_mode") ?? "").toLowerCase();
  const reflectionSource = (parsed.get("reflection_source") ?? "").toLowerCase();
  const notDonorNative = parsed.get("not_donor_native") === "true";
  const sourceValidity: Partial<SourceValidity> = {};
  const blockers: string[] = [];

  if (explicitRuntime) {
    sourceValidity.runtimeMode = explicitRuntime;
  }
  if (explicitLineage) {
    sourceValidity.sourceLineage = explicitLineage;
  }

  if (notDonorNative) {
    sourceValidity.sourceLineage =
      reflectionSource === "openalice_paper_history"
        ? "openalice_history_proxy"
        : "donor_proxy";
    blockers.push("non_donor_native_source");
  } else if (compilerMode === "single_donor_signal") {
    sourceValidity.sourceLineage = "donor_proxy";
    blockers.push("single_donor_signal_compiler");
  } else if (
    !explicitLineage &&
    /tradingagents|cryptotrade|alphaswarm/.test(sourceParadigm)
  ) {
    sourceValidity.sourceLineage = "donor_proxy";
    blockers.push("donor_lane_exploratory_only");
  }

  const sourceLineage = normalizeSourceLineage(sourceValidity.sourceLineage) ?? "openalice_native";
  const donorNative =
    notDonorNative ? false : sourceLineage === "donor_native";
  const admissionIntent =
    explicitIntent ??
    (blockers.length > 0 || sourceLineage === "donor_proxy" || sourceLineage === "openalice_history_proxy"
      ? "exploratory"
      : "promotion");

  return {
    sourceValidity,
    donorNative,
    promotionEligible:
      explicitPromotionEligible ??
      (admissionIntent === "promotion" && blockers.length === 0),
    admissionIntent,
    eligibilityBlockers: blockers,
  };
}

export function buildSourceEligibilityFields(
  eligibility: SourceEligibility,
): Pick<SourceEligibility, "sourceValidity" | "donorNative" | "promotionEligible" | "admissionIntent" | "eligibilityBlockers"> {
  return {
    sourceValidity: eligibility.sourceValidity,
    donorNative: eligibility.donorNative,
    promotionEligible: eligibility.promotionEligible,
    admissionIntent: eligibility.admissionIntent,
    eligibilityBlockers: eligibility.eligibilityBlockers,
  };
}

function normalizeRuntimeMode(value: unknown): RuntimeMode | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) return null;
  if (
    normalized === "real_runtime" ||
    normalized === "sidecar_live" ||
    normalized === "live" ||
    normalized === "live_completed"
  ) {
    return "real_runtime";
  }
  if (
    normalized === "proxy_runtime" ||
    normalized === "sidecar_proxy" ||
    normalized.includes("proxy")
  ) {
    return "proxy_runtime";
  }
  if (
    normalized === "unavailable" ||
    normalized === "sidecar_failure" ||
    normalized.includes("failure") ||
    normalized.includes("failed")
  ) {
    return "unavailable";
  }
  if (normalized === "unknown" || normalized === "missing_source_metadata") {
    return "unknown";
  }
  return null;
}

function normalizeSourceLineage(value: unknown): SourceLineage | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized === "openalice_native" ||
    normalized === "donor_native" ||
    normalized === "donor_proxy" ||
    normalized === "openalice_history_proxy" ||
    normalized === "control" ||
    normalized === "unknown"
    ? normalized
    : null;
}

function normalizeAdmissionIntent(value: unknown): AdmissionIntent | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized === "exploratory" || normalized === "promotion" ? normalized : null;
}

function inferSourceLineage(
  input: SourceEligibilityLike | null | undefined,
  runtimeMode: RuntimeMode,
): SourceLineage {
  const role = typeof input?.role === "string" ? input.role : "";
  if (
    role === "benchmark_control" ||
    role === "robustness_anchor" ||
    role === "independent_guard"
  ) {
    return "control";
  }
  if (runtimeMode === "proxy_runtime") {
    return "donor_proxy";
  }
  if (runtimeMode === "unavailable") {
    return "unknown";
  }
  if (runtimeMode === "unknown") {
    return "unknown";
  }
  const producer = typeof input?.provenance?.producer === "string"
    ? input.provenance.producer.toLowerCase()
    : "";
  return producer.includes("tradingagents") ||
    producer.includes("cryptotrade") ||
    producer.includes("alphaswarm")
    ? "donor_native"
    : "openalice_native";
}

function runtimeModeBlockers(runtimeMode: RuntimeMode, fallbackReason: string | null): string[] {
  if (runtimeMode === "proxy_runtime") {
    return [fallbackReason ? `proxy_runtime:${fallbackReason}` : "proxy_runtime"];
  }
  if (runtimeMode === "unavailable") {
    return [fallbackReason ? `runtime_unavailable:${fallbackReason}` : "runtime_unavailable"];
  }
  if (runtimeMode === "unknown") {
    return ["missing_source_metadata"];
  }
  return [];
}

function deriveEligibilityBlockers(input: {
  runtimeMode: RuntimeMode;
  sourceLineage: SourceLineage;
  donorNative: boolean;
  admissionIntent: AdmissionIntent;
  basePromotionEligible: boolean;
}): string[] {
  const blockers: string[] = [];
  if (input.admissionIntent !== "promotion") {
    blockers.push("exploratory_artifact_not_promotion");
  }
  if (!input.basePromotionEligible) {
    blockers.push("promotion_eligible_false");
  }
  if (input.sourceLineage === "control") {
    blockers.push("control_lineage_not_promotable");
  }
  if (input.sourceLineage === "unknown") {
    blockers.push("unknown_lineage_not_promotable");
  }
  if (
    !input.donorNative &&
    (input.sourceLineage === "donor_proxy" ||
      input.sourceLineage === "openalice_history_proxy")
  ) {
    blockers.push("non_donor_native_source");
  }
  if (input.runtimeMode !== "real_runtime") {
    blockers.push("runtime_not_real");
  }
  return blockers;
}

function parseNotes(notes: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(notes)) {
    return out;
  }
  for (const note of notes) {
    if (typeof note !== "string") continue;
    const index = note.indexOf("=");
    if (index <= 0) continue;
    out.set(note.slice(0, index).trim(), note.slice(index + 1).trim());
  }
  return out;
}

function boolOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function stringOrNullish(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
