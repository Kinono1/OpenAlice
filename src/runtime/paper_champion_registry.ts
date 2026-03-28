import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ResolvedMarketIdentity {
  internalSymbol: string;
  ccxtSymbol: string;
  instId: string;
  instType: string;
  settleCcy: string;
  defaultMarketType: string;
  domainBaseUrl: string;
  demoMode: boolean;
}

export interface PaperChampionRegistry {
  version: 1;
  checksum?: string;
  strategy_family: string;
  strategy_params: Record<string, unknown>;
  candidate_id?: string;
  candidate_rank?: number;
  candidate_verdict?: "promote" | "watch" | "reject";
  challengers?: Array<{
    candidate_id: string;
    rank: number;
    verdict: "promote" | "watch" | "reject";
    strategy?: string;
    family?: string;
  }>;
  symbols: string[];
  bar_interval: string;
  resolved_market_identity: Record<string, ResolvedMarketIdentity>;
  paper_gate_snapshot: Record<string, unknown>;
  cost_model_version: string;
  veto_policy_version: string;
  runtime_schema_version: string;
  research_dataset_hash: string;
  bar_data_snapshot_id: string;
  feature_pipeline_version: string;
  signal_code_commit_hash: string;
  candidate_list_hash: string;
  search_policy_hash: string;
  trial_count: number;
  accepted_oos_window: Record<string, unknown>;
  accepted_metrics: Record<string, unknown>;
  generated_at: string;
}

export interface RuntimeChampionExpectations {
  symbols?: string[];
  resolvedMarketIdentity?: Record<string, Partial<ResolvedMarketIdentity>>;
  vetoPolicyVersion?: string;
  runtimeSchemaVersion?: string;
  signalCodeCommitHash?: string;
}

export interface PaperChampionRegistryValidation {
  championLoaded: boolean;
  policyVersionMatch: boolean;
  checksumValid: boolean;
  blockingReasons: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeResolvedIdentity(
  raw: unknown,
  symbol: string,
): ResolvedMarketIdentity {
  if (!isObject(raw)) {
    throw new Error(`Invalid resolved_market_identity for ${symbol}`);
  }
  return {
    internalSymbol: requiredString(raw.internalSymbol, `${symbol}.internalSymbol`),
    ccxtSymbol: requiredString(raw.ccxtSymbol, `${symbol}.ccxtSymbol`),
    instId: requiredString(raw.instId, `${symbol}.instId`),
    instType: requiredString(raw.instType, `${symbol}.instType`),
    settleCcy: requiredString(raw.settleCcy, `${symbol}.settleCcy`),
    defaultMarketType: requiredString(raw.defaultMarketType, `${symbol}.defaultMarketType`),
    domainBaseUrl: requiredString(raw.domainBaseUrl, `${symbol}.domainBaseUrl`),
    demoMode: requiredBoolean(raw.demoMode, `${symbol}.demoMode`),
  };
}

export function normalizePaperChampionRegistry(raw: unknown): PaperChampionRegistry {
  if (!isObject(raw)) {
    throw new Error("Invalid paper champion registry payload");
  }
  if (raw.version !== 1) {
    throw new Error("Unsupported paper champion registry version");
  }
  if (!Array.isArray(raw.symbols) || raw.symbols.length === 0) {
    throw new Error("Invalid symbols");
  }
  if (!isObject(raw.resolved_market_identity)) {
    throw new Error("Invalid resolved_market_identity");
  }

  const symbols = raw.symbols.map((symbol, idx) =>
    requiredString(symbol, `symbols[${idx}]`)
  );
  const resolved_market_identity: Record<string, ResolvedMarketIdentity> = {};
  for (const symbol of symbols) {
    resolved_market_identity[symbol] = normalizeResolvedIdentity(
      raw.resolved_market_identity[symbol],
      symbol,
    );
  }

  const trialCount = Number(raw.trial_count);
  if (!Number.isInteger(trialCount) || trialCount <= 0) {
    throw new Error("Invalid trial_count");
  }
  const candidateRank =
    raw.candidate_rank === undefined ? undefined : Number(raw.candidate_rank);
  if (
    candidateRank !== undefined &&
    (!Number.isInteger(candidateRank) || candidateRank <= 0)
  ) {
    throw new Error("Invalid candidate_rank");
  }

  const candidateVerdict =
    raw.candidate_verdict === "promote" ||
    raw.candidate_verdict === "watch" ||
    raw.candidate_verdict === "reject"
      ? raw.candidate_verdict
      : undefined;

  const challengers = Array.isArray(raw.challengers)
    ? raw.challengers.map((challenger, index) => {
        if (!isObject(challenger)) {
          throw new Error(`Invalid challengers[${index}]`);
        }
        const verdict = requiredString(
          challenger.verdict,
          `challengers[${index}].verdict`,
        );
        if (verdict !== "promote" && verdict !== "watch" && verdict !== "reject") {
          throw new Error(`Invalid challengers[${index}].verdict`);
        }
        const rank = Number(challenger.rank);
        if (!Number.isInteger(rank) || rank <= 0) {
          throw new Error(`Invalid challengers[${index}].rank`);
        }
        return {
          candidate_id: requiredString(
            challenger.candidate_id,
            `challengers[${index}].candidate_id`,
          ),
          rank,
          verdict: verdict as "promote" | "watch" | "reject",
          strategy:
            typeof challenger.strategy === "string"
              ? challenger.strategy
              : undefined,
          family:
            typeof challenger.family === "string" ? challenger.family : undefined,
        };
      })
    : undefined;

  return {
    version: 1,
    checksum:
      typeof raw.checksum === "string" && raw.checksum.trim().length > 0
        ? raw.checksum
        : undefined,
    strategy_family: requiredString(raw.strategy_family, "strategy_family"),
    strategy_params: isObject(raw.strategy_params) ? raw.strategy_params : {},
    candidate_id:
      typeof raw.candidate_id === "string" && raw.candidate_id.trim().length > 0
        ? raw.candidate_id
        : undefined,
    candidate_rank: candidateRank,
    candidate_verdict: candidateVerdict,
    challengers,
    symbols,
    bar_interval: requiredString(raw.bar_interval, "bar_interval"),
    resolved_market_identity,
    paper_gate_snapshot: isObject(raw.paper_gate_snapshot) ? raw.paper_gate_snapshot : {},
    cost_model_version: requiredString(raw.cost_model_version, "cost_model_version"),
    veto_policy_version: requiredString(raw.veto_policy_version, "veto_policy_version"),
    runtime_schema_version: requiredString(raw.runtime_schema_version, "runtime_schema_version"),
    research_dataset_hash: requiredString(raw.research_dataset_hash, "research_dataset_hash"),
    bar_data_snapshot_id: requiredString(raw.bar_data_snapshot_id, "bar_data_snapshot_id"),
    feature_pipeline_version: requiredString(raw.feature_pipeline_version, "feature_pipeline_version"),
    signal_code_commit_hash: requiredString(raw.signal_code_commit_hash, "signal_code_commit_hash"),
    candidate_list_hash: requiredString(raw.candidate_list_hash, "candidate_list_hash"),
    search_policy_hash: requiredString(raw.search_policy_hash, "search_policy_hash"),
    trial_count: trialCount,
    accepted_oos_window: isObject(raw.accepted_oos_window) ? raw.accepted_oos_window : {},
    accepted_metrics: isObject(raw.accepted_metrics) ? raw.accepted_metrics : {},
    generated_at: requiredString(raw.generated_at, "generated_at"),
  };
}

function toChecksumPayload(registry: PaperChampionRegistry): Omit<PaperChampionRegistry, "checksum"> {
  const { checksum: _checksum, ...payload } = registry;
  return payload;
}

export function computePaperChampionRegistryChecksum(
  registry: Omit<PaperChampionRegistry, "checksum"> | PaperChampionRegistry,
): string {
  const payload = "checksum" in registry ? toChecksumPayload(registry) : registry;
  return createHash("sha256").update(stableSerialize(payload)).digest("hex");
}

export async function writePaperChampionRegistry(
  registry: Omit<PaperChampionRegistry, "checksum"> | PaperChampionRegistry,
  opts?: { filePath?: string },
): Promise<PaperChampionRegistry> {
  const normalized = normalizePaperChampionRegistry({
    ...registry,
    version: 1,
  });
  const payload: PaperChampionRegistry = {
    ...normalized,
    checksum: computePaperChampionRegistryChecksum(normalized),
  };
  const filePath = opts?.filePath ?? "data/runtime/paper_champion_registry.json";
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return payload;
}

export async function loadPaperChampionRegistry(
  filePath = "data/runtime/paper_champion_registry.json",
): Promise<PaperChampionRegistry | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizePaperChampionRegistry(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function validatePaperChampionRegistryForRuntime(
  registry: PaperChampionRegistry | null,
  expectations: RuntimeChampionExpectations = {},
): PaperChampionRegistryValidation {
  if (!registry) {
    return {
      championLoaded: false,
      policyVersionMatch: false,
      checksumValid: false,
      blockingReasons: ["paper_champion_registry_missing"],
    };
  }

  const blockingReasons: string[] = [];
  const checksumValid =
    typeof registry.checksum === "string" &&
    registry.checksum === computePaperChampionRegistryChecksum(registry);
  if (!checksumValid) {
    blockingReasons.push("paper_champion_registry_checksum_invalid");
  }

  const requiredSymbols = expectations.symbols ?? registry.symbols;
  for (const symbol of requiredSymbols) {
    const actual = registry.resolved_market_identity[symbol];
    if (!actual) {
      blockingReasons.push(`paper_champion_registry_missing_symbol:${symbol}`);
      continue;
    }

    const expected = expectations.resolvedMarketIdentity?.[symbol];
    if (!expected) continue;
    const fields: Array<keyof ResolvedMarketIdentity> = [
      "internalSymbol",
      "ccxtSymbol",
      "instId",
      "instType",
      "settleCcy",
      "defaultMarketType",
      "domainBaseUrl",
      "demoMode",
    ];
    for (const field of fields) {
      if (expected[field] !== undefined && expected[field] !== actual[field]) {
        blockingReasons.push(
          `paper_champion_registry_identity_mismatch:${symbol}:${field}`,
        );
      }
    }
  }

  const policyVersionMatch =
    (expectations.vetoPolicyVersion == null ||
      expectations.vetoPolicyVersion === registry.veto_policy_version) &&
    (expectations.runtimeSchemaVersion == null ||
      expectations.runtimeSchemaVersion === registry.runtime_schema_version) &&
    (expectations.signalCodeCommitHash == null ||
      expectations.signalCodeCommitHash === registry.signal_code_commit_hash);

  if (!policyVersionMatch) {
    blockingReasons.push("paper_champion_registry_policy_version_mismatch");
  }

  return {
    championLoaded: blockingReasons.filter((reason) =>
      reason.startsWith("paper_champion_registry_identity_mismatch") ||
      reason.startsWith("paper_champion_registry_missing_symbol") ||
      reason === "paper_champion_registry_missing" ||
      reason === "paper_champion_registry_checksum_invalid"
    ).length === 0,
    policyVersionMatch,
    checksumValid,
    blockingReasons,
  };
}
