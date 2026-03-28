import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  validateResearchDecisionV1,
  type ResearchDecisionV1,
} from "../src/runtime/research_execution_contracts.js";
import {
  buildTradingAgentsExecutionInfluence,
  type TradingAgentsCurrentPositionState,
  type TradingAgentsHumanApprovalSnapshot,
  type TradingAgentsPaperGateSnapshot,
} from "../src/runtime/tradingagents_execution_influence.js";
import { loadTradingAgentsVerdict } from "../src/runtime/tradingagents_advisory_scorecard.js";
import type { PortfolioTargetArtifact } from "../src/portfolio/index.js";

interface CliArgs {
  baselineDecisionPath: string;
  donorDecisionPath?: string;
  verdictPath?: string;
  portfolioTargetPath?: string;
  currentPositionJson: string;
  paperGateJson: string;
  humanApprovalJson?: string;
  accountEquityUsd?: number;
  expectedPrice?: number;
  signalBarCloseTs: number;
  submitDecisionTs: number;
  submitDeadlineMs?: number;
  orderStaleMs?: number;
  output: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baselineDecision = await loadResearchDecision(
    resolve(args.baselineDecisionPath),
    "baselineDecisionPath",
  );
  const donorDecision = args.donorDecisionPath
    ? await loadResearchDecision(resolve(args.donorDecisionPath), "donorDecisionPath")
    : null;
  const verdict = args.verdictPath
    ? await loadTradingAgentsVerdict(resolve(args.verdictPath))
    : null;
  const portfolioTarget = args.portfolioTargetPath
    ? await loadPortfolioTarget(resolve(args.portfolioTargetPath))
    : null;
  const currentPosition = parseJson<TradingAgentsCurrentPositionState>(
    args.currentPositionJson,
    "currentPositionJson",
  );
  const paperGate = parseJson<TradingAgentsPaperGateSnapshot>(
    args.paperGateJson,
    "paperGateJson",
  );
  const humanApproval = args.humanApprovalJson
    ? parseJson<TradingAgentsHumanApprovalSnapshot>(
        args.humanApprovalJson,
        "humanApprovalJson",
      )
    : null;

  const artifact = buildTradingAgentsExecutionInfluence({
    baselineDecision,
    donorDecision,
    verdict,
    currentPosition,
    portfolioTarget,
    paperGate,
    humanApproval,
    accountEquityUsd: args.accountEquityUsd,
    expectedPrice: args.expectedPrice,
    signalBarCloseTs: args.signalBarCloseTs,
    submitDecisionTs: args.submitDecisionTs,
    submitDeadlineMs: args.submitDeadlineMs,
    orderStaleMs: args.orderStaleMs,
  });

  const outputPath = resolve(args.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        verdictState: artifact.verdictState,
        outcome: artifact.outcome,
        influenceAction: artifact.influenceAction,
        hasExecutionIntent: artifact.executionIntent !== null,
        reasonCodes: artifact.reasonCodes,
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const baselineDecisionPath = raw.get("baselineDecisionPath");
  const currentPositionJson = raw.get("currentPositionJson");
  const paperGateJson = raw.get("paperGateJson");
  const signalBarCloseTs = parseRequiredInt(raw.get("signalBarCloseTs"), "signalBarCloseTs");
  const submitDecisionTs = parseRequiredInt(raw.get("submitDecisionTs"), "submitDecisionTs");
  if (!baselineDecisionPath || !currentPositionJson || !paperGateJson) {
    throw new Error(
      "Missing required args: --baselineDecisionPath --currentPositionJson --paperGateJson",
    );
  }
  return {
    baselineDecisionPath,
    donorDecisionPath: raw.get("donorDecisionPath"),
    verdictPath: raw.get("verdictPath"),
    portfolioTargetPath: raw.get("portfolioTargetPath"),
    currentPositionJson,
    paperGateJson,
    humanApprovalJson: raw.get("humanApprovalJson"),
    accountEquityUsd: parseOptionalNumber(raw.get("accountEquityUsd")),
    expectedPrice: parseOptionalNumber(raw.get("expectedPrice")),
    signalBarCloseTs,
    submitDecisionTs,
    submitDeadlineMs: parseOptionalNumber(raw.get("submitDeadlineMs")),
    orderStaleMs: parseOptionalNumber(raw.get("orderStaleMs")),
    output:
      raw.get("output") ??
      "data/research/scorecards/tradingagents_execution_influence.latest.json",
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

async function loadResearchDecision(
  path: string,
  label: string,
): Promise<ResearchDecisionV1> {
  const raw = await readFile(path, "utf-8");
  const parsed = parseJson<unknown>(raw, label);
  const validation = validateResearchDecisionV1(parsed);
  if (!validation.valid || !validation.value) {
    throw new Error(
      `Invalid research decision in ${label}: ${validation.blockingReasons.join("; ")}`,
    );
  }
  return validation.value;
}

async function loadPortfolioTarget(
  path: string,
): Promise<PortfolioTargetArtifact> {
  const raw = await readFile(path, "utf-8");
  const parsed = parseJson<unknown>(raw, "portfolioTargetPath");
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== "portfolio_target.v1"
  ) {
    throw new Error("Invalid portfolio target payload");
  }
  return parsed as PortfolioTargetArtifact;
}

function parseRequiredInt(raw: string | undefined, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw == null) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected finite number, received: ${raw}`);
  }
  return value;
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${String(error)}`);
  }
}

main().catch((error) => {
  console.error("run_tradingagents_execution_influence failed:", error);
  process.exitCode = 1;
});
