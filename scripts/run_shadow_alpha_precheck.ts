import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MarketData } from "../src/extension/analysis-kit/data/interfaces.js";
import {
  validateResearchDecisionV1,
  type ResearchDecisionV1,
} from "../src/runtime/research_execution_contracts.js";
import {
  runShadowAlphaPrecheck,
  type ShadowAlphaFailureSummary,
} from "../src/runtime/shadow_alpha_precheck.js";

interface CliArgs {
  baselineDecisionsPath: string;
  donorDecisionsPath: string;
  barsBySymbolJson?: string;
  barsBySymbolPath?: string;
  donorFailureSummaryPath?: string;
  output: string;
  lookaheadBars?: number;
  neutralReturnBps?: number;
  windowDays?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const barsMapping = await loadBarsMapping(args);
  const barsBySymbol: Record<string, MarketData[]> = {};
  for (const [symbol, rawPath] of Object.entries(barsMapping)) {
    barsBySymbol[symbol] = await loadCsvBars(resolve(rawPath));
  }

  const baselineLoad = await loadDecisionFile(resolve(args.baselineDecisionsPath), {
    strict: true,
  });
  const donorLoad = await loadDecisionFile(resolve(args.donorDecisionsPath), {
    strict: false,
  });
  const donorFailureSummary = await loadFailureSummary(
    args.donorFailureSummaryPath ? resolve(args.donorFailureSummaryPath) : undefined,
  );

  const artifact = runShadowAlphaPrecheck({
    baselineDecisions: baselineLoad.decisions,
    donorDecisions: donorLoad.decisions,
    priceBarsBySymbol: barsBySymbol,
    donorFailures: {
      totalAttempts:
        donorFailureSummary?.totalAttempts ??
        donorLoad.decisions.length +
          donorLoad.invalidCount +
          (donorFailureSummary?.fallbackCount ?? 0),
      fallbackCount: donorFailureSummary?.fallbackCount ?? 0,
      invalidCount:
        (donorFailureSummary?.invalidCount ?? 0) + donorLoad.invalidCount,
    },
    config: {
      lookaheadBars: args.lookaheadBars,
      neutralReturnBps: args.neutralReturnBps,
      windowDays: args.windowDays,
    },
  });

  const outputPath = resolve(args.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");

  console.log(
    JSON.stringify(
      {
        output: outputPath,
        baselineDecisionCount: artifact.counts.baselineDecisionCount,
        donorDecisionCount: artifact.counts.donorDecisionCount,
        overlapCount: artifact.counts.overlapCount,
        donorOverlapHitRate: artifact.metrics.donorOverlapHitRate,
        baselineOverlapHitRate: artifact.metrics.baselineOverlapHitRate,
        donorCoverageRatio: artifact.metrics.donorCoverageRatio,
        fallbackInvalidRatio: artifact.metrics.fallbackInvalidRatio,
        explainabilityCompleteness: artifact.metrics.explainabilityCompleteness,
        promotionEligible: artifact.promotionCheck.eligible,
        shouldKill: artifact.killCriterion.shouldKill,
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
    donorFailureSummaryPath: raw.get("donorFailureSummaryPath"),
    output:
      raw.get("output") ?? "data/research/scorecards/shadow_alpha_precheck.latest.json",
    lookaheadBars: parseOptionalInt(raw.get("lookaheadBars")),
    neutralReturnBps: parseOptionalInt(raw.get("neutralReturnBps")),
    windowDays: parseOptionalInt(raw.get("windowDays")),
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

function parseOptionalInt(raw: string | undefined): number | undefined {
  if (raw == null) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected integer value, received: ${raw}`);
  }
  return parsed;
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

async function loadFailureSummary(
  path: string | undefined,
): Promise<ShadowAlphaFailureSummary | null> {
  if (!path) {
    return null;
  }
  const raw = await readFile(path, "utf-8");
  return parseJson<ShadowAlphaFailureSummary>(raw, "donorFailureSummaryPath");
}

async function loadDecisionFile(
  path: string,
  options: { strict: boolean },
): Promise<{ decisions: ResearchDecisionV1[]; invalidCount: number }> {
  const raw = await readFile(path, "utf-8");
  const candidates = parseDecisionPayload(raw);
  const decisions: ResearchDecisionV1[] = [];
  let invalidCount = 0;

  for (const candidate of candidates) {
    const validation = validateResearchDecisionV1(candidate);
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

  return { decisions, invalidCount };
}

function parseDecisionPayload(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    return parseJson<unknown[]>(trimmed, "decisionFile");
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJson<unknown>(line, "decisionNdjsonLine"));
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${String(err)}`);
  }
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

  return rows.sort((a, b) => a.time - b.time);
}

main().catch((err) => {
  console.error("run_shadow_alpha_precheck failed:", err);
  process.exit(1);
});
