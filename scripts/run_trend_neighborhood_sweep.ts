import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { safePathComponent } from "../src/core/path-safety.js";
import {
  appendExecutionJournal,
  extractSummaryMetrics,
  sanitizeError,
} from "./lib/execution_journal.js";

type MultipleTestingUnit = "candidate" | "family";
type AllowShortMode = "inherit" | "long_only" | "long_short" | "both";

interface RouteManifestCandidate {
  strategyId?: string;
  strategyName?: string;
  strategy?: string;
  applicableSymbols?: string[];
  hypothesisFamily?: string;
  correlationBucket?: string;
  params?: Record<string, unknown>;
}

interface RouteManifest {
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
  candidates?: RouteManifestCandidate[];
}

interface TrendSeed {
  seedIndex: number;
  baseCandidate: RouteManifestCandidate;
  baseFast: number;
  baseSlow: number;
  baseConfirmBars: number;
  baseMinDiffPct: number;
  baseAllowShort: boolean;
  variants: TrendVariant[];
}

interface TrendVariant {
  seedIndex: number;
  variantIndex: number;
  mutationScore: number;
  distanceFast: number;
  distanceSlow: number;
  changed: boolean;
  candidate: RouteManifestCandidate;
  fast: number;
  slow: number;
  confirmBars: number;
  minDiffPct: number;
  allowShort: boolean;
}

interface NeighborhoodResult {
  trial: number;
  result: string | null;
  reasonCodes: string[];
  baseAggregateMetrics: Record<string, unknown> | null;
  aggregateMetrics: Record<string, unknown> | null;
  hardGap: {
    pboGap: number;
    dsrGap: number;
    fdrGap: number;
    totalGap: number;
  } | null;
  wfoFailureDensity: number | null;
  meanSharpe: number | null;
  mutationSummary: {
    mutatedSlots: number;
    totalMutationScore: number;
    params: Array<{
      seedIndex: number;
      strategyId: string;
      strategyName: string;
      fast: number;
      slow: number;
      confirmBars: number;
      minDiffPct: number;
      allowShort: boolean;
      changed: boolean;
      mutationScore: number;
    }>;
  };
  outputs: {
    manifest: string;
    validationRuns: string;
    verdict: string;
    releaseGateStatus: string;
    status: string;
    phaseReadiness: string;
  };
}

interface CliArgs {
  seedManifest: string;
  overrideJson?: string;
  sweepId: string;
  symbol: string;
  sourceId?: string;
  inputCsv?: string;
  lookbackBars?: number;
  multipleTestingUnit?: MultipleTestingUnit;
  protocolProfile?: string;
  fdrMethod?: "bh" | "by" | "cv_storey_bh" | "stepc" | "spa";
  wfoProfile?: "stable" | "shift" | "stress";
  storeyLambda?: number;
  cvAggQuantile?: number;
  fastDeltas: number[];
  slowDeltas: number[];
  confirmBarsDeltas: number[];
  minDiffDeltas: number[];
  allowShortMode: AllowShortMode;
  perSeedLimit: number;
  maxMutatedSlots: number;
  maxTrials?: number;
  minGap: number;
  maxGap?: number;
  minPairDistance: number;
  mutationScoreFastWeight: number;
  mutationScoreSlowWeight: number;
  mutationScoreConfirmBarsWeight: number;
  mutationScoreMinDiffWeight: number;
  mutationScoreAllowShortPenalty: number;
  summaryOutput?: string;
  markdownOutput?: string;
  bestManifestOutput?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `${sanitizeTag(args.sweepId)}.${new Date().toISOString().replace(/[:.]/g, "")}`;
  const summaryOutput =
    args.summaryOutput ??
    `data/research/strategy/analysis/${sanitizeTag(args.sweepId)}.json`;
  const markdownOutput =
    args.markdownOutput ??
    `data/research/strategy/analysis/${sanitizeTag(args.sweepId)}.md`;
  const journalInputs = {
    seedManifest: resolve(args.seedManifest),
    overrideJson: args.overrideJson ? resolve(args.overrideJson) : null,
    sweepId: args.sweepId,
    symbol: args.symbol,
    sourceId: args.sourceId ?? null,
    protocolProfile: args.protocolProfile ?? null,
    multipleTestingUnit: args.multipleTestingUnit ?? null,
    fdrMethod: args.fdrMethod ?? "bh",
    wfoProfile: args.wfoProfile ?? "stable",
    maxTrials: args.maxTrials ?? null,
    maxMutatedSlots: args.maxMutatedSlots,
  };
  const journalOutputs = {
    summary: resolve(summaryOutput),
    markdown: resolve(markdownOutput),
    bestManifest: args.bestManifestOutput ? resolve(args.bestManifestOutput) : null,
  };

  await appendExecutionJournal({
    runId,
    batchId: args.sweepId,
    stage: "refinement",
    action: "refinement",
    status: "started",
    inputs: journalInputs,
    outputs: journalOutputs,
    decision: "started",
    codeRefs: ["scripts/run_trend_neighborhood_sweep.ts", "scripts/run_route_af.ts"],
  });

  try {
    const [baseSeedManifest, manifestOverride] = await Promise.all([
      readJson<RouteManifest>(args.seedManifest),
      args.overrideJson
        ? readJson<Partial<RouteManifest>>(args.overrideJson)
        : Promise.resolve(null),
    ]);
    const seedManifest = manifestOverride
      ? deepMerge(baseSeedManifest, manifestOverride)
      : baseSeedManifest;
    const baseCandidates = Array.isArray(seedManifest.candidates)
      ? seedManifest.candidates
      : [];
    if (baseCandidates.length === 0) {
      throw new Error(`Seed manifest ${args.seedManifest} has no candidates.`);
    }

    const seeds = buildSeeds(baseCandidates, args.symbol, args);
    if (seeds.length === 0) {
      throw new Error("No trend seeds were generated from the seed manifest.");
    }

    const generatedSelections = enumerateSelections(seeds, args);
    if (generatedSelections.length === 0) {
      throw new Error("Neighborhood search produced zero valid candidate selections.");
    }

    const tmpRoot = await mkdtemp(join(tmpdir(), "openalice-trend-neighborhood-"));
    const dataset = buildDataset(seedManifest.dataset, args);
    const multipleTestingUnit =
      args.multipleTestingUnit ??
      ((seedManifest.significance?.multipleTestingUnit as MultipleTestingUnit | undefined) ??
        "candidate");
    const protocolProfile = args.protocolProfile ?? "route_strict_v1";

    const results: NeighborhoodResult[] = [];
    for (const selection of generatedSelections) {
      const tag = sanitizeTag(
        `${args.sweepId}.trial_${String(selection.trial).padStart(3, "0")}`,
      );
      const tempManifestPath = resolve(tmpRoot, `${tag}.manifest.json`);
      const manifest: RouteManifest = {
        ...seedManifest,
        generatedAt: new Date().toISOString(),
        batchId: tag,
        batchGoal:
          seedManifest.batchGoal ??
          `Neighborhood sweep ${args.sweepId} for ${args.symbol} under ${protocolProfile}.`,
        notes: [
          ...(Array.isArray(seedManifest.notes) ? seedManifest.notes : []),
          `neighborhood_sweep_id=${args.sweepId}`,
          `source_id=${args.sourceId ?? "unknown"}`,
          `protocol_profile=${protocolProfile}`,
          `multiple_testing_unit=${multipleTestingUnit}`,
          `mutated_slots=${selection.mutatedSlots}`,
          `total_mutation_score=${selection.totalMutationScore}`,
        ],
        dataset,
        significance: {
          ...(seedManifest.significance ?? {}),
          multipleTestingUnit,
        },
        candidates: selection.variants.map((item) => item.candidate),
      };
      await writeFile(tempManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

      const outputs = {
        manifest: tempManifestPath,
        validationRuns: resolve(`data/research/strategy/strategy_validation_runs.${tag}.json`),
        verdict: resolve(`data/research/strategy/experiment_verdict.${tag}.json`),
        releaseGateStatus: resolve(`data/runtime/release_gate_status.${tag}.json`),
        status: resolve(`data/runtime/route_af_status.${tag}.latest.json`),
        phaseReadiness: resolve(`data/runtime/phase_readiness.${tag}.latest.json`),
      };

      await execNodeQuiet([
        "--import",
        "tsx",
        "./scripts/run_route_af.ts",
        "--candidates",
        tempManifestPath,
        "--tag",
        tag,
        "--multiple-testing-unit",
        multipleTestingUnit,
        "--source-id",
        args.sourceId ?? `${args.sweepId}:trial${String(selection.trial).padStart(3, "0")}`,
        "--protocol-profile",
        protocolProfile,
        ...(args.fdrMethod ? ["--fdr-method", args.fdrMethod] : []),
        ...(args.wfoProfile ? ["--wfo-profile", args.wfoProfile] : []),
        ...(args.storeyLambda !== undefined
          ? ["--storey-lambda", String(args.storeyLambda)]
          : []),
        ...(args.cvAggQuantile !== undefined
          ? ["--cv-agg-quantile", String(args.cvAggQuantile)]
          : []),
        "--statusOutput",
        outputs.status,
        "--phaseReadinessOutput",
        outputs.phaseReadiness,
      ]);

      const [verdict, runs] = await Promise.all([
        readJson<Record<string, unknown>>(outputs.verdict),
        readJson<Record<string, unknown>>(outputs.validationRuns),
      ]);
      const result = buildResult({
        trial: selection.trial,
        variants: selection.variants,
        totalMutationScore: selection.totalMutationScore,
        verdict,
        runs,
        outputs,
      });
      results.push(result);
      console.log(
        [
          `trial=${result.trial}`,
          `mutatedSlots=${result.mutationSummary.mutatedSlots}`,
          `totalMutationScore=${result.mutationSummary.totalMutationScore}`,
          `result=${result.result ?? "unknown"}`,
          `totalGap=${result.hardGap?.totalGap ?? "n/a"}`,
          `wfoFailureDensity=${result.wfoFailureDensity ?? "n/a"}`,
          `meanSharpe=${result.meanSharpe ?? "n/a"}`,
        ].join(" | ")
      );
    }

    const rankedTrials = rankResults(results);
    const recommendedTrial = rankedTrials[0]?.trial ?? null;
    const payload = {
      schemaVersion: "trend_neighborhood_sweep_result.v1",
      sweepId: args.sweepId,
      generatedAt: new Date().toISOString(),
      sourceId: args.sourceId ?? null,
      symbol: args.symbol,
      protocolProfile,
      fdrMethod: args.fdrMethod ?? "bh",
      wfoProfile: args.wfoProfile ?? "stable",
      dataset,
      searchConfig: {
        fastDeltas: args.fastDeltas,
        slowDeltas: args.slowDeltas,
        confirmBarsDeltas: args.confirmBarsDeltas,
        minDiffDeltas: args.minDiffDeltas,
        allowShortMode: args.allowShortMode,
        perSeedLimit: args.perSeedLimit,
        maxMutatedSlots: args.maxMutatedSlots,
        maxTrials: args.maxTrials ?? null,
        minGap: args.minGap,
        maxGap: args.maxGap ?? null,
        minPairDistance: args.minPairDistance,
        mutationScoreFastWeight: args.mutationScoreFastWeight,
        mutationScoreSlowWeight: args.mutationScoreSlowWeight,
        mutationScoreConfirmBarsWeight: args.mutationScoreConfirmBarsWeight,
        mutationScoreMinDiffWeight: args.mutationScoreMinDiffWeight,
        mutationScoreAllowShortPenalty: args.mutationScoreAllowShortPenalty,
      },
      trialCount: results.length,
      recommendedTrial,
      rankedTrials,
      trials: results,
    };

    await mkdir(dirname(resolve(summaryOutput)), { recursive: true });
    await Promise.all([
      writeFile(resolve(summaryOutput), `${JSON.stringify(payload, null, 2)}\n`, "utf-8"),
      writeFile(resolve(markdownOutput), renderMarkdown(payload), "utf-8"),
    ]);

    if (args.bestManifestOutput && rankedTrials[0]) {
      await writeFile(
        resolve(args.bestManifestOutput),
        `${JSON.stringify(
          {
            ...seedManifest,
            generatedAt: new Date().toISOString(),
            batchId: sanitizeTag(`${args.sweepId}.best_manifest`),
            batchGoal:
              seedManifest.batchGoal ??
              `Best manifest from neighborhood sweep ${args.sweepId}.`,
            notes: [
              ...(Array.isArray(seedManifest.notes) ? seedManifest.notes : []),
              `neighborhood_sweep_best_manifest=${args.sweepId}`,
              `recommended_trial=${rankedTrials[0].trial}`,
            ],
            dataset,
            significance: {
              ...(seedManifest.significance ?? {}),
              multipleTestingUnit,
            },
            candidates: rankedTrials[0].mutationSummary.params.map((item) => ({
              ...(seeds[item.seedIndex]?.baseCandidate ?? {}),
              strategyId: item.strategyId,
              strategyName: item.strategyName,
              strategy: "trend",
              applicableSymbols: [args.symbol],
              hypothesisFamily: buildHypothesisFamily(
                args.symbol,
                item.fast,
                item.slow,
                item.confirmBars,
                item.minDiffPct,
                item.allowShort,
              ),
              correlationBucket: buildCorrelationBucket(
                args.symbol,
                item.fast,
                item.slow,
                item.confirmBars,
                item.minDiffPct,
                item.allowShort,
              ),
              params: {
                trendFastPeriod: item.fast,
                trendSlowPeriod: item.slow,
                trendConfirmBars: item.confirmBars,
                trendMinDiffPct: item.minDiffPct,
                allowShort: item.allowShort,
              },
            })),
          },
          null,
          2
        )}\n`,
        "utf-8"
      );
    }

    await appendExecutionJournal({
      runId,
      batchId: args.sweepId,
      stage: "refinement",
      action: "refinement",
      status: "completed",
      inputs: journalInputs,
      outputs: journalOutputs,
      summaryMetrics: extractSummaryMetrics(payload),
      decision: recommendedTrial === null ? "failed" : "completed",
      codeRefs: ["scripts/run_trend_neighborhood_sweep.ts", "scripts/run_route_af.ts"],
    });

    console.log(
      [
        `summary=${resolve(summaryOutput)}`,
        `markdown=${resolve(markdownOutput)}`,
        `recommendedTrial=${recommendedTrial ?? "none"}`,
        ...(args.bestManifestOutput ? [`bestManifest=${resolve(args.bestManifestOutput)}`] : []),
      ].join(" | ")
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: args.sweepId,
      stage: "refinement",
      action: "refinement",
      status: "failed",
      inputs: journalInputs,
      outputs: journalOutputs,
      decision: "failed",
      codeRefs: ["scripts/run_trend_neighborhood_sweep.ts", "scripts/run_route_af.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const seedManifest = raw.get("seed-manifest");
  const overrideJson = raw.get("override-json");
  const sweepId = raw.get("sweep-id");
  const symbol = raw.get("symbol");
  if (!seedManifest) throw new Error("--seed-manifest is required.");
  if (!sweepId) throw new Error("--sweep-id is required.");
  if (!symbol) throw new Error("--symbol is required.");

  const perSeedLimit = parsePositiveInt(raw.get("per-seed-limit")) ?? 5;
  const maxMutatedSlots = parsePositiveInt(raw.get("max-mutated-slots")) ?? 2;
  const minGap = parsePositiveInt(raw.get("min-gap")) ?? 20;
  const maxGap = parsePositiveInt(raw.get("max-gap")) ?? undefined;
  const minPairDistance = parseNonNegativeInt(raw.get("min-pair-distance")) ?? 8;
  const maxTrials = parsePositiveInt(raw.get("max-trials")) ?? undefined;

  return {
    seedManifest,
    overrideJson: normalizeOptionalString(overrideJson),
    sweepId,
    symbol,
    sourceId: normalizeOptionalString(raw.get("source-id") ?? raw.get("sourceId")),
    inputCsv: normalizeOptionalString(raw.get("input-csv") ?? raw.get("inputCsv")),
    lookbackBars: parsePositiveInt(raw.get("lookback-bars") ?? raw.get("lookbackBars")) ?? undefined,
    multipleTestingUnit:
      raw.get("multiple-testing-unit") === "family" ? "family" : "candidate",
    protocolProfile: normalizeOptionalString(
      raw.get("protocol-profile") ?? raw.get("protocolProfile")
    ),
    fdrMethod:
      raw.get("fdr-method") === "by" ||
      raw.get("fdr-method") === "cv_storey_bh" ||
      raw.get("fdr-method") === "stepc" ||
      raw.get("fdr-method") === "spa"
        ? (raw.get("fdr-method") as
            | "by"
            | "cv_storey_bh"
            | "stepc"
            | "spa")
        : raw.get("fdr-method") === "bh"
          ? "bh"
          : undefined,
    wfoProfile:
      raw.get("wfo-profile") === "shift" ||
      raw.get("wfo-profile") === "stress" ||
      raw.get("wfo-profile") === "stable"
        ? (raw.get("wfo-profile") as "stable" | "shift" | "stress")
        : undefined,
    storeyLambda: parseOptionalNumber(raw.get("storey-lambda")),
    cvAggQuantile: parseOptionalNumber(raw.get("cv-agg-quantile")),
    fastDeltas: parseIntList(raw.get("fast-deltas"), [-4, -2, 0, 2, 4]),
    slowDeltas: parseIntList(raw.get("slow-deltas"), [-10, -5, 0, 5, 10]),
    confirmBarsDeltas: parseIntList(raw.get("confirm-bars-deltas"), [0]),
    minDiffDeltas: parseNumberList(raw.get("min-diff-deltas"), [0]),
    allowShortMode: parseAllowShortMode(raw.get("allow-short-mode")),
    perSeedLimit,
    maxMutatedSlots,
    maxTrials,
    minGap,
    maxGap,
    minPairDistance,
    mutationScoreFastWeight: parseOptionalNumber(raw.get("mutation-score-fast-weight")) ?? 1,
    mutationScoreSlowWeight: parseOptionalNumber(raw.get("mutation-score-slow-weight")) ?? 0.2,
    mutationScoreConfirmBarsWeight:
      parseOptionalNumber(raw.get("mutation-score-confirm-bars-weight")) ?? 1,
    mutationScoreMinDiffWeight:
      parseOptionalNumber(raw.get("mutation-score-min-diff-weight")) ?? 200,
    mutationScoreAllowShortPenalty:
      parseOptionalNumber(raw.get("mutation-score-allow-short-penalty")) ?? 3,
    summaryOutput: normalizeOptionalString(raw.get("summary-output")),
    markdownOutput: normalizeOptionalString(raw.get("markdown-output")),
    bestManifestOutput: normalizeOptionalString(raw.get("best-manifest-output")),
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    i += 1;
  }
  return out;
}

function buildSeeds(
  candidates: RouteManifestCandidate[],
  symbol: string,
  args: CliArgs
): TrendSeed[] {
  return candidates.map((candidate, seedIndex) => {
    if (normalizeStrategy(candidate.strategy) !== "trend") {
      throw new Error(`Seed candidate ${seedIndex} is not a trend strategy.`);
    }
    const params = isPlainObject(candidate.params) ? candidate.params : {};
    const baseFast = parsePositiveInt(String(params.trendFastPeriod));
    const baseSlow = parsePositiveInt(String(params.trendSlowPeriod));
    if (!baseFast || !baseSlow || baseSlow <= baseFast) {
      throw new Error(`Seed candidate ${seedIndex} has invalid trend params.`);
    }
    const baseConfirmBars = parsePositiveInt(String(params.trendConfirmBars)) ?? 1;
    const baseMinDiffPct = parseFiniteNumber(params.trendMinDiffPct) ?? 0;
    const baseAllowShort = Boolean(params.allowShort);
    const rawVariants: TrendVariant[] = [];
    const seen = new Set<string>();
    let variantIndex = 0;
    for (const fastDelta of args.fastDeltas) {
      for (const slowDelta of args.slowDeltas) {
        const fast = baseFast + fastDelta;
        const slow = baseSlow + slowDelta;
        if (fast <= 0 || slow <= fast) {
          continue;
        }
        const gap = slow - fast;
        if (gap < args.minGap) {
          continue;
        }
        if (args.maxGap !== undefined && gap > args.maxGap) {
          continue;
        }
        for (const confirmBarsDelta of args.confirmBarsDeltas) {
          const confirmBars = baseConfirmBars + confirmBarsDelta;
          if (!Number.isInteger(confirmBars) || confirmBars < 1) {
            continue;
          }
          for (const minDiffDelta of args.minDiffDeltas) {
            const minDiffPct = round6(
              Math.max(0, baseMinDiffPct + minDiffDelta),
            );
            for (const allowShort of resolveAllowShortValues(baseAllowShort, args.allowShortMode)) {
              const key = `${fast}:${slow}:${confirmBars}:${minDiffPct}:${allowShort ? "1" : "0"}`;
              if (seen.has(key)) {
                continue;
              }
              seen.add(key);
              const changed =
                fast !== baseFast ||
                slow !== baseSlow ||
                confirmBars !== baseConfirmBars ||
                minDiffPct !== baseMinDiffPct ||
                allowShort !== baseAllowShort;
              const mutationScore =
                Math.abs(fastDelta) * args.mutationScoreFastWeight +
                Math.abs(slowDelta) * args.mutationScoreSlowWeight +
                Math.abs(confirmBarsDelta) * args.mutationScoreConfirmBarsWeight +
                Math.abs(minDiffDelta) * args.mutationScoreMinDiffWeight +
                (allowShort !== baseAllowShort ? args.mutationScoreAllowShortPenalty : 0);
              rawVariants.push({
                seedIndex,
                variantIndex,
                mutationScore: round6(mutationScore),
                distanceFast: Math.abs(fastDelta),
                distanceSlow: Math.abs(slowDelta),
                changed,
                fast,
                slow,
                confirmBars,
                minDiffPct,
                allowShort,
                candidate: buildVariantCandidate(
                  candidate,
                  symbol,
                  fast,
                  slow,
                  confirmBars,
                  minDiffPct,
                  allowShort,
                ),
              });
              variantIndex += 1;
            }
          }
        }
      }
    }

    rawVariants.sort((left, right) => {
      if (left.changed !== right.changed) {
        return left.changed ? 1 : -1;
      }
      if (left.mutationScore !== right.mutationScore) {
        return left.mutationScore - right.mutationScore;
      }
      if (left.fast !== right.fast) {
        return left.fast - right.fast;
      }
      if (left.slow !== right.slow) {
        return left.slow - right.slow;
      }
      return Number(left.allowShort) - Number(right.allowShort);
    });

    const variants = rawVariants.slice(0, Math.max(args.perSeedLimit, 1));
    return {
      seedIndex,
      baseCandidate: candidate,
      baseFast,
      baseSlow,
      baseConfirmBars,
      baseMinDiffPct,
      baseAllowShort,
      variants,
    };
  });
}

function buildVariantCandidate(
  baseCandidate: RouteManifestCandidate,
  symbol: string,
  fast: number,
  slow: number,
  confirmBars: number,
  minDiffPct: number,
  allowShort: boolean
): RouteManifestCandidate {
  const strategyId =
    normalizeOptionalString(baseCandidate.strategyId) ??
    `TREND_${fast}_${slow}_${allowShort ? "LS" : "LO"}`;
  const diffBps = Math.round(minDiffPct * 10000);
  const strategyName = `trend_${fast}_${slow}_${allowShort ? "ls" : "lo"}_c${confirmBars}_d${diffBps}`;
  return {
    ...baseCandidate,
    strategyId: `${strategyId.split(":")[0]}_${fast}_${slow}_${allowShort ? "LS" : "LO"}_C${confirmBars}_D${diffBps}`,
    strategyName,
    strategy: "trend",
    applicableSymbols: [symbol],
    hypothesisFamily: buildHypothesisFamily(
      symbol,
      fast,
      slow,
      confirmBars,
      minDiffPct,
      allowShort,
    ),
    correlationBucket: buildCorrelationBucket(
      symbol,
      fast,
      slow,
      confirmBars,
      minDiffPct,
      allowShort,
    ),
    params: {
      trendFastPeriod: fast,
      trendSlowPeriod: slow,
      trendConfirmBars: confirmBars,
      trendMinDiffPct: minDiffPct,
      allowShort,
    },
  };
}

function buildHypothesisFamily(
  symbol: string,
  fast: number,
  slow: number,
  confirmBars: number,
  minDiffPct: number,
  allowShort: boolean
) {
  const diffBps = Math.round(minDiffPct * 10000);
  return `${normalizeSymbolKey(symbol)}_trend_family_${fast}_${slow}_c${confirmBars}_d${diffBps}_${allowShort ? "ls" : "lo"}`;
}

function buildCorrelationBucket(
  symbol: string,
  fast: number,
  slow: number,
  confirmBars: number,
  minDiffPct: number,
  allowShort: boolean
) {
  const diffBps = Math.round(minDiffPct * 10000);
  return `${normalizeSymbolKey(symbol)}_trend_${fast}_${slow}_c${confirmBars}_d${diffBps}_${allowShort ? "ls" : "lo"}`;
}

function enumerateSelections(seeds: TrendSeed[], args: CliArgs) {
  const selections: Array<{
    trial: number;
    mutatedSlots: number;
    totalMutationScore: number;
    variants: TrendVariant[];
  }> = [];
  const current: TrendVariant[] = [];
  let trial = 0;

  const pushSelection = () => {
    const mutatedSlots = current.filter((item) => item.changed).length;
    if (mutatedSlots > args.maxMutatedSlots) {
      return;
    }
    const currentParams = current.map((item) => ({
      fast: item.fast,
      slow: item.slow,
      confirmBars: item.confirmBars,
      minDiffPct: item.minDiffPct,
      allowShort: item.allowShort,
    }));
    const uniqueKey = new Set(
      currentParams.map(
        (item) =>
          `${item.fast}:${item.slow}:${item.confirmBars}:${item.minDiffPct}:${item.allowShort ? "1" : "0"}`,
      )
    );
    if (uniqueKey.size !== current.length) {
      return;
    }
    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const left = current[i];
        const right = current[j];
        const pairDistance =
          Math.abs(left.fast - right.fast) +
          Math.abs(left.slow - right.slow) +
          Math.abs(left.confirmBars - right.confirmBars) * 5 +
          Math.abs(left.minDiffPct - right.minDiffPct) * 100;
        if (pairDistance < args.minPairDistance) {
          return;
        }
      }
    }
    const totalMutationScore = round6(
      current.reduce((sum, item) => sum + item.mutationScore, 0)
    );
    selections.push({
      trial,
      mutatedSlots,
      totalMutationScore,
      variants: current.map((item) => ({ ...item })),
    });
    trial += 1;
  };

  const visit = (seedIndex: number) => {
    if (args.maxTrials !== undefined && selections.length >= args.maxTrials) {
      return;
    }
    if (seedIndex >= seeds.length) {
      pushSelection();
      return;
    }
    for (const variant of seeds[seedIndex].variants) {
      current.push(variant);
      const mutatedSlots = current.filter((item) => item.changed).length;
      if (mutatedSlots <= args.maxMutatedSlots) {
        visit(seedIndex + 1);
      }
      current.pop();
      if (args.maxTrials !== undefined && selections.length >= args.maxTrials) {
        return;
      }
    }
  };

  visit(0);
  return selections;
}

function resolveAllowShortValues(baseAllowShort: boolean, mode: AllowShortMode) {
  switch (mode) {
    case "inherit":
      return [baseAllowShort];
    case "long_only":
      return [false];
    case "long_short":
      return [true];
    case "both":
      return [baseAllowShort, !baseAllowShort];
    default:
      return [baseAllowShort];
  }
}

function buildDataset(base: Record<string, unknown> | undefined, args: CliArgs) {
  const baseLookback = toPositiveInt(base?.lookbackBars) ?? 3000;
  return {
    ...(base ?? {}),
    inputCsv: args.inputCsv ?? normalizeString(base?.inputCsv, ""),
    symbol: args.symbol,
    lookbackBars: args.lookbackBars ?? baseLookback,
  };
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override as T) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
      continue;
    }
    out[key] = value;
  }
  return out as T;
}

async function execNodeQuiet(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let stderr = "";
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => {
      // Keep neighborhood output compact; only print per-trial summaries from this script.
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0 || code === 2) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`Command failed with exit code ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`)
      );
    });
  });
}

function buildResult(input: {
  trial: number;
  variants: TrendVariant[];
  totalMutationScore: number;
  verdict: Record<string, unknown>;
  runs: Record<string, unknown>;
  outputs: NeighborhoodResult["outputs"];
}): NeighborhoodResult {
  const aggregateMetrics = isPlainObject(input.verdict.aggregateMetrics)
    ? input.verdict.aggregateMetrics
    : null;
  const thresholds = isPlainObject(input.verdict.thresholds)
    ? input.verdict.thresholds
    : null;
  return {
    trial: input.trial,
    result: typeof input.verdict.result === "string" ? input.verdict.result : null,
    reasonCodes: Array.isArray(input.verdict.reasonCodes)
      ? input.verdict.reasonCodes.filter((item): item is string => typeof item === "string")
      : [],
    baseAggregateMetrics: extractBaseAggregateMetrics(input.runs),
    aggregateMetrics,
    hardGap: buildHardGap(aggregateMetrics, thresholds),
    wfoFailureDensity: computeWfoFailureDensity(input.runs),
    meanSharpe: computeMeanSharpe(input.runs),
    mutationSummary: {
      mutatedSlots: input.variants.filter((item) => item.changed).length,
      totalMutationScore: input.totalMutationScore,
      params: input.variants.map((item) => ({
        seedIndex: item.seedIndex,
        strategyId: normalizeString(item.candidate.strategyId, `SEED_${item.seedIndex}`),
        strategyName: normalizeString(item.candidate.strategyName, `seed_${item.seedIndex}`),
        fast: item.fast,
        slow: item.slow,
        confirmBars: item.confirmBars,
        minDiffPct: item.minDiffPct,
        allowShort: item.allowShort,
        changed: item.changed,
        mutationScore: item.mutationScore,
      })),
    },
    outputs: input.outputs,
  };
}

function extractBaseAggregateMetrics(runs: Record<string, unknown>) {
  return isPlainObject(runs.aggregateMetrics) ? runs.aggregateMetrics : null;
}

function buildHardGap(
  aggregateMetrics: Record<string, unknown> | null,
  thresholds: Record<string, unknown> | null
) {
  if (!aggregateMetrics || !thresholds) {
    return null;
  }
  const meanPbo = toFiniteNumber(aggregateMetrics.meanPbo);
  const meanDsr = toFiniteNumber(aggregateMetrics.meanDsrProbability);
  const fdrQ = toFiniteNumber(aggregateMetrics.fdrQ);
  const pboMax = toFiniteNumber(thresholds.meanPboMax);
  const dsrMin = toFiniteNumber(thresholds.meanDsrProbabilityMin);
  const fdrMax = toFiniteNumber(thresholds.fdrQMax);
  if (
    meanPbo === null ||
    meanDsr === null ||
    fdrQ === null ||
    pboMax === null ||
    dsrMin === null ||
    fdrMax === null
  ) {
    return null;
  }
  const pboGap = Math.max(meanPbo - pboMax, 0);
  const dsrGap = Math.max(dsrMin - meanDsr, 0);
  const fdrGap = Math.max(fdrQ - fdrMax, 0);
  return {
    pboGap: round6(pboGap),
    dsrGap: round6(dsrGap),
    fdrGap: round6(fdrGap),
    totalGap: round6(pboGap + dsrGap + fdrGap),
  };
}

function computeWfoFailureDensity(runs: Record<string, unknown>): number | null {
  const symbols = Array.isArray(runs.symbols) ? runs.symbols : [];
  const values: number[] = [];
  for (const symbol of symbols) {
    if (!isPlainObject(symbol) || !Array.isArray(symbol.candidates)) {
      continue;
    }
    for (const candidate of symbol.candidates) {
      if (!isPlainObject(candidate) || !isPlainObject(candidate.releaseGate)) {
        continue;
      }
      const checks = Array.isArray(candidate.releaseGate.checks)
        ? candidate.releaseGate.checks
        : [];
      const wfo = checks.find(
        (check) => isPlainObject(check) && check.name === "wfo"
      ) as Record<string, unknown> | undefined;
      const metrics = isPlainObject(wfo?.metrics) ? wfo.metrics : null;
      const failedWindowRatio = metrics ? toFiniteNumber(metrics.failedWindowRatio) : null;
      if (failedWindowRatio !== null) {
        values.push(failedWindowRatio);
      }
    }
  }
  return values.length > 0 ? round6(mean(values)) : null;
}

function computeMeanSharpe(runs: Record<string, unknown>): number | null {
  const symbols = Array.isArray(runs.symbols) ? runs.symbols : [];
  const values: number[] = [];
  for (const symbol of symbols) {
    if (!isPlainObject(symbol) || !Array.isArray(symbol.candidates)) {
      continue;
    }
    for (const candidate of symbol.candidates) {
      if (!isPlainObject(candidate) || !isPlainObject(candidate.backtestMetrics)) {
        continue;
      }
      const sharpe = toFiniteNumber(candidate.backtestMetrics.sharpe);
      if (sharpe !== null) {
        values.push(sharpe);
      }
    }
  }
  return values.length > 0 ? round6(mean(values)) : null;
}

function rankResults(results: NeighborhoodResult[]): NeighborhoodResult[] {
  return [...results].sort((left, right) => {
    const leftGap = left.hardGap?.totalGap ?? Number.POSITIVE_INFINITY;
    const rightGap = right.hardGap?.totalGap ?? Number.POSITIVE_INFINITY;
    if (leftGap !== rightGap) {
      return leftGap - rightGap;
    }
    const leftWfo = left.wfoFailureDensity ?? Number.POSITIVE_INFINITY;
    const rightWfo = right.wfoFailureDensity ?? Number.POSITIVE_INFINITY;
    if (leftWfo !== rightWfo) {
      return leftWfo - rightWfo;
    }
    const leftFdr = left.hardGap?.fdrGap ?? Number.POSITIVE_INFINITY;
    const rightFdr = right.hardGap?.fdrGap ?? Number.POSITIVE_INFINITY;
    if (leftFdr !== rightFdr) {
      return leftFdr - rightFdr;
    }
    if (left.mutationSummary.totalMutationScore !== right.mutationSummary.totalMutationScore) {
      return left.mutationSummary.totalMutationScore - right.mutationSummary.totalMutationScore;
    }
    return (right.meanSharpe ?? Number.NEGATIVE_INFINITY) - (left.meanSharpe ?? Number.NEGATIVE_INFINITY);
  });
}

function renderMarkdown(payload: {
  sweepId: string;
  generatedAt: string;
  symbol: string;
  protocolProfile: string;
  fdrMethod?: string;
  wfoProfile?: string;
  recommendedTrial: number | null;
  rankedTrials: NeighborhoodResult[];
  searchConfig: Record<string, unknown>;
}) {
  const lines = [
    `# Trend Neighborhood Sweep ${payload.sweepId}`,
    "",
    `- generatedAt: ${payload.generatedAt}`,
    `- symbol: ${payload.symbol}`,
    `- protocolProfile: ${payload.protocolProfile}`,
    `- fdrMethod: ${payload.fdrMethod ?? "bh"}`,
    `- wfoProfile: ${payload.wfoProfile ?? "stable"}`,
    `- recommendedTrial: ${payload.recommendedTrial ?? "none"}`,
    `- searchConfig: ${JSON.stringify(payload.searchConfig)}`,
    "",
    "| trial | mutatedSlots | mutationScore | result | totalGap | fdrGap | wfoFailureDensity | meanSharpe |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of payload.rankedTrials) {
    lines.push(
      `| ${item.trial} | ${item.mutationSummary.mutatedSlots} | ${item.mutationSummary.totalMutationScore} | ${item.result ?? "unknown"} | ${item.hardGap?.totalGap ?? "n/a"} | ${item.hardGap?.fdrGap ?? "n/a"} | ${item.wfoFailureDensity ?? "n/a"} | ${item.meanSharpe ?? "n/a"} |`
    );
    lines.push(
      `| params | ${item.mutationSummary.params
        .map((param) => `${param.fast}/${param.slow}/c${param.confirmBars}/d${Math.round(param.minDiffPct * 10000)}/${param.allowShort ? "ls" : "lo"}${param.changed ? "*" : ""}`)
        .join(", ")} | reasons | ${item.reasonCodes.join(", ") || "none"} | metrics | ${JSON.stringify(item.aggregateMetrics ?? {})} | | | |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseIntList(value: string | undefined, fallback: number[]) {
  if (!value) {
    return fallback;
  }
  const parsed = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item));
  return parsed.length > 0 ? parsed : fallback;
}

function parseNumberList(value: string | undefined, fallback: number[]) {
  if (!value) {
    return fallback;
  }
  const parsed = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
  return parsed.length > 0 ? parsed : fallback;
}

function parseAllowShortMode(value: string | undefined): AllowShortMode {
  if (
    value === "inherit" ||
    value === "long_only" ||
    value === "long_short" ||
    value === "both"
  ) {
    return value;
  }
  return "inherit";
}

function sanitizeTag(value: string): string {
  return safePathComponent(value.replace(/[^a-zA-Z0-9._-]+/g, "_"), {
    kind: "runtime tag",
    maxLength: 128,
  });
}

function normalizeStrategy(value: unknown): string {
  return normalizeString(value, "trend");
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeSymbolKey(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function toPositiveInt(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function toFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
