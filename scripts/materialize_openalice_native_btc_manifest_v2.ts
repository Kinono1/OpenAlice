import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildEnsembleCandidate,
  buildManifestFromBase,
  buildMeanReversionCandidate,
  readJson,
  type CandidateConfig,
  type CandidateManifest,
} from "./lib/btc_paradigm_compiler.js";
import { getStrategyMinimumBars } from "../src/backtest/strategy-validation/strategies.js";
import type { StrategyParams } from "../src/backtest/strategy-validation/types.js";
import {
  buildSourceEligibilityFields,
  deriveManifestSourceDefaults,
  resolveSourceEligibility,
} from "../src/runtime/source_eligibility.js";

interface CliArgs {
  dryRun: boolean;
  baseManifest: string;
  output: string;
  cardsOutput: string;
  cardsMdOutput: string;
  batchId: string;
  batchGoal: string;
  symbol: string;
}

interface ExperimentCard {
  familyId: string;
  mechanism: string;
  hypothesis: string;
  regime: string[];
  holdingTime: string;
  intervention: string;
  controls: string[];
  metrics: string[];
  killCriteria: string[];
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: "btc_openalice_native_manifest_v2",
      command: "materialize_openalice_native_btc_manifest_v2",
      executionMode: {
        dryRun: true,
        readsBaseManifest: false,
        writesManifest: false,
        writesExperimentCards: false,
        promotionEligible: false,
      },
      outputs: {
        manifest: args.output,
        cards: args.cardsOutput,
        cardsMd: args.cardsMdOutput,
      },
      optIn: {
        materializeManifest: "--dryRun false",
      },
    }, null, 2));
    return;
  }

  const baseManifest = await readJson<CandidateManifest>(args.baseManifest);
  const notes = [
    "source_id=btc_openalice_native_rebuild_v2",
    "source_lineage=openalice_native",
    "admission_intent=promotion",
    "promotion_eligible=true",
    "donor_native=false",
    "family_design=openalice_native_factor_mean_reversion_v2",
    "eth_transfer_blocked_until_btc_admitted=true",
  ];
  const defaults = deriveManifestSourceDefaults(notes);
  const candidates = buildNativeV2Candidates(args.symbol).map((candidate) => ({
    ...candidate,
    ...buildSourceEligibilityFields(resolveSourceEligibility(candidate, defaults)),
  }));
  const manifest = buildManifestFromBase({
    baseManifest,
    batchId: args.batchId,
    batchGoal: args.batchGoal,
    notes,
    candidates,
  });
  manifest.wfo = {
    ...(manifest.wfo ?? {}),
    trainBars: 1200,
    testBars: 240,
    stepBars: 240,
    degradationThreshold: 0.4,
    profile: "stable",
  };
  manifest.significance = {
    ...(manifest.significance ?? {}),
    multipleTestingUnit: "family",
  };
  validateManifestProtocol(manifest);

  const cards = buildExperimentCards();
  await Promise.all([
    writeJson(args.output, manifest),
    writeJson(args.cardsOutput, {
      schemaVersion: "openalice_native_experiment_cards.v2",
      generatedAt: new Date().toISOString(),
      symbol: args.symbol,
      batchId: args.batchId,
      cards,
    }),
    writeText(args.cardsMdOutput, renderCardsMarkdown(cards)),
  ]);
  console.log(
    [
      `manifest=${resolve(args.output)}`,
      `cards=${resolve(args.cardsOutput)}`,
      `cardsMd=${resolve(args.cardsMdOutput)}`,
      `candidateCount=${candidates.length}`,
    ].join(" | "),
  );
}

function buildNativeV2Candidates(symbol: string): CandidateConfig[] {
  return [
    buildFactorMeanReversionCandidate({
      symbol,
      strategyId: "OA_NATIVE_V2_FMR_BALANCED",
      strategyName: "oa_native_v2_factor_mean_reversion_balanced",
      familySuffix: "native_v2_factor_mean_reversion_balanced_family",
      bucketSuffix: "native_v2_fmr_balanced",
      factorEntryThreshold: 0.22,
      factorExitThreshold: 0.08,
      factorPositionPctOfEquity: 0.03,
      factorMaxHoldingBars: 18,
      factorStopLossPct: 0.018,
      factorKillSwitchVolPct: 2.2,
      factorKillSwitchTrendStrengthPct: 0.55,
      regimeGate: {
        allowedEntryRegimes: ["LowVolCarry", "HighVolMeanRevert"],
        exitOnMismatch: true,
      },
    }),
    buildFactorMeanReversionCandidate({
      symbol,
      strategyId: "OA_NATIVE_V2_FMR_MORE_TRADES",
      strategyName: "oa_native_v2_factor_mean_reversion_more_trades",
      familySuffix: "native_v2_factor_mean_reversion_more_trades_family",
      bucketSuffix: "native_v2_fmr_more_trades",
      factorEntryThreshold: 0.16,
      factorExitThreshold: 0.05,
      factorPositionPctOfEquity: 0.025,
      factorMaxHoldingBars: 12,
      factorStopLossPct: 0.012,
      factorKillSwitchVolPct: 2.6,
      factorKillSwitchTrendStrengthPct: 0.65,
      regimeGate: {
        allowedEntryRegimes: ["LowVolCarry", "HighVolMeanRevert", "LowVolTrend"],
        exitOnMismatch: true,
      },
    }),
    buildFactorMeanReversionCandidate({
      symbol,
      strategyId: "OA_NATIVE_V2_FMR_TIGHT_RISK",
      strategyName: "oa_native_v2_factor_mean_reversion_tight_risk",
      familySuffix: "native_v2_factor_mean_reversion_tight_risk_family",
      bucketSuffix: "native_v2_fmr_tight_risk",
      factorEntryThreshold: 0.28,
      factorExitThreshold: 0.1,
      factorPositionPctOfEquity: 0.02,
      factorMaxHoldingBars: 8,
      factorStopLossPct: 0.008,
      factorKillSwitchVolPct: 1.8,
      factorKillSwitchTrendStrengthPct: 0.45,
      regimeGate: {
        allowedEntryRegimes: ["LowVolCarry", "HighVolMeanRevert"],
        exitOnMismatch: true,
      },
    }),
    buildMeanReversionCandidate({
      symbol,
      strategyId: "OA_NATIVE_V2_MR_SAMPLE_CONTROL",
      strategyName: "oa_native_v2_mean_reversion_sample_control",
      familySuffix: "native_v2_mean_reversion_sample_control_family",
      bucketSuffix: "native_v2_mr_sample_control",
      rsiPeriod: 10,
      rsiOversold: 32,
      rsiOverbought: 68,
      bbPeriod: 18,
      bbStdDev: 2.0,
      allowShort: false,
      regimeGate: {
        allowedEntryRegimes: ["LowVolCarry", "HighVolMeanRevert", "LowVolTrend"],
        exitOnMismatch: true,
      },
    }),
    buildEnsembleCandidate({
      symbol,
      strategyId: "OA_NATIVE_V2_MR_ENSEMBLE_CONTROL",
      strategyName: "oa_native_v2_mean_reversion_ensemble_control",
      familySuffix: "native_v2_mean_reversion_ensemble_control_family",
      bucketSuffix: "native_v2_mr_ensemble_control",
      threshold: 0.25,
      allowShort: false,
      weights: {
        trend: 0.25,
        meanReversion: 1.5,
        breakout: 0.25,
      },
      regimeGate: {
        allowedEntryRegimes: ["LowVolCarry", "HighVolMeanRevert"],
        exitOnMismatch: true,
      },
    }),
  ];
}

function buildFactorMeanReversionCandidate(input: {
  symbol: string;
  strategyId: string;
  strategyName: string;
  familySuffix: string;
  bucketSuffix: string;
  factorEntryThreshold: number;
  factorExitThreshold: number;
  factorPositionPctOfEquity: number;
  factorMaxHoldingBars: number;
  factorStopLossPct: number;
  factorKillSwitchVolPct: number;
  factorKillSwitchTrendStrengthPct: number;
  regimeGate: NonNullable<CandidateConfig["regimeGate"]>;
}): CandidateConfig {
  const symbolKey = input.symbol.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return {
    strategyId: input.strategyId,
    strategyName: input.strategyName,
    strategy: "factorMeanReversion",
    applicableSymbols: [input.symbol],
    hypothesisFamily: `${symbolKey}_${input.familySuffix}`,
    correlationBucket: `${symbolKey}_${input.bucketSuffix}`,
    params: {
      allowShort: false,
      factorEntryThreshold: input.factorEntryThreshold,
      factorExitThreshold: input.factorExitThreshold,
      factorPositionPctOfEquity: input.factorPositionPctOfEquity,
      factorMaxHoldingBars: input.factorMaxHoldingBars,
      factorStopLossPct: input.factorStopLossPct,
      factorKillSwitchVolPct: input.factorKillSwitchVolPct,
      factorKillSwitchTrendStrengthPct: input.factorKillSwitchTrendStrengthPct,
    },
    regimeGate: input.regimeGate,
  };
}

function validateManifestProtocol(manifest: CandidateManifest): void {
  const candidates = manifest.candidates ?? [];
  const testBars = Number((manifest.wfo as { testBars?: unknown } | undefined)?.testBars);
  if (!Number.isInteger(testBars) || testBars <= 0) {
    throw new Error("Native v2 manifest requires a positive integer wfo.testBars.");
  }
  const incompatible = candidates.flatMap((candidate) => {
    const minimumBars = getStrategyMinimumBars(candidate.strategy, candidate.params as StrategyParams);
    const requiredTestBars = minimumBars + 2;
    return testBars < requiredTestBars
      ? [`${candidate.strategyId}:${requiredTestBars}`]
      : [];
  });
  if (incompatible.length > 0) {
    throw new Error(
      `Native v2 manifest WFO testBars=${testBars} is shorter than candidate minimum bars: ${incompatible.join(", ")}`,
    );
  }
}

function buildExperimentCards(): ExperimentCard[] {
  return [
    {
      familyId: "OA_NATIVE_V2_FMR_BALANCED",
      mechanism: "factor mean reversion with non-trend regime gate",
      hypothesis: "A contrarian factor signal can survive admission only when regime gating blocks trend-window losses and position size remains small.",
      regime: ["LowVolCarry", "HighVolMeanRevert"],
      holdingTime: "8-18 bars",
      intervention: "factorMeanReversion threshold 0.22, max holding 18 bars, 3% equity exposure",
      controls: ["more-trades threshold ablation", "tight-risk threshold ablation"],
      metrics: ["WFO failed windows", "FDR", "PBO", "DSR", "post-cost net expectancy"],
      killCriteria: ["WFO failed-window ratio > 0.3", "FDR q > 0.1", "trade count remains too low", "positive return comes from one window"],
    },
    {
      familyId: "OA_NATIVE_V2_FMR_MORE_TRADES",
      mechanism: "lower-threshold factor mean reversion",
      hypothesis: "Lowering the entry threshold may improve sample count without losing all post-cost edge.",
      regime: ["LowVolCarry", "HighVolMeanRevert", "LowVolTrend"],
      holdingTime: "up to 12 bars",
      intervention: "factorMeanReversion threshold 0.16, stop 1.2%, 2.5% equity exposure",
      controls: ["balanced threshold", "tight-risk threshold"],
      metrics: ["trade count", "net expectancy", "WFO", "FDR"],
      killCriteria: ["cost drag dominates", "WFO instability persists", "PBO worsens"],
    },
    {
      familyId: "OA_NATIVE_V2_FMR_TIGHT_RISK",
      mechanism: "tight-risk factor mean reversion",
      hypothesis: "A higher entry threshold and tighter stop can reduce trend-window tail losses.",
      regime: ["LowVolCarry", "HighVolMeanRevert"],
      holdingTime: "up to 8 bars",
      intervention: "factorMeanReversion threshold 0.28, stop 0.8%, 2% equity exposure",
      controls: ["balanced threshold", "sample-control mean reversion"],
      metrics: ["max drawdown", "WFO", "post-cost net expectancy", "FDR"],
      killCriteria: ["trade count insufficient", "FDR q > 0.1", "DSR probability < 0.5"],
    },
    {
      familyId: "OA_NATIVE_V2_MR_SAMPLE_CONTROL",
      mechanism: "classical mean-reversion sample control",
      hypothesis: "A looser RSI/BB mean-reversion control clarifies whether v2 gains come from factor construction or sample-frequency changes.",
      regime: ["LowVolCarry", "HighVolMeanRevert", "LowVolTrend"],
      holdingTime: "hours",
      intervention: "RSI 10 with BB 18/2.0 and non-trend-biased regime gate",
      controls: ["factor mean-reversion balanced candidate"],
      metrics: ["trade count", "cost drag", "WFO", "FDR"],
      killCriteria: ["not better than factor candidates", "fails WFO or FDR"],
    },
    {
      familyId: "OA_NATIVE_V2_MR_ENSEMBLE_CONTROL",
      mechanism: "mean-reversion-heavy ensemble control",
      hypothesis: "A mean-reversion-heavy ensemble should not pass unless it adds stability beyond the factor signal.",
      regime: ["LowVolCarry", "HighVolMeanRevert"],
      holdingTime: "adaptive",
      intervention: "ensemble weights trend=0.25, meanReversion=1.5, breakout=0.25",
      controls: ["best v2 factor candidate", "sample-control mean reversion"],
      metrics: ["family FDR", "leader stability", "WFO"],
      killCriteria: ["does not beat best component", "FDR treats as duplicate search"],
    },
  ];
}

function renderCardsMarkdown(cards: ExperimentCard[]): string {
  const lines = [
    "# BTC OpenAlice Native Rebuild v2 Experiment Cards",
    "",
    "- ETH transfer remains blocked until BTC has an admitted candidate.",
    "- Donor/proxy artifacts are not promotion-eligible in this batch.",
    "- v2 focuses on factor mean reversion because v1.1 found a weak positive but WFO-unstable mean-reversion lead.",
    "",
  ];
  for (const card of cards) {
    lines.push(`## ${card.familyId}`, "");
    lines.push(`- mechanism: ${card.mechanism}`);
    lines.push(`- hypothesis: ${card.hypothesis}`);
    lines.push(`- regime: ${card.regime.join(", ")}`);
    lines.push(`- holdingTime: ${card.holdingTime}`);
    lines.push(`- intervention: ${card.intervention}`);
    lines.push(`- controls: ${card.controls.join("; ")}`);
    lines.push(`- metrics: ${card.metrics.join(", ")}`);
    lines.push(`- killCriteria: ${card.killCriteria.join("; ")}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function writeText(path: string, payload: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), payload, "utf-8");
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  return {
    dryRun: parseBoolArg(raw.get("dryRun"), true),
    baseManifest: raw.get("base-manifest") ?? "docs/research/strategy_candidates.btc_paradigm_clean_base.v1.json",
    output: raw.get("output") ?? "docs/research/strategy_candidates.btc_openalice_native_rebuild_v2.json",
    cardsOutput: raw.get("cards-output") ?? "data/research/strategy/openalice_native_rebuild_experiment_cards.btc_v2.json",
    cardsMdOutput: raw.get("cards-md-output") ?? "data/research/strategy/openalice_native_rebuild_experiment_cards.btc_v2.md",
    batchId: raw.get("batch-id") ?? "btc_openalice_native_rebuild_v2",
    batchGoal: raw.get("batch-goal") ?? "Materialize BTC OpenAlice-native factor mean-reversion v2 family for admission rebuild.",
    symbol: raw.get("symbol") ?? "BTC/USD",
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const withoutPrefix = token.slice(2);
    const eq = withoutPrefix.indexOf("=");
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1));
      continue;
    }
    const key = withoutPrefix;
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

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
};
