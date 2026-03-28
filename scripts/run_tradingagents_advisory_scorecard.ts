import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type { MarketData } from "../src/extension/analysis-kit/data/interfaces.js";
import type { ResearchDecisionDisagreementArtifact } from "../src/extension/strategy-research-tradingagents/disagreement.js";
import type { ShadowAlphaFailureSummary } from "../src/runtime/shadow_alpha_precheck.js";
import type { PersistedPaperExecutorJournal } from "../src/runtime/paper_executor_journal.js";
import type { RuntimeFaithfulSimulationArtifact } from "../src/runtime/runtime_faithful_simulation.js";
import {
  buildTradingAgentsAdvisoryScorecard,
  buildTradingAgentsVerdict,
  type TradingAgentsAdvisoryScorecardArtifact,
} from "../src/runtime/tradingagents_advisory_scorecard.js";
import {
  validateResearchDecisionV1,
  type ResearchDecisionV1,
} from "../src/runtime/research_execution_contracts.js";

interface CliArgs {
  baselineDecisionsPath: string;
  donorDecisionsPath: string;
  barsBySymbolJson?: string;
  barsBySymbolPath?: string;
  donorFailuresPath?: string;
  disagreementsPath?: string;
  paperExecutorJournalPath?: string;
  runtimeSimulationPath?: string;
  output: string;
  verdictOutput: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const barsMapping = await loadBarsMapping(args);
  const barsBySymbol: Record<string, MarketData[]> = {};
  for (const [symbol, rawPath] of Object.entries(barsMapping)) {
    barsBySymbol[symbol] = await loadCsvBars(resolve(rawPath));
  }

  const baselineDecisions = await loadResearchDecisions(
    resolve(args.baselineDecisionsPath),
    { strict: true },
  );
  const donorDecisions = await loadResearchDecisions(resolve(args.donorDecisionsPath), {
    strict: false,
  });
  const donorFailures = args.donorFailuresPath
    ? await loadFailureSummary(resolve(args.donorFailuresPath))
    : undefined;
  const disagreements = args.disagreementsPath
    ? await loadDisagreements(resolve(args.disagreementsPath))
    : [];
  const paperExecutorJournal = args.paperExecutorJournalPath
    ? await readOptionalJson<PersistedPaperExecutorJournal>(
        resolve(args.paperExecutorJournalPath),
      )
    : null;
  const runtimeSimulation = args.runtimeSimulationPath
    ? await readOptionalJson<RuntimeFaithfulSimulationArtifact>(
        resolve(args.runtimeSimulationPath),
      )
    : null;

  const scorecard = buildTradingAgentsAdvisoryScorecard({
    baselineDecisions: baselineDecisions.decisions,
    donorDecisions: donorDecisions.decisions,
    priceBarsBySymbol: barsBySymbol,
    donorFailures: {
      totalAttempts:
        donorFailures?.totalAttempts ??
        donorDecisions.decisions.length +
          donorDecisions.invalidCount +
          (donorFailures?.fallbackCount ?? 0),
      fallbackCount: donorFailures?.fallbackCount ?? 0,
      invalidCount:
        (donorFailures?.invalidCount ?? 0) + donorDecisions.invalidCount,
    },
    disagreements,
    paperExecutorJournal,
    runtimeSimulation,
  });
  const verdict = buildTradingAgentsVerdict(scorecard);

  await writeJson(resolve(args.output), scorecard);
  await writeJson(resolve(args.verdictOutput), verdict);

  console.log(
    JSON.stringify(
      {
        scorecard: resolve(args.output),
        verdict: resolve(args.verdictOutput),
        effectivePaperDays: scorecard.counts.effectivePaperDays,
        donorAttemptCount: scorecard.counts.donorAttemptCount,
        donorOverlapHitRate: scorecard.metrics.donorOverlapHitRate,
        directionalHitRateDelta: scorecard.metrics.directionalHitRateDelta,
        verdictState: verdict.state,
        automaticRunsBlocked: verdict.automaticRunsBlocked,
        paperInfluenceAllowed: verdict.paperInfluenceAllowed,
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const baselineDecisionsPath = raw.get("baselineDecisionsPath");
  const donorDecisionsPath = raw.get("donorDecisionsPath");
  if (!baselineDecisionsPath || !donorDecisionsPath) {
    throw new Error(
      "Missing required args: --baselineDecisionsPath and --donorDecisionsPath",
    );
  }
  return {
    baselineDecisionsPath,
    donorDecisionsPath,
    barsBySymbolJson: raw.get("barsBySymbolJson"),
    barsBySymbolPath: raw.get("barsBySymbolPath"),
    donorFailuresPath: raw.get("donorFailuresPath"),
    disagreementsPath: raw.get("disagreementsPath"),
    paperExecutorJournalPath: raw.get("paperExecutorJournalPath"),
    runtimeSimulationPath: raw.get("runtimeSimulationPath"),
    output:
      raw.get("output") ??
      "data/research/scorecards/tradingagents_advisory_scorecard.latest.json",
    verdictOutput:
      raw.get("verdictOutput") ??
      "data/research/scorecards/tradingagents_verdict.latest.json",
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = argv[idx];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[idx + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    idx += 1;
  }
  return out;
}

async function loadBarsMapping(args: CliArgs): Promise<Record<string, string>> {
  if (args.barsBySymbolJson) {
    return parseJson<Record<string, string>>(args.barsBySymbolJson, "barsBySymbolJson");
  }
  if (args.barsBySymbolPath) {
    const raw = await readFile(resolve(args.barsBySymbolPath), "utf-8");
    return parseJson<Record<string, string>>(raw, "barsBySymbolPath");
  }
  throw new Error("Missing bars mapping: provide --barsBySymbolJson or --barsBySymbolPath");
}

async function loadResearchDecisions(
  path: string,
  options: { strict: boolean },
): Promise<{ decisions: ResearchDecisionV1[]; invalidCount: number }> {
  const values = await loadJsonValues(path);
  const decisions: ResearchDecisionV1[] = [];
  let invalidCount = 0;

  for (const value of values) {
    const validation = validateResearchDecisionV1(value);
    if (!validation.valid || !validation.value) {
      if (options.strict) {
        throw new Error(
          `Invalid research decision in ${path}: ${validation.blockingReasons.join("; ")}`,
        );
      }
      invalidCount += 1;
      continue;
    }
    decisions.push(validation.value);
  }

  return {
    decisions,
    invalidCount,
  };
}

async function loadFailureSummary(
  path: string,
): Promise<ShadowAlphaFailureSummary> {
  const stats = await stat(path);
  if (!stats.isDirectory()) {
    const raw = await readFile(path, "utf-8");
    return parseJson<ShadowAlphaFailureSummary>(raw, "donorFailuresPath");
  }

  const files = (await readdir(path))
    .filter((name) => name.endsWith(".json"))
    .sort();
  let fallbackCount = 0;
  let invalidCount = 0;
  for (const fileName of files) {
    const raw = await readFile(resolve(path, fileName), "utf-8");
    const parsed = parseJson<{ failureCode?: string }>(raw, fileName);
    fallbackCount += 1;
    if (
      parsed.failureCode === "invalid_request_schema" ||
      parsed.failureCode === "invalid_output_schema" ||
      parsed.failureCode === "missing_required_field" ||
      parsed.failureCode === "input_hash_mismatch" ||
      parsed.failureCode === "stale_context"
    ) {
      invalidCount += 1;
    }
  }
  return {
    totalAttempts: fallbackCount,
    fallbackCount,
    invalidCount,
  };
}

async function loadDisagreements(
  path: string,
): Promise<ResearchDecisionDisagreementArtifact[]> {
  const values = await loadJsonValues(path);
  return values.filter(
    (value): value is ResearchDecisionDisagreementArtifact =>
      typeof value === "object" &&
      value !== null &&
      (value as { schemaVersion?: unknown }).schemaVersion ===
        "research_disagreement.v1",
  );
}

async function loadJsonValues(path: string): Promise<unknown[]> {
  const stats = await stat(path);
  if (stats.isDirectory()) {
    const files = (await readdir(path))
      .filter((name) => extname(name) === ".json")
      .sort();
    const values: unknown[] = [];
    for (const fileName of files) {
      const raw = await readFile(resolve(path, fileName), "utf-8");
      values.push(...parseJsonPayload(raw, fileName));
    }
    return values;
  }

  const raw = await readFile(path, "utf-8");
  return parseJsonPayload(raw, path);
}

function parseJsonPayload(raw: string, label: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    return parseJson<unknown[]>(trimmed, label);
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJson<unknown>(line, label));
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${String(error)}`);
  }
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return parseJson<T>(raw, path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function writeJson(
  path: string,
  payload: TradingAgentsAdvisoryScorecardArtifact | ReturnType<typeof buildTradingAgentsVerdict>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function loadCsvBars(path: string): Promise<MarketData[]> {
  const raw = await readFile(path, "utf-8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error(`CSV has no rows: ${path}`);
  }
  const header = lines[0].split(",");
  const idx = {
    timestamp: header.indexOf("timestamp"),
    open: header.indexOf("open"),
    high: header.indexOf("high"),
    low: header.indexOf("low"),
    close: header.indexOf("close"),
    volume: header.indexOf("volume"),
    symbol: header.indexOf("symbol"),
  };
  for (const [name, value] of Object.entries(idx)) {
    if (value < 0 && name !== "symbol") {
      throw new Error(`CSV missing required column "${name}": ${path}`);
    }
  }

  const rows: MarketData[] = [];
  for (const row of lines.slice(1)) {
    const cols = row.split(",");
    const tsMs = Number(cols[idx.timestamp]);
    const open = Number(cols[idx.open]);
    const high = Number(cols[idx.high]);
    const low = Number(cols[idx.low]);
    const close = Number(cols[idx.close]);
    const volume = Number(cols[idx.volume]);
    if (
      !Number.isFinite(tsMs) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume)
    ) {
      continue;
    }
    rows.push({
      symbol:
        idx.symbol >= 0 && typeof cols[idx.symbol] === "string" && cols[idx.symbol]
          ? cols[idx.symbol]
          : "UNKNOWN",
      time: Math.floor(tsMs / 1000),
      open,
      high,
      low,
      close,
      volume,
    });
  }
  return rows;
}

main().catch((error) => {
  console.error("run_tradingagents_advisory_scorecard failed:", error);
  process.exitCode = 1;
});
