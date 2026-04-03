import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type MultipleTestingUnit = "candidate" | "family";

interface TrialCandidate {
  strategyId?: string;
  strategyName?: string;
  strategy?: string;
  params?: Record<string, unknown>;
}

interface TrialRecord {
  trial?: number;
  template?: string[];
  candidates?: TrialCandidate[];
}

interface SearchPayload {
  run_id?: string;
  allTrials?: TrialRecord[];
}

interface ConfigPayload {
  config?: {
    dataset?: Record<string, unknown>;
    thresholds?: Record<string, unknown>;
    wfo?: Record<string, unknown>;
    significance?: Record<string, unknown>;
    riskSimulation?: Record<string, unknown>;
    costModel?: Record<string, unknown>;
  };
}

interface CliArgs {
  searchJson: string;
  configJson: string;
  trial: number;
  output: string;
  batchId: string;
  batchGoal: string;
  multipleTestingUnit: MultipleTestingUnit;
  sourceId?: string;
  symbolOverride?: string;
  inputCsvOverride?: string;
  lookbackBarsOverride?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [searchPayload, configPayload] = await Promise.all([
    readJson<SearchPayload>(args.searchJson),
    readJson<ConfigPayload>(args.configJson),
  ]);

  const trial = searchPayload.allTrials?.find((item) => item.trial === args.trial);
  if (!trial) {
    throw new Error(`Trial ${args.trial} not found in ${args.searchJson}`);
  }
  if (!Array.isArray(trial.candidates) || trial.candidates.length === 0) {
    throw new Error(`Trial ${args.trial} has no candidates.`);
  }

  const cfg = configPayload.config;
  if (!cfg?.dataset || !cfg.thresholds || !cfg.wfo || !cfg.significance || !cfg.riskSimulation || !cfg.costModel) {
    throw new Error(`Config file ${args.configJson} is missing required sections.`);
  }

  const symbol = args.symbolOverride ?? resolveDatasetSymbol(cfg.dataset);
  const symbolKey = normalizeSymbolKey(symbol);
  const dataset = buildDatasetConfig({
    base: cfg.dataset,
    symbol,
    inputCsvOverride: args.inputCsvOverride,
    lookbackBarsOverride: args.lookbackBarsOverride,
  });

  const manifest = {
    schemaVersion: "strategy_candidates.v1",
    generatedAt: new Date().toISOString(),
    batchId: args.batchId,
    batchGoal: args.batchGoal,
    notes: [
      `source_run_id=${searchPayload.run_id ?? "unknown"}`,
      `source_id=${args.sourceId ?? "unknown"}`,
      `source_trial=${args.trial}`,
      `source_template=${(trial.template ?? []).join("+") || "unknown"}`,
      `multiple_testing_unit=${args.multipleTestingUnit}`,
    ],
    dataset,
    thresholds: cfg.thresholds,
    wfo: cfg.wfo,
    significance: {
      ...cfg.significance,
      multipleTestingUnit: args.multipleTestingUnit,
    },
    riskSimulation: cfg.riskSimulation,
    costModel: cfg.costModel,
    candidates: trial.candidates.map((candidate, index) =>
      materializeCandidate(candidate, symbol, symbolKey, index)
    ),
  };

  await mkdir(dirname(resolve(args.output)), { recursive: true });
  await writeFile(resolve(args.output), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  console.log(
    [
      `output=${resolve(args.output)}`,
      `trial=${args.trial}`,
      `symbol=${symbol}`,
      `candidateCount=${manifest.candidates.length}`,
      `multipleTestingUnit=${args.multipleTestingUnit}`,
    ].join(" | ")
  );
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const searchJson = raw.get("search-json");
  const configJson = raw.get("config-json");
  const output = raw.get("output");
  const trial = Number(raw.get("trial"));

  if (!searchJson) throw new Error("--search-json is required.");
  if (!configJson) throw new Error("--config-json is required.");
  if (!output) throw new Error("--output is required.");
  if (!Number.isInteger(trial) || trial < 0) {
    throw new Error("--trial must be a non-negative integer.");
  }

  const batchId = raw.get("batch-id") ?? `phaseb_trial_${trial}`;
  const batchGoal =
    raw.get("batch-goal") ??
    `Materialize phase-B family-search trial ${trial} into a route-ready candidate manifest.`;
  const multipleTestingUnit =
    raw.get("multiple-testing-unit") === "family" ? "family" : "candidate";
  const symbolOverride = normalizeOptionalString(raw.get("symbol"));
  const inputCsvOverride = normalizeOptionalString(
    raw.get("input-csv") ?? raw.get("inputCsv")
  );
  const sourceId = normalizeOptionalString(raw.get("source-id") ?? raw.get("sourceId"));
  const lookbackBarsRaw = raw.get("lookback-bars") ?? raw.get("lookbackBars");
  const lookbackBarsOverride =
    lookbackBarsRaw && Number.isInteger(Number(lookbackBarsRaw))
      ? Number(lookbackBarsRaw)
      : undefined;

  return {
    searchJson,
    configJson,
    trial,
    output,
    batchId,
    batchGoal,
    multipleTestingUnit,
    sourceId,
    symbolOverride,
    inputCsvOverride,
    lookbackBarsOverride,
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

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

function resolveDatasetSymbol(dataset: Record<string, unknown>): string {
  const symbols = dataset.symbols;
  if (Array.isArray(symbols) && symbols.length > 0) {
    const first = symbols[0] as Record<string, unknown>;
    if (typeof first?.symbol === "string" && first.symbol.trim()) {
      return first.symbol.trim();
    }
  }
  if (typeof dataset.symbol === "string" && dataset.symbol.trim()) {
    return dataset.symbol.trim();
  }
  throw new Error("Unable to resolve dataset symbol from config.");
}

function buildDatasetConfig(input: {
  base: Record<string, unknown>;
  symbol: string;
  inputCsvOverride?: string;
  lookbackBarsOverride?: number;
}) {
  const lookbackBars =
    input.lookbackBarsOverride ??
    toPositiveInt(input.base.lookbackBars) ??
    resolveFirstSymbolLookback(input.base) ??
    3000;
  const inputCsv =
    input.inputCsvOverride ??
    defaultInputCsvForSymbol(input.symbol) ??
    resolveFirstSymbolInputCsv(input.base) ??
    "";

  const dataset: Record<string, unknown> = {
    ...input.base,
    symbol: input.symbol,
    inputCsv,
    lookbackBars,
  };

  if (Array.isArray(input.base.symbols) && input.base.symbols.length > 0) {
    dataset.symbols = [
      {
        inputCsv,
        symbol: input.symbol,
        lookbackBars,
      },
    ];
  }

  return dataset;
}

function materializeCandidate(
  candidate: TrialCandidate,
  symbol: string,
  symbolKey: string,
  index: number
) {
  const strategyId = normalizeString(candidate.strategyId, `PHASEB_${index + 1}`);
  const strategyName = normalizeString(candidate.strategyName, strategyId);
  const strategy = normalizeString(candidate.strategy, "trend");
  const params = (candidate.params ?? {}) as Record<string, unknown>;

  return {
    strategyId,
    strategyName,
    strategy,
    applicableSymbols: [symbol],
    hypothesisFamily: inferHypothesisFamily(strategyName, strategy, params, symbolKey),
    correlationBucket: inferCorrelationBucket(strategyName, strategy, params, symbolKey),
    params,
  };
}

function inferHypothesisFamily(
  strategyName: string,
  strategy: string,
  params: Record<string, unknown>,
  symbolKey: string
): string {
  const name = strategyName.toLowerCase();
  if (strategy === "regimeTrend") {
    return `${symbolKey}_regime_filtered_family_${safeToken(buildRegimeTrendSignature(params))}`;
  }
  if (strategy === "ensemble") {
    return `${symbolKey}_ensemble_family_${safeToken(buildEnsembleSignature(params))}`;
  }
  if (strategy === "breakout") {
    return `${symbolKey}_breakout_family_${safeToken(buildBreakoutSignature(params))}`;
  }
  if (strategy === "meanReversion") {
    return `${symbolKey}_mean_reversion_family_${safeToken(buildMeanReversionSignature(params))}`;
  }
  if (name.includes("regime")) {
    return `${symbolKey}_regime_family_${safeToken(buildTrendSignature(params))}`;
  }
  if (name.includes("cost")) {
    return `${symbolKey}_cost_family_${safeToken(buildTrendSignature(params))}`;
  }
  return `${symbolKey}_trend_family_${safeToken(buildTrendSignature(params))}`;
}

function inferCorrelationBucket(
  strategyName: string,
  strategy: string,
  params: Record<string, unknown>,
  symbolKey: string
): string {
  const name = strategyName.toLowerCase();
  if (strategy === "regimeTrend") {
    return `${symbolKey}_regime_filtered_${safeToken(buildRegimeTrendSignature(params))}`;
  }
  if (strategy === "ensemble") {
    return `${symbolKey}_ensemble_${safeToken(buildEnsembleSignature(params))}`;
  }
  if (strategy === "breakout") {
    return `${symbolKey}_breakout_${safeToken(buildBreakoutSignature(params))}`;
  }
  if (strategy === "meanReversion") {
    return `${symbolKey}_mr_${safeToken(buildMeanReversionSignature(params))}`;
  }
  if (name.includes("regime")) {
    return `${symbolKey}_regime_${safeToken(buildTrendSignature(params))}`;
  }
  if (name.includes("cost")) {
    return `${symbolKey}_cost_${safeToken(buildTrendSignature(params))}`;
  }
  return `${symbolKey}_trend_${safeToken(buildTrendSignature(params))}`;
}

function buildTrendSignature(params: Record<string, unknown>): string {
  const fast = Number(params.trendFastPeriod ?? "x");
  const slow = Number(params.trendSlowPeriod ?? "x");
  const allowShort = params.allowShort === false ? "lo" : "ls";
  return `${fast}_${slow}_${allowShort}`;
}

function buildRegimeTrendSignature(params: Record<string, unknown>): string {
  const trend = buildTrendSignature(params);
  const regimeFast = Number(params.regimeFastPeriod ?? "x");
  const regimeSlow = Number(params.regimeSlowPeriod ?? "x");
  const regimeVol = Number(params.regimeVolWindow ?? "x");
  const regimeAtr = Number(params.regimeAtrPeriod ?? "x");
  const regimes = Array.isArray(params.allowedEntryRegimes)
    ? params.allowedEntryRegimes
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map(item => item.toLowerCase())
        .join("+")
    : "default";
  const exitMode = params.exitOnRegimeMismatch === false ? "hold" : "exit";
  return `${trend}_rf${regimeFast}_rs${regimeSlow}_rv${regimeVol}_ra${regimeAtr}_${safeToken(regimes)}_${exitMode}`;
}

function buildBreakoutSignature(params: Record<string, unknown>): string {
  const period = Number(params.breakoutPeriod ?? "x");
  const exit = Number(params.breakoutExitPeriod ?? "x");
  const allowShort = params.allowShort === false ? "lo" : "ls";
  return `${period}_${exit}_${allowShort}`;
}

function buildMeanReversionSignature(params: Record<string, unknown>): string {
  const rsi = Number(params.rsiPeriod ?? "x");
  const bb = Number(params.bbPeriod ?? "x");
  const allowShort = params.allowShort === false ? "lo" : "ls";
  return `r${rsi}_bb${bb}_${allowShort}`;
}

function buildEnsembleSignature(params: Record<string, unknown>): string {
  const threshold = Number(params.ensembleThreshold ?? "x");
  const weights = (params.ensembleWeights ?? {}) as Record<string, unknown>;
  return `t${threshold}_${
    Number(weights.trend ?? "x")
  }${Number(weights.meanReversion ?? "x")}${Number(weights.breakout ?? "x")}_${
    params.allowShort === false ? "lo" : "ls"
  }`;
}

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toPositiveInt(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return undefined;
  }
  return num;
}

function resolveFirstSymbolInputCsv(dataset: Record<string, unknown>): string | undefined {
  const symbols = dataset.symbols;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return undefined;
  }
  const first = symbols[0] as Record<string, unknown>;
  return normalizeOptionalString(first.inputCsv);
}

function resolveFirstSymbolLookback(dataset: Record<string, unknown>): number | undefined {
  const symbols = dataset.symbols;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return undefined;
  }
  const first = symbols[0] as Record<string, unknown>;
  return toPositiveInt(first.lookbackBars);
}

function defaultInputCsvForSymbol(symbol: string): string | undefined {
  const normalized = symbol.trim().toUpperCase();
  const map: Record<string, string> = {
    "BTC/USD": "data/market/okx/BTC_USDT_USDT_1h.csv",
    "ETH/USD": "data/market/okx/ETH_USDT_USDT_1h.csv",
    "SOL/USD": "data/market/okx/SOL_USDT_USDT_1h.csv",
    "BNB/USD": "data/market/okx/BNB_USDT_USDT_1h.csv",
    "XRP/USD": "data/market/okx/XRP_USDT_USDT_1h.csv",
    "ADA/USD": "data/market/okx/ADA_USDT_USDT_1h.csv",
    "DOGE/USD": "data/market/okx/DOGE_USDT_USDT_1h.csv",
    "AVAX/USD": "data/market/okx/AVAX_USDT_USDT_1h.csv",
    "LINK/USD": "data/market/okx/LINK_USDT_USDT_1h.csv",
    "DOT/USD": "data/market/okx/DOT_USDT_USDT_1h.csv",
  };
  return map[normalized];
}

function normalizeSymbolKey(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function safeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

main().catch((error) => {
  console.error("materialize_phaseb_trial_manifest failed:", error);
  process.exit(1);
});
