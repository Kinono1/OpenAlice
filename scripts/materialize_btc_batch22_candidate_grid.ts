import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
  anchorManifest: string;
  seasonalManifest: string;
  regimeManifest: string;
  ensembleManifest: string;
  output: string;
  symbol: string;
  batchId: string;
  batchGoal: string;
  sourceId: string;
  multipleTestingUnit: MultipleTestingUnit;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [anchorManifest, seasonalManifest, regimeManifest, ensembleManifest] =
    await Promise.all([
      readJson<CandidateManifest>(args.anchorManifest),
      readJson<CandidateManifest>(args.seasonalManifest),
      readJson<CandidateManifest>(args.regimeManifest),
      readJson<CandidateManifest>(args.ensembleManifest),
    ]);

  const anchorA = requireCandidate(anchorManifest, "HC001_COS_N1");
  const anchorB = requireCandidate(anchorManifest, "HC002_COS_N1");
  const anchorC = requireCandidate(anchorManifest, "HC003_REG");

  const seasonalA = requireCandidate(seasonalManifest, "SSF_R2_1");
  const seasonalB = requireCandidate(seasonalManifest, "SSF_R2_2");
  const seasonalC = requireCandidate(seasonalManifest, "SSF_R2_3");

  const ensembleA = requireCandidate(ensembleManifest, "MDP_1_34_70");
  const ensembleB = requireCandidate(ensembleManifest, "MDP_2_34_80");
  const ensembleC = requireCandidate(ensembleManifest, "MDP_3_18_80");

  const groupA = [
    cloneCandidate(anchorA, args.symbol),
    cloneCandidate(anchorB, args.symbol),
    cloneCandidate(anchorC, args.symbol),
  ];
  const groupB = [
    cloneCandidate(seasonalA, args.symbol),
    cloneCandidate(seasonalB, args.symbol),
    cloneCandidate(seasonalC, args.symbol),
  ];

  const groupC = [
    buildRegimeV2Candidate({
      base: seasonalA,
      symbol: args.symbol,
      strategyId: "RGT_V2_1",
      strategyName: "regime_trend_v2_34_70_c2_d200",
      hypothesisFamily: "btc_usd_regime_v2_family_34_70_c2_d200",
      correlationBucket: "btc_usd_regime_v2_34_70_c2_d200",
      trendConfirmBars: 2,
      trendMinDiffPct: 0.02,
      regimeVolWindow: 20,
      regimeAtrPeriod: 14,
      regimeFastPeriod: 12,
      regimeSlowPeriod: 48,
      allowedEntryRegimes: ["HighVolTrend", "LowVolTrend"],
      exitOnRegimeMismatch: true,
    }),
    buildRegimeV2Candidate({
      base: seasonalB,
      symbol: args.symbol,
      strategyId: "RGT_V2_2",
      strategyName: "regime_trend_v2_34_90_c3_d300",
      hypothesisFamily: "btc_usd_regime_v2_family_34_90_c3_d300",
      correlationBucket: "btc_usd_regime_v2_34_90_c3_d300",
      trendConfirmBars: 3,
      trendMinDiffPct: 0.03,
      regimeVolWindow: 20,
      regimeAtrPeriod: 14,
      regimeFastPeriod: 12,
      regimeSlowPeriod: 48,
      allowedEntryRegimes: ["HighVolTrend", "LowVolTrend", "LowVolCarry"],
      exitOnRegimeMismatch: true,
    }),
    buildRegimeV2Candidate({
      base: seasonalC,
      symbol: args.symbol,
      strategyId: "RGT_V2_3",
      strategyName: "regime_trend_v2_18_85_c2_d150",
      hypothesisFamily: "btc_usd_regime_v2_family_18_85_c2_d150",
      correlationBucket: "btc_usd_regime_v2_18_85_c2_d150",
      trendConfirmBars: 2,
      trendMinDiffPct: 0.015,
      regimeVolWindow: 20,
      regimeAtrPeriod: 14,
      regimeFastPeriod: 12,
      regimeSlowPeriod: 48,
      allowedEntryRegimes: ["HighVolTrend", "LowVolCarry"],
      exitOnRegimeMismatch: true,
    }),
  ];

  const groupD = [
    buildEnsembleProxyCandidate({
      base: ensembleA,
      symbol: args.symbol,
      strategyId: "ENS_PROXY_1",
      strategyName: "ensemble_proxy_34_70",
      hypothesisFamily: "btc_usd_regime_proxy_ensemble_family_34_70",
      correlationBucket: "btc_usd_regime_proxy_34_70",
      trendConfirmBars: 1,
      trendMinDiffPct: 0,
      breakoutPeriod: 20,
      breakoutExitPeriod: 10,
      ensembleThreshold: 0.3,
      ensembleWeights: {
        trend: 3,
        meanReversion: 1,
        breakout: 1,
      },
    }),
    buildEnsembleProxyCandidate({
      base: ensembleB,
      symbol: args.symbol,
      strategyId: "ENS_PROXY_2",
      strategyName: "ensemble_proxy_34_80",
      hypothesisFamily: "btc_usd_regime_proxy_ensemble_family_34_80",
      correlationBucket: "btc_usd_regime_proxy_34_80",
      trendConfirmBars: 1,
      trendMinDiffPct: 0,
      breakoutPeriod: 25,
      breakoutExitPeriod: 12,
      ensembleThreshold: 0.34,
      ensembleWeights: {
        trend: 4,
        meanReversion: 1,
        breakout: 2,
      },
    }),
    buildEnsembleProxyCandidate({
      base: ensembleC,
      symbol: args.symbol,
      strategyId: "ENS_PROXY_3",
      strategyName: "ensemble_proxy_18_85",
      hypothesisFamily: "btc_usd_regime_proxy_ensemble_family_18_85",
      correlationBucket: "btc_usd_regime_proxy_18_85",
      trendSlowPeriod: 85,
      trendConfirmBars: 1,
      trendMinDiffPct: 0,
      breakoutPeriod: 30,
      breakoutExitPeriod: 14,
      ensembleThreshold: 0.28,
      ensembleWeights: {
        trend: 2,
        meanReversion: 2,
        breakout: 1,
      },
    }),
  ];

  const outputManifest: CandidateManifest = {
    schemaVersion: "strategy_candidates.v1",
    generatedAt: new Date().toISOString(),
    batchId: args.batchId,
    batchGoal: args.batchGoal,
    notes: [
      ...(anchorManifest.notes ?? []),
      `source_id=${args.sourceId}`,
      `multiple_testing_unit=${args.multipleTestingUnit}`,
      `anchor_manifest=${resolve(args.anchorManifest)}`,
      `seasonal_manifest=${resolve(args.seasonalManifest)}`,
      `regime_manifest=${resolve(args.regimeManifest)}`,
      `ensemble_manifest=${resolve(args.ensembleManifest)}`,
      "family_design=batch22_grid_v1",
      "group_A=current_btc_frontier_anchors",
      "group_B=seasonal_v2_controls",
      "group_C=regime_trend_v2_variants",
      "group_D=regime_proxy_ensemble_variants",
    ],
    dataset: materializeDataset(args.symbol, anchorManifest, seasonalManifest),
    thresholds: anchorManifest.thresholds ?? seasonalManifest.thresholds ?? {},
    wfo: anchorManifest.wfo ?? seasonalManifest.wfo ?? {},
    significance: {
      ...(anchorManifest.significance ?? seasonalManifest.significance ?? {}),
      multipleTestingUnit: args.multipleTestingUnit,
    },
    riskSimulation:
      anchorManifest.riskSimulation ?? seasonalManifest.riskSimulation ?? {},
    costModel: anchorManifest.costModel ?? seasonalManifest.costModel ?? {},
    candidates: [...groupA, ...groupB, ...groupC, ...groupD],
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
      `symbol=${args.symbol}`,
      `candidateCount=${outputManifest.candidates?.length ?? 0}`,
      `groupA=${groupA.length}`,
      `groupB=${groupB.length}`,
      `groupC=${groupC.length}`,
      `groupD=${groupD.length}`,
    ].join(" | "),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const symbol = raw.get("symbol")?.trim() || "BTC/USD";
  return {
    anchorManifest:
      raw.get("anchor-manifest") ??
      "docs/research/strategy_candidates.route_batch15_btc_phaseb_neighborhood_base.v1.json",
    seasonalManifest:
      raw.get("seasonal-manifest") ??
      "docs/research/strategy_candidates.route_batch20_btc_seasonal_refine_base.v1.json",
    regimeManifest:
      raw.get("regime-manifest") ??
      "docs/research/strategy_candidates.route_batch21_btc_regime_source.v1.json",
    ensembleManifest:
      raw.get("ensemble-manifest") ??
      "docs/research/strategy_candidates.route_batch19_btc_multi_domain_source.v1.json",
    output:
      raw.get("output") ??
      "docs/research/strategy_candidates.route_batch22_btc_source_grid.v1.json",
    symbol,
    batchId: raw.get("batch-id") ?? "route_batch22_btc_source_grid_v1",
    batchGoal:
      raw.get("batch-goal") ??
      "Materialize a 12-candidate BTC source grid that combines current frontier anchors, seasonal-v2 controls, regimeTrend v2 variants, and regime-proxy ensemble candidates.",
    sourceId: raw.get("source-id") ?? "btc_batch22_source_grid",
    multipleTestingUnit:
      raw.get("multiple-testing-unit") === "family" ? "family" : "candidate",
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

function requireCandidate(
  manifest: CandidateManifest,
  strategyId: string,
): CandidateConfig {
  const candidate = (manifest.candidates ?? []).find(
    item => item.strategyId === strategyId,
  );
  if (!candidate) {
    throw new Error(`Missing candidate ${strategyId}`);
  }
  return candidate;
}

function cloneCandidate(candidate: CandidateConfig, symbol: string): CandidateConfig {
  return {
    ...candidate,
    applicableSymbols: [symbol],
    params: { ...asParams(candidate.params) },
  };
}

function buildRegimeV2Candidate(input: {
  base: CandidateConfig;
  symbol: string;
  strategyId: string;
  strategyName: string;
  hypothesisFamily: string;
  correlationBucket: string;
  trendSlowPeriod?: number;
  trendConfirmBars: number;
  trendMinDiffPct: number;
  regimeVolWindow: number;
  regimeAtrPeriod: number;
  regimeFastPeriod: number;
  regimeSlowPeriod: number;
  allowedEntryRegimes: string[];
  exitOnRegimeMismatch: boolean;
}): CandidateConfig {
  const params = asParams(input.base.params);
  return {
    strategyId: input.strategyId,
    strategyName: input.strategyName,
    strategy: "regimeTrend",
    applicableSymbols: [input.symbol],
    hypothesisFamily: input.hypothesisFamily,
    correlationBucket: input.correlationBucket,
    params: {
      trendFastPeriod: intParam(params.trendFastPeriod) ?? 20,
      trendSlowPeriod:
        input.trendSlowPeriod ?? intParam(params.trendSlowPeriod) ?? 50,
      trendConfirmBars: input.trendConfirmBars,
      trendMinDiffPct: input.trendMinDiffPct,
      allowShort: params.allowShort ?? true,
      regimeVolWindow: input.regimeVolWindow,
      regimeAtrPeriod: input.regimeAtrPeriod,
      regimeFastPeriod: input.regimeFastPeriod,
      regimeSlowPeriod: input.regimeSlowPeriod,
      allowedEntryRegimes: [...input.allowedEntryRegimes],
      exitOnRegimeMismatch: input.exitOnRegimeMismatch,
    },
  };
}

function buildEnsembleProxyCandidate(input: {
  base: CandidateConfig;
  symbol: string;
  strategyId: string;
  strategyName: string;
  hypothesisFamily: string;
  correlationBucket: string;
  trendSlowPeriod?: number;
  trendConfirmBars: number;
  trendMinDiffPct: number;
  breakoutPeriod: number;
  breakoutExitPeriod: number;
  ensembleThreshold: number;
  ensembleWeights: {
    trend: number;
    meanReversion: number;
    breakout: number;
  };
}): CandidateConfig {
  const params = asParams(input.base.params);
  return {
    strategyId: input.strategyId,
    strategyName: input.strategyName,
    strategy: "ensemble",
    applicableSymbols: [input.symbol],
    hypothesisFamily: input.hypothesisFamily,
    correlationBucket: input.correlationBucket,
    params: {
      trendFastPeriod: intParam(params.trendFastPeriod) ?? 20,
      trendSlowPeriod:
        input.trendSlowPeriod ?? intParam(params.trendSlowPeriod) ?? 50,
      trendConfirmBars: input.trendConfirmBars,
      trendMinDiffPct: input.trendMinDiffPct,
      allowShort: params.allowShort ?? true,
      breakoutPeriod: input.breakoutPeriod,
      breakoutExitPeriod: input.breakoutExitPeriod,
      rsiPeriod: intParam(params.rsiPeriod) ?? 14,
      rsiOversold: numberParam(params.rsiOversold) ?? 30,
      rsiOverbought: numberParam(params.rsiOverbought) ?? 70,
      bbPeriod: intParam(params.bbPeriod) ?? 20,
      bbStdDev: numberParam(params.bbStdDev) ?? 2,
      ensembleThreshold: input.ensembleThreshold,
      ensembleWeights: {
        trend: input.ensembleWeights.trend,
        meanReversion: input.ensembleWeights.meanReversion,
        breakout: input.ensembleWeights.breakout,
      },
    },
  };
}

function materializeDataset(
  symbol: string,
  left: CandidateManifest,
  right: CandidateManifest,
): Record<string, unknown> {
  const base = (left.dataset ?? right.dataset ?? {}) as Record<string, unknown>;
  const inputCsv =
    normalizeOptionalString(base.inputCsv) ?? defaultInputCsvForSymbol(symbol);
  const lookbackBars = intParam(base.lookbackBars) ?? 3600;
  return {
    ...base,
    symbol,
    inputCsv,
    lookbackBars,
  };
}

function defaultInputCsvForSymbol(symbol: string): string {
  if (symbol === "BTC/USD") {
    return "data/market/okx/BTC_USDT_USDT_1h.csv";
  }
  return "";
}

function asParams(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
