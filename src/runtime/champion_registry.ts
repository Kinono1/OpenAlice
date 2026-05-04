import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ChampionRegistryEntry {
  strategyId: string;
  strategyFamily: string;
  strategyName?: string;
  symbols: string[];
  candidateId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChampionRegistry {
  version: 1;
  generatedAt: string;
  entries: ChampionRegistryEntry[];
  sourceVerdictPath?: string;
  releaseGateStatusPath?: string;
}

export type ChampionRegistryLoadResult =
  | { kind: "valid"; registry: ChampionRegistry }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string };

export interface ChampionRegistryCoverageResult {
  ok: boolean;
  reasons: string[];
  entriesBySymbol: Record<string, ChampionRegistryEntry>;
}

export function normalizeChampionRegistry(raw: unknown): ChampionRegistry {
  if (!raw || typeof raw !== "object") {
    throw new Error("Champion registry must be an object.");
  }

  const value = raw as Partial<ChampionRegistry>;
  if (value.version !== 1) {
    throw new Error("Unsupported champion registry version.");
  }
  if (typeof value.generatedAt !== "string" || !value.generatedAt.trim()) {
    throw new Error("Champion registry generatedAt must be a non-empty string.");
  }
  if (!Array.isArray(value.entries) || value.entries.length < 1) {
    throw new Error("Champion registry must contain at least one entry.");
  }

  const entries = value.entries.map(normalizeChampionRegistryEntry);
  assertUniqueChampionRegistrySymbols(entries);

  return {
    version: 1,
    generatedAt: value.generatedAt,
    entries,
    sourceVerdictPath:
      typeof value.sourceVerdictPath === "string"
        ? value.sourceVerdictPath
        : undefined,
    releaseGateStatusPath:
      typeof value.releaseGateStatusPath === "string"
        ? value.releaseGateStatusPath
        : undefined,
  };
}

export async function loadChampionRegistry(
  filePath = "data/runtime/paper_champion_registry.json",
): Promise<ChampionRegistryLoadResult> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return {
      kind: "valid",
      registry: normalizeChampionRegistry(JSON.parse(raw)),
    };
  } catch (error) {
    if (isEnoent(error)) {
      return { kind: "missing" };
    }
    if (error instanceof Error) {
      return {
        kind: "invalid",
        reason: error.message,
      };
    }
    return {
      kind: "invalid",
      reason: String(error),
    };
  }
}

export async function writeChampionRegistry(
  registry: ChampionRegistry,
  opts?: { filePath?: string },
): Promise<ChampionRegistry> {
  const normalized = normalizeChampionRegistry(registry);
  const filePath = opts?.filePath ?? "data/runtime/paper_champion_registry.json";
  const tempPath = `${filePath}.tmp`;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  await rename(tempPath, filePath);
  return normalized;
}

export function evaluateChampionRegistryCoverage(
  registry: ChampionRegistry,
  opts?: {
    requiredSymbols?: string[];
    expectedStrategyIdsBySymbol?: Record<string, string>;
  },
): ChampionRegistryCoverageResult {
  const entriesBySymbol = buildChampionRegistryEntriesBySymbol(registry.entries);
  const reasons: string[] = [];
  const requiredSymbols =
    opts?.requiredSymbols && opts.requiredSymbols.length > 0
      ? uniqueSymbols(opts.requiredSymbols)
      : Object.keys(entriesBySymbol);

  if (requiredSymbols.length < 1) {
    reasons.push("registry_required_symbols_missing");
  }

  for (const symbol of requiredSymbols) {
    const entry = entriesBySymbol[symbol];
    if (!entry) {
      reasons.push(`registry_symbol_missing:${symbol}`);
      continue;
    }

    const expectedStrategyId = opts?.expectedStrategyIdsBySymbol?.[symbol];
    if (
      typeof expectedStrategyId === "string" &&
      expectedStrategyId.trim() &&
      entry.strategyId !== expectedStrategyId
    ) {
      reasons.push(`registry_strategy_mismatch:${symbol}`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    entriesBySymbol,
  };
}

function normalizeChampionRegistryEntry(
  raw: unknown,
): ChampionRegistryEntry {
  if (!raw || typeof raw !== "object") {
    throw new Error("Champion registry entry must be an object.");
  }

  const value = raw as Partial<ChampionRegistryEntry>;
  if (typeof value.strategyId !== "string" || !value.strategyId.trim()) {
    throw new Error("Champion registry entry strategyId must be a non-empty string.");
  }
  if (
    typeof value.strategyFamily !== "string" ||
    !value.strategyFamily.trim()
  ) {
    throw new Error(
      "Champion registry entry strategyFamily must be a non-empty string.",
    );
  }
  if (!Array.isArray(value.symbols) || value.symbols.length < 1) {
    throw new Error("Champion registry entry must contain at least one symbol.");
  }

  const symbols = uniqueSymbols(
    value.symbols.map(symbol => {
      if (typeof symbol !== "string" || !symbol.trim()) {
        throw new Error("Champion registry symbols must be non-empty strings.");
      }
      return symbol;
    }),
  );

  return {
    strategyId: value.strategyId,
    strategyFamily: value.strategyFamily,
    strategyName:
      typeof value.strategyName === "string" && value.strategyName.trim()
        ? value.strategyName
        : undefined,
    symbols,
    candidateId:
      typeof value.candidateId === "string" && value.candidateId.trim()
        ? value.candidateId
        : undefined,
    metadata:
      value.metadata && typeof value.metadata === "object"
        ? value.metadata
        : undefined,
  };
}

function buildChampionRegistryEntriesBySymbol(
  entries: ChampionRegistryEntry[],
): Record<string, ChampionRegistryEntry> {
  const entriesBySymbol: Record<string, ChampionRegistryEntry> = {};
  for (const entry of entries) {
    for (const symbol of entry.symbols) {
      entriesBySymbol[symbol] = entry;
    }
  }
  return entriesBySymbol;
}

function assertUniqueChampionRegistrySymbols(
  entries: ChampionRegistryEntry[],
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const symbol of entry.symbols) {
      if (seen.has(symbol)) {
        throw new Error(
          `Champion registry symbol ${symbol} must map to exactly one entry.`,
        );
      }
      seen.add(symbol);
    }
  }
}

function uniqueSymbols(symbols: string[]): string[] {
  const normalized = symbols.map(symbol => {
    if (typeof symbol !== "string" || !symbol.trim()) {
      throw new Error("Champion registry symbols must be non-empty strings.");
    }
    return symbol.trim();
  });
  return Array.from(new Set(normalized));
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
