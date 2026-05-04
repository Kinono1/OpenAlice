import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildManifestFromBase,
  buildRegimeTrendCandidate,
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
  canonicalManifestPath: string;
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
      family: "btc_openalice_native_manifest_v3",
      command: "materialize_openalice_native_btc_manifest_v3",
      executionMode: {
        dryRun: true,
        readsBaseManifest: false,
        writesManifest: false,
        writesExperimentCards: false,
        writesCanonicalManifestPointer: false,
        promotionEligible: false,
      },
      outputs: {
        manifest: args.output,
        cards: args.cardsOutput,
        cardsMd: args.cardsMdOutput,
        canonicalManifestPointer: args.canonicalManifestPath,
      },
      optIn: {
        materializeManifest: "--dryRun false",
      },
    }, null, 2));
    return;
  }

  const baseManifest = await readJson<CandidateManifest>(args.baseManifest);
  const notes = [
    "source_id=btc_openalice_native_rebuild_v3",
    "source_lineage=openalice_native",
    "admission_intent=promotion",
    "promotion_eligible=true",
    "donor_native=false",
    "family_design=openalice_native_btc_specialist_v3",
    "batch_shape=two_family_specialist",
    "eth_transfer_blocked_until_btc_admitted=true",
  ];
  const defaults = deriveManifestSourceDefaults(notes);
  const candidates = buildNativeV3Candidates(args.symbol).map((candidate) => ({
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
      schemaVersion: "openalice_native_experiment_cards.v3",
      generatedAt: new Date().toISOString(),
      symbol: args.symbol,
      batchId: args.batchId,
      cards,
    }),
    writeText(args.cardsMdOutput, renderCardsMarkdown(cards)),
    writeJson(args.canonicalManifestPath, {
      generatedAt: new Date().toISOString(),
      batchId: args.batchId,
      canonicalManifest: resolve(args.output),
      canonicalCards: resolve(args.cardsOutput),
      canonicalCardsMarkdown: resolve(args.cardsMdOutput),
      notes: [
        "Current canonical BTC native manifest pointer.",
        "Consumers should follow this pointer instead of guessing among v1_1/v2/v3 outputs.",
      ],
    }),
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

function buildNativeV3Candidates(symbol: string): CandidateConfig[] {
  return [
    buildRegimeTrendCandidate({
      symbol,
      strategyId: "OA_NATIVE_V3_HVT_REGIME_TREND",
      strategyName: "oa_native_v3_high_vol_trend_specialist",
      familySuffix: "native_v3_high_vol_trend_family",
      bucketSuffix: "native_v3_high_vol_trend",
      fast: 34,
      slow: 144,
      allowShort: false,
      allowedEntryRegimes: ["HighVolTrend"],
      exitOnRegimeMismatch: true,
      volatilityGate: {
        minVolatilityPct: 0.6,
        minTrendStrengthPct: 0.2,
        exitOnMismatch: true,
      },
    }),
    buildFactorMeanReversionCandidate({
      symbol,
      strategyId: "OA_NATIVE_V3_LVC_FMR_SPECIALIST",
      strategyName: "oa_native_v3_low_vol_carry_fmr_specialist",
      familySuffix: "native_v3_low_vol_carry_fmr_family",
      bucketSuffix: "native_v3_low_vol_carry_fmr",
      factorEntryThreshold: 0.24,
      factorExitThreshold: 0.08,
      factorPositionPctOfEquity: 0.02,
      factorMaxHoldingBars: 10,
      factorStopLossPct: 0.009,
      factorKillSwitchVolPct: 2.1,
      factorKillSwitchTrendStrengthPct: 0.4,
      regimeGate: {
        allowedEntryRegimes: ["LowVolCarry", "HighVolMeanRevert"],
        exitOnMismatch: true,
      },
      volatilityGate: {
        maxVolatilityPct: 2.4,
        maxTrendStrengthPct: 0.45,
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
  volatilityGate?: CandidateConfig["volatilityGate"];
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
    volatilityGate: input.volatilityGate,
  };
}

function validateManifestProtocol(manifest: CandidateManifest): void {
  const candidates = manifest.candidates ?? [];
  const testBars = Number((manifest.wfo as { testBars?: unknown } | undefined)?.testBars);
  if (!Number.isInteger(testBars) || testBars <= 0) {
    throw new Error("Native v3 manifest requires a positive integer wfo.testBars.");
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
      `Native v3 manifest WFO testBars=${testBars} is shorter than candidate minimum bars: ${incompatible.join(", ")}`,
    );
  }
}

function buildExperimentCards(): ExperimentCard[] {
  return [
    {
      familyId: "OA_NATIVE_V3_HVT_REGIME_TREND",
      mechanism: "high-volatility trend specialist",
      hypothesis:
        "BTC trend entries only survive admission when the pool stops trading low-vol chop and only deploys inside the strongest directional regime.",
      regime: ["HighVolTrend"],
      holdingTime: "multi-day until regime mismatch",
      intervention:
        "regimeTrend fast=34 slow=144, long-only, HighVolTrend-only, min volatility 0.6%, min trend strength 0.2%",
      controls: [
        "same BTC 1h dataset and WFO window as v1/v2",
        "single-family hypothesis to reduce family crowding",
      ],
      metrics: [
        "WFO failedWindowRatio",
        "meanPbo",
        "meanDsrProbability",
        "netExpectancyPct",
      ],
      killCriteria: [
        "WFO failed windows > 6/10",
        "meanPbo > 0.2",
        "netExpectancyPct <= 0",
      ],
    },
    {
      familyId: "OA_NATIVE_V3_LVC_FMR_SPECIALIST",
      mechanism: "low-vol carry / high-vol mean-revert factor specialist",
      hypothesis:
        "Contrarian BTC entries can survive admission when they are restricted to low-vol carry and high-vol mean-revert pockets and forced out once trend strength expands.",
      regime: ["LowVolCarry", "HighVolMeanRevert"],
      holdingTime: "6-10 bars",
      intervention:
        "factorMeanReversion threshold 0.24 / exit 0.08, 2% equity exposure, 0.9% stop, volatility/trend mismatch exit",
      controls: [
        "same BTC 1h dataset and WFO window as v1/v2",
        "single-family hypothesis to reduce multiple-testing burden",
      ],
      metrics: [
        "WFO failedWindowRatio",
        "meanPbo",
        "meanDsrProbability",
        "fundingExpectancyDragPct",
      ],
      killCriteria: [
        "WFO failed windows > 5/10",
        "meanPbo > 0.2",
        "meanDsrProbability < 0.5",
      ],
    },
  ];
}

function renderCardsMarkdown(cards: ExperimentCard[]): string {
  const lines = ["# OpenAlice Native BTC v3 Specialist Cards", ""];
  for (const card of cards) {
    lines.push(`## ${card.familyId}`);
    lines.push(`- mechanism: ${card.mechanism}`);
    lines.push(`- hypothesis: ${card.hypothesis}`);
    lines.push(`- regime: ${card.regime.join(", ")}`);
    lines.push(`- holdingTime: ${card.holdingTime}`);
    lines.push(`- intervention: ${card.intervention}`);
    lines.push(`- controls: ${card.controls.join("; ")}`);
    lines.push(`- metrics: ${card.metrics.join("; ")}`);
    lines.push(`- killCriteria: ${card.killCriteria.join("; ")}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  return {
    dryRun: parseBoolArg(raw.get("dryRun"), true),
    baseManifest: raw.get("base-manifest") ?? "docs/research/strategy_candidates.btc_openalice_native_rebuild_v2.json",
    output: raw.get("output") ?? "docs/research/strategy_candidates.btc_openalice_native_rebuild_v3.json",
    cardsOutput: raw.get("cards-output") ?? "data/research/strategy/openalice_native_rebuild_experiment_cards.btc_v3.json",
    cardsMdOutput: raw.get("cards-md-output") ?? "data/research/strategy/openalice_native_rebuild_experiment_cards.btc_v3.md",
    batchId: raw.get("batch-id") ?? "btc_openalice_native_rebuild_v3",
    batchGoal: raw.get("batch-goal") ?? "Prune BTC native hypotheses to a 2-family specialist pool that directly tests regime specialization over clone breadth.",
    symbol: raw.get("symbol") ?? "BTC/USD",
    canonicalManifestPath: raw.get("canonical-manifest-path") ?? "data/research/strategy/openalice_native_rebuild_btc_canonical.latest.json",
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
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out.set(withoutPrefix, "true");
      continue;
    }
    out.set(withoutPrefix, next);
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

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function writeText(path: string, payload: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), payload, "utf-8");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
};
