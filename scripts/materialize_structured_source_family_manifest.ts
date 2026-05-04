import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type FamilyMode =
  | "seasonal_trend_disentangle"
  | "domain_adapt_transfer"
  | "multi_domain_pretrain"
  | "regime_filtered_trend";
type MultipleTestingUnit = "candidate" | "family";

interface CandidateManifest {
  schemaVersion?: string;
  generatedAt?: string;
  batchId?: string;
  batchGoal?: string;
  notes?: string[];
  dataset?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  wfo?: Record<string, unknown>;
  significance?: Record<string, unknown>;
  riskSimulation?: Record<string, unknown>;
  costModel?: Record<string, unknown>;
  candidates?: CandidateConfig[];
}

interface CandidateConfig {
  strategyId?: string;
  strategyName?: string;
  strategy?: string;
  applicableSymbols?: string[];
  hypothesisFamily?: string;
  correlationBucket?: string;
  params?: Record<string, unknown>;
}

interface CliArgs {
  seedManifest: string;
  output: string;
  familyMode: FamilyMode;
  symbol: string;
  batchId?: string;
  batchGoal?: string;
  transferManifest?: string;
  multipleTestingUnit: MultipleTestingUnit;
  sourceId?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [seedManifest, transferManifest] = await Promise.all([
    readJson<CandidateManifest>(args.seedManifest),
    args.transferManifest
      ? readJson<CandidateManifest>(args.transferManifest)
      : Promise.resolve(null),
  ]);

  const candidates = materializeFamilyCandidates({
    seedManifest,
    transferManifest,
    familyMode: args.familyMode,
    symbol: args.symbol,
  });
  const outputManifest: CandidateManifest = {
    ...seedManifest,
    generatedAt: new Date().toISOString(),
    batchId:
      args.batchId ??
      `${sanitizeTag(args.familyMode)}_${sanitizeTag(args.symbol)}_manifest`,
    batchGoal:
      args.batchGoal ??
      `Materialize ${args.familyMode} source family candidates for ${args.symbol}.`,
    notes: [
      ...(Array.isArray(seedManifest.notes) ? seedManifest.notes : []),
      `structured_source_family=${args.familyMode}`,
      `source_id=${args.sourceId ?? "unknown"}`,
      `multiple_testing_unit=${args.multipleTestingUnit}`,
      ...(args.familyMode === "regime_filtered_trend"
        ? [
            "family_design=v1_rule_based",
            `seed_manifest=${resolve(args.seedManifest)}`,
          ]
        : []),
      ...(args.transferManifest
        ? [`transfer_manifest=${resolve(args.transferManifest)}`]
        : []),
    ],
    significance: {
      ...(seedManifest.significance ?? {}),
      multipleTestingUnit: args.multipleTestingUnit,
    },
    candidates,
  };

  await mkdir(dirname(resolve(args.output)), { recursive: true });
  await writeFile(
    resolve(args.output),
    `${JSON.stringify(outputManifest, null, 2)}\n`,
    "utf-8",
  );

  console.log(
    [
      `output=${resolve(args.output)}`,
      `familyMode=${args.familyMode}`,
      `symbol=${args.symbol}`,
      `candidateCount=${candidates.length}`,
    ].join(" | "),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const seedManifest = raw.get("seed-manifest");
  const output = raw.get("output");
  const familyMode = raw.get("family-mode");
  const symbol = raw.get("symbol");
  if (!seedManifest) throw new Error("--seed-manifest is required.");
  if (!output) throw new Error("--output is required.");
  if (
    familyMode !== "seasonal_trend_disentangle" &&
    familyMode !== "domain_adapt_transfer" &&
    familyMode !== "multi_domain_pretrain" &&
    familyMode !== "regime_filtered_trend"
  ) {
    throw new Error(
      "--family-mode must be one of seasonal_trend_disentangle, domain_adapt_transfer, multi_domain_pretrain, regime_filtered_trend.",
    );
  }
  if (!symbol) throw new Error("--symbol is required.");

  return {
    seedManifest,
    output,
    familyMode,
    symbol,
    batchId: normalizeOptionalString(raw.get("batch-id")),
    batchGoal: normalizeOptionalString(raw.get("batch-goal")),
    transferManifest: normalizeOptionalString(raw.get("transfer-manifest")),
    multipleTestingUnit:
      raw.get("multiple-testing-unit") === "family" ? "family" : "candidate",
    sourceId: normalizeOptionalString(raw.get("source-id")),
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    index += 1;
  }
  return out;
}

function materializeFamilyCandidates(input: {
  seedManifest: CandidateManifest;
  transferManifest: CandidateManifest | null;
  familyMode: FamilyMode;
  symbol: string;
}): CandidateConfig[] {
  const seedCandidates = (input.seedManifest.candidates ?? []).filter(
    candidate =>
      candidate.strategy === "trend" || candidate.strategy === "regimeTrend",
  );
  if (seedCandidates.length < 3) {
    throw new Error("Seed manifest must contain at least 3 trend candidates.");
  }

  if (input.familyMode === "seasonal_trend_disentangle") {
    return seedCandidates.slice(0, 3).map((candidate, index) => {
      const params = asParams(candidate.params);
      const fast = intParam(params.trendFastPeriod);
      const slow = intParam(params.trendSlowPeriod);
      if (!fast || !slow) {
        throw new Error("Seed trend candidate is missing fast/slow periods.");
      }
      const confirmBars = [2, 3, 2][index] ?? 2;
      const minDiffPct = [0.02, 0.03, 0.015][index] ?? 0.02;
      const shiftedSlow = slow + (index === 0 ? 5 : index === 1 ? 10 : 0);
      return {
        strategyId: `SSF_${index + 1}_${fast}_${shiftedSlow}`,
        strategyName: `trend_seasonal_${fast}_${shiftedSlow}_c${confirmBars}`,
        strategy: "trend",
        applicableSymbols: [input.symbol],
        hypothesisFamily: `${normalizeSymbolKey(input.symbol)}_seasonal_trend_family_${fast}_${shiftedSlow}`,
        correlationBucket: `${normalizeSymbolKey(input.symbol)}_seasonal_trend_${fast}_${shiftedSlow}`,
        params: {
          trendFastPeriod: fast,
          trendSlowPeriod: shiftedSlow,
          trendConfirmBars: confirmBars,
          trendMinDiffPct: minDiffPct,
          allowShort: params.allowShort ?? true,
        },
      };
    });
  }

  if (input.familyMode === "domain_adapt_transfer") {
    const transferCandidates = (input.transferManifest?.candidates ?? []).filter(
      candidate => candidate.strategy === "trend",
    );
    if (transferCandidates.length < 3) {
      throw new Error(
        "domain_adapt_transfer requires a transfer manifest with at least 3 trend candidates.",
      );
    }
    return transferCandidates.slice(0, 3).map((candidate, index) => {
      const params = asParams(candidate.params);
      const fast = intParam(params.trendFastPeriod);
      const slow = intParam(params.trendSlowPeriod);
      if (!fast || !slow) {
        throw new Error("Transfer trend candidate is missing fast/slow periods.");
      }
      return {
        strategyId: `DAT_${index + 1}_${fast}_${slow}`,
        strategyName: `trend_transfer_${fast}_${slow}_${normalizeSymbolKey(input.symbol)}`,
        strategy: "trend",
        applicableSymbols: [input.symbol],
        hypothesisFamily: `${normalizeSymbolKey(input.symbol)}_transfer_trend_family_${fast}_${slow}`,
        correlationBucket: `${normalizeSymbolKey(input.symbol)}_transfer_trend_${fast}_${slow}`,
        params: {
          trendFastPeriod: fast,
          trendSlowPeriod: slow,
          trendConfirmBars: index === 0 ? 2 : 1,
          trendMinDiffPct: index === 2 ? 0.02 : 0,
          allowShort: params.allowShort ?? true,
        },
      };
    });
  }

  if (input.familyMode === "regime_filtered_trend") {
    const regimeFamilyConfigs = [
      {
        strategyId: "RGT_1_HVT",
        strategyName: "regime_trend_high_vol_trend_only",
        hypothesisFamily: `${normalizeSymbolKey(input.symbol)}_regime_filtered_high_vol_trend_family`,
        correlationBucket: `${normalizeSymbolKey(input.symbol)}_regime_hvt`,
        allowedEntryRegimes: ["HighVolTrend"],
      },
      {
        strategyId: "RGT_2_TREND",
        strategyName: "regime_trend_trend_regimes_only",
        hypothesisFamily: `${normalizeSymbolKey(input.symbol)}_regime_filtered_trend_regimes_family`,
        correlationBucket: `${normalizeSymbolKey(input.symbol)}_regime_trend_only`,
        allowedEntryRegimes: ["HighVolTrend", "LowVolTrend"],
      },
      {
        strategyId: "RGT_3_HVT_CARRY",
        strategyName: "regime_trend_high_vol_trend_plus_carry",
        hypothesisFamily: `${normalizeSymbolKey(input.symbol)}_regime_filtered_high_vol_trend_carry_family`,
        correlationBucket: `${normalizeSymbolKey(input.symbol)}_regime_hvt_carry`,
        allowedEntryRegimes: ["HighVolTrend", "LowVolCarry"],
      },
    ] as const;

    return seedCandidates.slice(0, 3).map((candidate, index) => {
      const params = asParams(candidate.params);
      const fast = intParam(params.trendFastPeriod);
      const slow = intParam(params.trendSlowPeriod);
      if (!fast || !slow) {
        throw new Error("Seed trend candidate is missing fast/slow periods.");
      }
      const config = regimeFamilyConfigs[index] ?? regimeFamilyConfigs[0];
      return {
        strategyId: config.strategyId,
        strategyName: config.strategyName,
        strategy: "regimeTrend",
        applicableSymbols: [input.symbol],
        hypothesisFamily: config.hypothesisFamily,
        correlationBucket: config.correlationBucket,
        params: {
          trendFastPeriod: fast,
          trendSlowPeriod: slow,
          trendConfirmBars: intParam(params.trendConfirmBars) ?? 1,
          trendMinDiffPct: numberParam(params.trendMinDiffPct) ?? 0,
          allowShort: params.allowShort ?? true,
          regimeVolWindow: 20,
          regimeAtrPeriod: 14,
          regimeFastPeriod: 12,
          regimeSlowPeriod: 48,
          allowedEntryRegimes: [...config.allowedEntryRegimes],
          exitOnRegimeMismatch: true,
        },
      };
    });
  }

  return seedCandidates.slice(0, 3).map((candidate, index) => {
    const params = asParams(candidate.params);
    const fast = intParam(params.trendFastPeriod);
    const slow = intParam(params.trendSlowPeriod);
    if (!fast || !slow) {
      throw new Error("Seed trend candidate is missing fast/slow periods.");
    }
    const ensembleThreshold = [0.3, 0.34, 0.28][index] ?? 0.3;
    const trendWeight = [3, 4, 2][index] ?? 3;
    const meanReversionWeight = [1, 1, 2][index] ?? 1;
    const breakoutWeight = [1, 2, 1][index] ?? 1;
    return {
      strategyId: `MDP_${index + 1}_${fast}_${slow}`,
      strategyName: `ensemble_pretrain_${fast}_${slow}_${index + 1}`,
      strategy: "ensemble",
      applicableSymbols: [input.symbol],
      hypothesisFamily: `${normalizeSymbolKey(input.symbol)}_multi_domain_pretrain_family_${index + 1}`,
      correlationBucket: `${normalizeSymbolKey(input.symbol)}_multi_domain_pretrain_${index + 1}`,
      params: {
        trendFastPeriod: fast,
        trendSlowPeriod: slow,
        allowShort: params.allowShort ?? true,
        breakoutPeriod: 20 + index * 5,
        breakoutExitPeriod: 10 + index * 2,
        rsiPeriod: 14,
        rsiOversold: 30,
        rsiOverbought: 70,
        ensembleThreshold,
        ensembleWeights: {
          trend: trendWeight,
          meanReversion: meanReversionWeight,
          breakout: breakoutWeight,
        },
      },
    };
  });
}

function asParams(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function intParam(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function numberParam(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeTag(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function normalizeSymbolKey(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
