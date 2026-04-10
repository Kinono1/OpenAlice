import {
  isReleaseGateStatusBlocking,
  type PersistedReleaseGateStatus,
} from "./release_gate_status.js";

export interface PromotionGateCandidateFailureDiagnostics {
  strategyId: string;
  strategyName: string | null;
  failureReasons: string[];
}

export interface PromotionGateSymbolDiagnostics {
  symbol: string;
  result: string | null;
  reasonCodes: string[];
  candidateFailures: PromotionGateCandidateFailureDiagnostics[];
}

export interface PromotionGateArchiveReleaseGateDiagnostics {
  source: "experiment_verdict" | "release_gate_status" | "missing";
  allowPaperTrading: boolean | null;
  allowLiveTrading: boolean | null;
  failedChecks: string[];
  warningChecks: string[];
}

export interface PromotionGateDiagnostics {
  verdictResult: string | null;
  verdictReasonCodes: string[];
  portfolioReasonCodes: string[];
  validationReasons: string[];
  portfolioCandidateFailures: PromotionGateCandidateFailureDiagnostics[];
  symbolDiagnostics: PromotionGateSymbolDiagnostics[];
  releaseGate: PromotionGateArchiveReleaseGateDiagnostics;
}

export interface PromotionGateVerdict {
  pass: boolean;
  blockingReasons: string[];
  warnings: string[];
  evidenceRefs: string[];
  decidedAt: string;
  diagnostics: PromotionGateDiagnostics;
}

export interface PromotionGateInput {
  validationRuns: unknown;
  experimentVerdict: unknown;
  releaseGateStatus: PersistedReleaseGateStatus | null;
  portfolioSymbols?: string[];
  promotionMetadataReady?: boolean;
  supportedStrategyFamilies?: string[];
  now?: Date;
}

interface ValidationRunsChampion {
  strategyId?: string;
  symbol?: string;
  symbols?: string[];
  strategy?: string;
  strategyFamily?: string;
  strategyName?: string;
}

interface ValidationRunsChampionSetEntry {
  symbol?: string;
  strategyId?: string;
  strategy?: string;
  strategyFamily?: string;
  strategyName?: string;
}

interface ValidationRunsCandidate {
  strategyId?: string;
  strategy?: string;
  strategyName?: string;
}

export interface ValidationRunsChampionAssignment {
  symbol: string;
  strategyId: string;
  strategyFamily: string;
  strategyName?: string;
}

export interface ValidationRunsSummary {
  ok: boolean;
  reasons: string[];
  championAssignments: ValidationRunsChampionAssignment[];
  expectedStrategyIdsBySymbol: Record<string, string>;
  symbols: string[];
}

const DEFAULT_SUPPORTED_STRATEGY_FAMILIES = [
  "trend",
  "regimeTrend",
  "meanReversion",
  "breakout",
  "ensemble",
] as const;

export function evaluatePromotionGate(
  input: PromotionGateInput,
): PromotionGateVerdict {
  const decidedAt = (input.now ?? new Date()).toISOString();
  const warnings: string[] = [];
  const blockingReasons: string[] = [];
  const evidenceRefs = collectEvidenceRefs(input);

  const verdict = normalizeExperimentVerdict(input.experimentVerdict);
  if (!verdict) {
    blockingReasons.push("verdict_missing_or_invalid");
  } else if (verdict.result !== "GO") {
    blockingReasons.push("promotion_requires_go_verdict");
  }

  const validationRuns = summarizeValidationRuns(input.validationRuns, {
    portfolioSymbols: input.portfolioSymbols,
  });
  if (!validationRuns.ok) {
    blockingReasons.push("promotion_candidate_missing_or_invalid");
  } else {
    const supportedFamilies =
      input.supportedStrategyFamilies &&
      input.supportedStrategyFamilies.length > 0
        ? input.supportedStrategyFamilies
        : [...DEFAULT_SUPPORTED_STRATEGY_FAMILIES];
    for (const family of unique(
      validationRuns.championAssignments.map(assignment => assignment.strategyFamily),
    )) {
      if (!supportedFamilies.includes(family)) {
        blockingReasons.push(`promotion_strategy_family_unsupported:${family}`);
      }
    }
  }

  const archiveReleaseGate = resolveArchiveReleaseGateDiagnostics(
    input.experimentVerdict,
    input.releaseGateStatus,
  );
  const releaseGateDecision = isReleaseGateStatusBlocking(
    input.releaseGateStatus,
    "paper",
    input.now,
  );
  if (releaseGateDecision.blocking) {
    if (releaseGateDecision.reason === "release_gate_status_missing") {
      blockingReasons.push("release_gate_status_missing");
    } else if (
      releaseGateDecision.reason?.startsWith("release_gate_status_expired:")
    ) {
      blockingReasons.push(releaseGateDecision.reason);
    } else {
      blockingReasons.push("release_gate_not_approved");
      if (releaseGateDecision.reason) {
        warnings.push(releaseGateDecision.reason);
      }
    }
  }

  if (input.promotionMetadataReady === false) {
    blockingReasons.push("promotion_metadata_not_ready");
  }

  return {
    pass: blockingReasons.length === 0,
    blockingReasons: unique(blockingReasons),
    warnings: unique(warnings),
    evidenceRefs: unique(evidenceRefs),
    decidedAt,
    diagnostics: {
      verdictResult: verdict?.result ?? null,
      verdictReasonCodes: extractStringArray(
        input.experimentVerdict,
        "reasonCodes",
      ),
      portfolioReasonCodes: extractNestedStringArray(
        input.experimentVerdict,
        "portfolio",
        "reasonCodes",
      ),
      validationReasons: [...validationRuns.reasons],
      portfolioCandidateFailures: extractCandidateFailures(input.experimentVerdict),
      symbolDiagnostics: extractSymbolDiagnostics(input.experimentVerdict),
      releaseGate: archiveReleaseGate,
    },
  };
}

function normalizeExperimentVerdict(
  raw: unknown,
): { result: "GO" | "NO_GO"; outputPaths?: Record<string, unknown> } | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as { result?: unknown; outputPaths?: Record<string, unknown> };
  if (value.result !== "GO" && value.result !== "NO_GO") {
    return null;
  }
  return {
    result: value.result,
    outputPaths: value.outputPaths,
  };
}

function normalizeValidationRuns(
  raw: unknown,
): {
  champion: ValidationRunsChampion | null;
  championSet: ValidationRunsChampionSetEntry[];
  championsBySymbol: Record<string, ValidationRunsChampionSetEntry | string>;
  candidates: ValidationRunsCandidate[];
} {
  if (!raw || typeof raw !== "object") {
    return {
      champion: null,
      championSet: [],
      championsBySymbol: {},
      candidates: [],
    };
  }
  const value = raw as {
    champion?: ValidationRunsChampion;
    championSet?: ValidationRunsChampionSetEntry[];
    championsBySymbol?: Record<string, ValidationRunsChampionSetEntry | string>;
    candidates?: ValidationRunsCandidate[];
    portfolio?: {
      championSet?: ValidationRunsChampionSetEntry[];
    };
  };
  const championSetSource = Array.isArray(value.championSet)
    ? value.championSet
    : Array.isArray(value.portfolio?.championSet)
      ? value.portfolio.championSet
      : [];
  return {
    champion:
      value.champion && typeof value.champion === "object"
        ? value.champion
        : null,
    championSet: championSetSource.filter(entry => entry && typeof entry === "object"),
    championsBySymbol:
      value.championsBySymbol && typeof value.championsBySymbol === "object"
        ? value.championsBySymbol
        : {},
    candidates: Array.isArray(value.candidates)
      ? value.candidates.filter(
          candidate => candidate && typeof candidate === "object",
        )
      : [],
  };
}

export function summarizeValidationRuns(
  raw: unknown,
  opts?: { portfolioSymbols?: string[] },
): ValidationRunsSummary {
  const normalized = normalizeValidationRuns(raw);
  const reasons: string[] = [];
  const candidateFamiliesByStrategyId = buildCandidateFamiliesByStrategyId(
    normalized.candidates,
  );
  const requestedSymbols = normalizeRequestedSymbols(opts?.portfolioSymbols);
  const championAssignments = buildChampionAssignments(
    normalized,
    candidateFamiliesByStrategyId,
    requestedSymbols,
    reasons,
  );

  if (championAssignments.length < 1) {
    reasons.push("validation_champion_set_missing");
  }

  for (const symbol of requestedSymbols) {
    if (!championAssignments.some(assignment => assignment.symbol === symbol)) {
      reasons.push(`validation_symbol_missing:${symbol}`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons: unique(reasons),
    championAssignments,
    expectedStrategyIdsBySymbol: Object.fromEntries(
      championAssignments.map(assignment => [assignment.symbol, assignment.strategyId]),
    ),
    symbols: championAssignments.map(assignment => assignment.symbol),
  };
}

function buildChampionAssignments(
  normalized: ReturnType<typeof normalizeValidationRuns>,
  candidateFamiliesByStrategyId: Map<string, { family: string; strategyName?: string }>,
  requestedSymbols: string[],
  reasons: string[],
): ValidationRunsChampionAssignment[] {
  const assignments: ValidationRunsChampionAssignment[] = [];
  const seenSymbols = new Set<string>();

  const pushAssignment = (
    symbol: unknown,
    strategyId: unknown,
    familyHint?: unknown,
    strategyNameHint?: unknown,
  ): void => {
    if (typeof symbol !== "string" || !symbol.trim()) {
      reasons.push("validation_symbol_missing_or_invalid");
      return;
    }
    if (typeof strategyId !== "string" || !strategyId.trim()) {
      reasons.push(`validation_strategy_missing:${symbol.trim()}`);
      return;
    }

    const normalizedSymbol = symbol.trim();
    if (seenSymbols.has(normalizedSymbol)) {
      reasons.push(`validation_duplicate_symbol:${normalizedSymbol}`);
      return;
    }

    const family = resolveStrategyFamily(
      strategyId,
      familyHint,
      candidateFamiliesByStrategyId,
    );
    if (!family) {
      reasons.push(`validation_candidate_family_missing:${normalizedSymbol}`);
      return;
    }

    seenSymbols.add(normalizedSymbol);
    assignments.push({
      symbol: normalizedSymbol,
      strategyId: strategyId.trim(),
      strategyFamily: family,
      strategyName:
        typeof strategyNameHint === "string" && strategyNameHint.trim()
          ? strategyNameHint.trim()
          : candidateFamiliesByStrategyId.get(strategyId.trim())?.strategyName,
    });
  };

  for (const entry of normalized.championSet) {
    pushAssignment(
      entry.symbol,
      entry.strategyId,
      entry.strategy ?? entry.strategyFamily,
      entry.strategyName,
    );
  }

  for (const [symbol, value] of Object.entries(normalized.championsBySymbol)) {
    if (typeof value === "string") {
      pushAssignment(symbol, value);
      continue;
    }
    pushAssignment(
      symbol,
      value?.strategyId,
      value?.strategy ?? value?.strategyFamily,
      value?.strategyName,
    );
  }

  if (assignments.length > 0) {
    return assignments;
  }

  const championStrategyId = normalized.champion?.strategyId;
  if (!championStrategyId || !championStrategyId.trim()) {
    reasons.push("validation_champion_missing");
    return assignments;
  }

  const legacySymbols = normalizeRequestedSymbols([
    ...(Array.isArray(normalized.champion?.symbols) ? normalized.champion.symbols : []),
    ...(typeof normalized.champion?.symbol === "string"
      ? [normalized.champion.symbol]
      : []),
  ]);
  const fallbackSymbols =
    legacySymbols.length > 0
      ? legacySymbols
      : requestedSymbols.length === 1
        ? requestedSymbols
        : [];

  if (fallbackSymbols.length < 1) {
    reasons.push("validation_champion_symbol_mapping_missing");
    return assignments;
  }

  for (const symbol of fallbackSymbols) {
    pushAssignment(
      symbol,
      championStrategyId,
      normalized.champion?.strategy ?? normalized.champion?.strategyFamily,
      normalized.champion?.strategyName,
    );
  }

  return assignments;
}

function buildCandidateFamiliesByStrategyId(
  candidates: ValidationRunsCandidate[],
): Map<string, { family: string; strategyName?: string }> {
  const families = new Map<string, { family: string; strategyName?: string }>();
  for (const candidate of candidates) {
    if (
      typeof candidate.strategyId !== "string" ||
      !candidate.strategyId.trim() ||
      typeof candidate.strategy !== "string" ||
      !candidate.strategy.trim()
    ) {
      continue;
    }
    families.set(candidate.strategyId.trim(), {
      family: candidate.strategy.trim(),
      strategyName:
        typeof candidate.strategyName === "string" && candidate.strategyName.trim()
          ? candidate.strategyName.trim()
          : undefined,
    });
  }
  return families;
}

function resolveStrategyFamily(
  strategyId: string,
  familyHint: unknown,
  candidateFamiliesByStrategyId: Map<string, { family: string; strategyName?: string }>,
): string | null {
  if (typeof familyHint === "string" && familyHint.trim()) {
    return familyHint.trim();
  }
  return candidateFamiliesByStrategyId.get(strategyId.trim())?.family ?? null;
}

function normalizeRequestedSymbols(symbols: unknown): string[] {
  if (!Array.isArray(symbols)) {
    return [];
  }
  const normalized = symbols
    .filter(symbol => typeof symbol === "string" && symbol.trim())
    .map(symbol => symbol.trim());
  return unique(normalized);
}

function collectEvidenceRefs(input: PromotionGateInput): string[] {
  const refs: string[] = [];
  const verdict = input.experimentVerdict as
    | { outputPaths?: Record<string, unknown> }
    | undefined;
  const outputPaths = verdict?.outputPaths;
  if (outputPaths && typeof outputPaths === "object") {
    pushStringRef(refs, outputPaths.validationRuns);
    pushStringRef(refs, outputPaths.releaseGateStatus);
  }
  pushStringRef(refs, input.releaseGateStatus?.sourceReportPath);
  return refs;
}

function resolveArchiveReleaseGateDiagnostics(
  experimentVerdict: unknown,
  releaseGateStatus: PersistedReleaseGateStatus | null,
): PromotionGateArchiveReleaseGateDiagnostics {
  const verdictReleaseGate = extractVerdictReleaseGate(experimentVerdict);
  if (verdictReleaseGate) {
    return {
      source: "experiment_verdict",
      allowPaperTrading: verdictReleaseGate.allowPaperTrading,
      allowLiveTrading: verdictReleaseGate.allowLiveTrading,
      failedChecks: verdictReleaseGate.failedChecks,
      warningChecks: [],
    };
  }
  if (releaseGateStatus) {
    return {
      source: "release_gate_status",
      allowPaperTrading: releaseGateStatus.allowPaperTrading,
      allowLiveTrading: releaseGateStatus.allowLiveTrading,
      failedChecks: [...releaseGateStatus.failedChecks],
      warningChecks: [...releaseGateStatus.warningChecks],
    };
  }
  return {
    source: "missing",
    allowPaperTrading: null,
    allowLiveTrading: null,
    failedChecks: [],
    warningChecks: [],
  };
}

function extractVerdictReleaseGate(raw: unknown): {
  allowPaperTrading: boolean;
  allowLiveTrading: boolean;
  failedChecks: string[];
} | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const releaseGate = (raw as { portfolio?: { releaseGate?: unknown } }).portfolio
    ?.releaseGate;
  if (!releaseGate || typeof releaseGate !== "object") {
    return null;
  }
  const value = releaseGate as {
    allowPaperTrading?: unknown;
    allowLiveTrading?: unknown;
    failedChecks?: unknown;
  };
  if (
    typeof value.allowPaperTrading !== "boolean" ||
    typeof value.allowLiveTrading !== "boolean" ||
    !Array.isArray(value.failedChecks)
  ) {
    return null;
  }
  return {
    allowPaperTrading: value.allowPaperTrading,
    allowLiveTrading: value.allowLiveTrading,
    failedChecks: value.failedChecks.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    ),
  };
}

function extractCandidateFailures(
  raw: unknown,
): PromotionGateCandidateFailureDiagnostics[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const candidates = (raw as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates.flatMap(candidate => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const value = candidate as {
      strategyId?: unknown;
      strategyName?: unknown;
      failureReasons?: unknown;
    };
    const strategyId =
      typeof value.strategyId === "string" && value.strategyId.trim()
        ? value.strategyId.trim()
        : null;
    if (!strategyId) {
      return [];
    }
    const failureReasons = toStringArray(value.failureReasons);
    if (failureReasons.length < 1) {
      return [];
    }
    return [{
      strategyId,
      strategyName:
        typeof value.strategyName === "string" && value.strategyName.trim()
          ? value.strategyName.trim()
          : null,
      failureReasons,
    }];
  });
}

function extractSymbolDiagnostics(raw: unknown): PromotionGateSymbolDiagnostics[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const symbols = (raw as { symbols?: unknown }).symbols;
  if (!Array.isArray(symbols)) {
    return [];
  }
  return symbols.flatMap(symbolEntry => {
    if (!symbolEntry || typeof symbolEntry !== "object") {
      return [];
    }
    const value = symbolEntry as {
      symbol?: unknown;
      result?: unknown;
      reasonCodes?: unknown;
      candidates?: unknown;
    };
    const symbol =
      typeof value.symbol === "string" && value.symbol.trim()
        ? value.symbol.trim()
        : null;
    if (!symbol) {
      return [];
    }
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    return [{
      symbol,
      result:
        typeof value.result === "string" && value.result.trim()
          ? value.result.trim()
          : null,
      reasonCodes: toStringArray(value.reasonCodes),
      candidateFailures: candidates.flatMap(candidate => {
        if (!candidate || typeof candidate !== "object") {
          return [];
        }
        const candidateValue = candidate as {
          strategyId?: unknown;
          strategyName?: unknown;
          failureReasons?: unknown;
        };
        const strategyId =
          typeof candidateValue.strategyId === "string" &&
          candidateValue.strategyId.trim()
            ? candidateValue.strategyId.trim()
            : null;
        if (!strategyId) {
          return [];
        }
        const failureReasons = toStringArray(candidateValue.failureReasons);
        if (failureReasons.length < 1) {
          return [];
        }
        return [{
          strategyId,
          strategyName:
            typeof candidateValue.strategyName === "string" &&
            candidateValue.strategyName.trim()
              ? candidateValue.strategyName.trim()
              : null,
          failureReasons,
        }];
      }),
    }];
  });
}

function extractStringArray(raw: unknown, key: string): string[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  return toStringArray((raw as Record<string, unknown>)[key]);
}

function extractNestedStringArray(
  raw: unknown,
  parentKey: string,
  key: string,
): string[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const parent = (raw as Record<string, unknown>)[parentKey];
  if (!parent || typeof parent !== "object") {
    return [];
  }
  return toStringArray((parent as Record<string, unknown>)[key]);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function pushStringRef(target: string[], value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    target.push(trimmed);
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
