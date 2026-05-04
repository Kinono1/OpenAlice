import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildBreakoutCandidate,
  buildEnsembleCandidate,
  buildManifestFromBase,
  buildMeanReversionCandidate,
  buildRegimeTrendCandidate,
  buildTrendCandidate,
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
  costTarget: string;
  intervention: string;
  controls: string[];
  metrics: string[];
  killCriteria: string[];
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: "btc_openalice_native_manifest",
      command: "materialize_openalice_native_btc_manifest",
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
    "source_id=btc_openalice_native_rebuild_v1",
    "source_lineage=openalice_native",
    "admission_intent=promotion",
    "promotion_eligible=true",
    "donor_native=false",
    "family_design=openalice_native_mechanism_v1",
    "eth_transfer_blocked_until_btc_admitted=true",
  ];
  const defaults = deriveManifestSourceDefaults(notes);
  const candidates = buildNativeCandidates(args.symbol).map((candidate) => ({
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
      schemaVersion: "openalice_native_experiment_cards.v1",
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

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function writeText(path: string, payload: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), payload, "utf-8");
}

function buildNativeCandidates(symbol: string): CandidateConfig[] {
  return [
    buildRegimeTrendCandidate({
      symbol,
      strategyId: "OA_NATIVE_LOW_TURNOVER_TREND_REGIME",
      strategyName: "oa_native_low_turnover_trend_regime",
      familySuffix: "native_low_turnover_trend_regime_family",
      bucketSuffix: "native_low_turnover_trend_regime",
      fast: 34,
      slow: 144,
      allowShort: false,
      allowedEntryRegimes: ["LowVolTrend", "HighVolTrend"],
      exitOnRegimeMismatch: true,
    }),
    buildBreakoutCandidate({
      symbol,
      strategyId: "OA_NATIVE_VOL_GATED_BREAKOUT",
      strategyName: "oa_native_vol_gated_breakout",
      familySuffix: "native_vol_gated_breakout_family",
      bucketSuffix: "native_vol_gated_breakout",
      breakoutPeriod: 72,
      exitPeriod: 24,
      allowShort: false,
      volatilityGate: {
        minVolatilityPct: 0.45,
        maxVolatilityPct: 6,
        minTrendStrengthPct: 0.15,
        exitOnMismatch: false,
      },
    }),
    buildMeanReversionCandidate({
      symbol,
      strategyId: "OA_NATIVE_RESTRICTED_MEAN_REVERSION",
      strategyName: "oa_native_restricted_mean_reversion",
      familySuffix: "native_restricted_mean_reversion_family",
      bucketSuffix: "native_restricted_mean_reversion",
      rsiPeriod: 12,
      rsiOversold: 25,
      rsiOverbought: 75,
      bbPeriod: 24,
      bbStdDev: 2.4,
      allowShort: false,
      regimeGate: {
        allowedEntryRegimes: ["LowVolCarry", "HighVolMeanRevert"],
        exitOnMismatch: true,
      },
    }),
    buildEnsembleCandidate({
      symbol,
      strategyId: "OA_NATIVE_DISAGREEMENT_ENSEMBLE",
      strategyName: "oa_native_disagreement_ensemble",
      familySuffix: "native_disagreement_ensemble_family",
      bucketSuffix: "native_disagreement_ensemble",
      threshold: 0.42,
      allowShort: false,
      weights: {
        trend: 1.4,
        meanReversion: 0.7,
        breakout: 1.2,
      },
    }),
    buildTrendCandidate({
      symbol,
      strategyId: "OA_NATIVE_COST_AWARE_SPARSE_SIGNAL",
      strategyName: "oa_native_cost_aware_sparse_signal",
      familySuffix: "native_cost_aware_sparse_signal_family",
      bucketSuffix: "native_cost_aware_sparse_signal",
      fast: 55,
      slow: 233,
      confirmBars: 4,
      minDiffPct: 0.012,
      allowShort: false,
      volatilityGate: {
        minTrendStrengthPct: 0.35,
        maxVolatilityPct: 5,
      },
    }),
  ];
}

function validateManifestProtocol(manifest: CandidateManifest): void {
  const candidates = manifest.candidates ?? [];
  const testBars = Number((manifest.wfo as { testBars?: unknown } | undefined)?.testBars);
  if (!Number.isInteger(testBars) || testBars <= 0) {
    throw new Error("Native manifest requires a positive integer wfo.testBars.");
  }
  const minimumBarsByCandidate = candidates.map((candidate) => {
    const minimumBars = getStrategyMinimumBars(candidate.strategy, candidate.params as StrategyParams);
    return {
      strategyId: candidate.strategyId,
      minimumBars,
      requiredTestBars: minimumBars + 2,
    };
  });
  const incompatible = minimumBarsByCandidate.filter(
    (item) => testBars < item.requiredTestBars,
  );
  if (incompatible.length > 0) {
    throw new Error(
      `Native manifest WFO testBars=${testBars} is shorter than candidate minimum bars: ${incompatible
        .map((item) => `${item.strategyId}:${item.requiredTestBars}`)
        .join(", ")}`,
    );
  }
}

function buildExperimentCards(): ExperimentCard[] {
  return [
    {
      familyId: "OA_NATIVE_LOW_TURNOVER_TREND_REGIME",
      mechanism: "low-turnover trend plus regime filter",
      hypothesis: "BTC continuation edge exists only when trend regimes persist long enough to absorb fees and slippage.",
      regime: ["LowVolTrend", "HighVolTrend"],
      holdingTime: "multi-day, low turnover",
      costTarget: "survives baseline fee/slippage plus 2x cost stress",
      intervention: "34/144 regime trend, long/flat, exit on regime mismatch",
      controls: ["same trend without regime filter", "short-enabled ablation"],
      metrics: ["aggregate FDR", "candidate WFO", "post-cost expectancy", "cost drag"],
      killCriteria: ["PBO > 0.2", "DSR probability < 0.5", "FDR q > 0.1", "WFO failed-window ratio blocks paper"],
    },
    {
      familyId: "OA_NATIVE_VOL_GATED_BREAKOUT",
      mechanism: "volatility-gated breakout",
      hypothesis: "Breakout works only when volatility is high enough to validate continuation but not so high that execution costs dominate.",
      regime: ["trend-compatible volatility windows"],
      holdingTime: "1-3 days",
      costTarget: "positive net expectancy after fee/slippage/latency",
      intervention: "72-bar breakout with 24-bar exit, long/flat",
      controls: ["short-enabled breakout", "unfiltered Donchian breakout"],
      metrics: ["FDR", "WFO degradation", "execution quality", "tail drawdown"],
      killCriteria: ["cost stress flips net expectancy negative", "breakout edge comes from one window", "candidate fails significance"],
    },
    {
      familyId: "OA_NATIVE_RESTRICTED_MEAN_REVERSION",
      mechanism: "restricted mean reversion",
      hypothesis: "Contrarian entries are only viable in bounded non-trend conditions and must remain short-horizon.",
      regime: ["LowVolCarry", "HighVolMeanRevert"],
      holdingTime: "hours to 1 day",
      costTarget: "trade count high enough for inference without excessive fee drag",
      intervention: "RSI 12 plus BB 24/2.4, long/flat",
      controls: ["short-enabled ablation", "trend-regime kill-switch ablation"],
      metrics: ["post-cost net expectancy", "trend-window loss concentration", "WFO"],
      killCriteria: ["losses concentrate in trend regimes", "short side is required to pass", "cost drag dominates net expectancy"],
    },
    {
      familyId: "OA_NATIVE_DISAGREEMENT_ENSEMBLE",
      mechanism: "explicit signal disagreement ensemble",
      hypothesis: "Disagreement between trend, breakout, and mean reversion should reduce exposure instead of averaging into false conviction.",
      regime: ["all regimes with implicit no-trade threshold"],
      holdingTime: "adaptive",
      costTarget: "must beat best single mechanism net of multiple-testing penalty",
      intervention: "weighted ensemble with higher threshold and long/flat exposure",
      controls: ["equal-weight ensemble", "best single-mechanism benchmark"],
      metrics: ["family-level FDR", "leader-vs-representative stability", "WFO"],
      killCriteria: ["does not beat best component", "fails family representative test", "FDR treats it as duplicate search"],
    },
    {
      familyId: "OA_NATIVE_COST_AWARE_SPARSE_SIGNAL",
      mechanism: "cost-aware sparse trend signal",
      hypothesis: "A sparser high-confirmation trend signal can improve admission math by reducing turnover and false positives.",
      regime: ["trend-biased"],
      holdingTime: "multi-day",
      costTarget: "low cost drag of initial capital and positive net expectancy",
      intervention: "55/233 trend, 4-bar confirmation, 1.2% min diff, long/flat",
      controls: ["lower-confirmation trend", "same parameters with short exposure"],
      metrics: ["turnover", "cost drag", "net expectancy", "FDR/WFO"],
      killCriteria: ["sparsity removes all edge", "sample count becomes insufficient", "only one large trend window explains return"],
    },
  ];
}

function renderCardsMarkdown(cards: ExperimentCard[]): string {
  const lines = [
    "# BTC OpenAlice Native Rebuild Experiment Cards",
    "",
    "- ETH transfer remains blocked until BTC has an admitted candidate.",
    "- Donor/proxy artifacts are not promotion-eligible in this batch.",
    "",
  ];
  for (const card of cards) {
    lines.push(`## ${card.familyId}`, "");
    lines.push(`- mechanism: ${card.mechanism}`);
    lines.push(`- hypothesis: ${card.hypothesis}`);
    lines.push(`- regime: ${card.regime.join(", ")}`);
    lines.push(`- holdingTime: ${card.holdingTime}`);
    lines.push(`- costTarget: ${card.costTarget}`);
    lines.push(`- intervention: ${card.intervention}`);
    lines.push(`- controls: ${card.controls.join("; ")}`);
    lines.push(`- metrics: ${card.metrics.join(", ")}`);
    lines.push(`- killCriteria: ${card.killCriteria.join("; ")}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  return {
    dryRun: parseBoolArg(raw.get("dryRun"), true),
    baseManifest: raw.get("base-manifest") ?? "docs/research/strategy_candidates.btc_paradigm_clean_base.v1.json",
    output: raw.get("output") ?? "docs/research/strategy_candidates.btc_openalice_native_rebuild_v1_1.json",
    cardsOutput: raw.get("cards-output") ?? "data/research/strategy/openalice_native_rebuild_experiment_cards.btc_v1_1.json",
    cardsMdOutput: raw.get("cards-md-output") ?? "data/research/strategy/openalice_native_rebuild_experiment_cards.btc_v1_1.md",
    batchId: raw.get("batch-id") ?? "btc_openalice_native_rebuild_v1_1",
    batchGoal: raw.get("batch-goal") ?? "Materialize five BTC OpenAlice-native mechanism families with executable gating for admission rebuild v1.1.",
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
