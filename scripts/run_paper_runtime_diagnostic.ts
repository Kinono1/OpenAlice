/**
 * External scheduling example:
 * 5 * * * * cd /path/to/OpenAlice && npx tsx scripts/run_paper_runtime_diagnostic.ts >> /tmp/paper_diagnostic.log 2>&1
 *
 * Status artifact:
 * cat data/runtime/paper_diagnostic_status.latest.json | jq '.preflight, .summary.blockingReasons'
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { formatGateSummary } from "../src/runtime/gate_summary.js";
import { runPaperRuntimeDiagnostic } from "../src/runtime/paper_runtime_diagnostic.js";

interface CliArgs {
  registryPath: string;
  releaseGateStatusPath: string;
  runtimeHealthy: boolean;
  dataFresh: boolean;
  connectorHealthy: boolean;
  riskLimitsLoaded: boolean;
  paperExecutorEnabled: boolean;
  lookbackBars?: number;
  statusOutput: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPaperRuntimeDiagnostic({
    registryPath: args.registryPath,
    releaseGateStatusPath: args.releaseGateStatusPath,
    runtimeHealthy: args.runtimeHealthy,
    dataFresh: args.dataFresh,
    connectorHealthy: args.connectorHealthy,
    riskLimitsLoaded: args.riskLimitsLoaded,
    paperExecutorEnabled: args.paperExecutorEnabled,
    lookbackBars: args.lookbackBars,
  });

  const statusOutput = resolve(args.statusOutput);
  await mkdir(dirname(statusOutput), { recursive: true });
  await writeFile(
    statusOutput,
    `${JSON.stringify(result.statusArtifact, null, 2)}\n`,
    "utf-8",
  );

  console.log(formatGateSummary(result.summary));
  console.log(
    JSON.stringify(
      {
        statusOutput,
        preflight: result.statusArtifact.preflight,
        blockingReasons: result.summary.blockingReasons,
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  return {
    registryPath:
      raw.get("registryPath") ?? "data/runtime/paper_champion_registry.json",
    releaseGateStatusPath:
      raw.get("releaseGateStatusPath") ?? "data/runtime/release_gate_status.json",
    runtimeHealthy: parseBoolArg(raw.get("runtimeHealthy"), true),
    dataFresh: parseBoolArg(raw.get("dataFresh"), true),
    connectorHealthy: parseBoolArg(raw.get("connectorHealthy"), true),
    riskLimitsLoaded: parseBoolArg(raw.get("riskLimitsLoaded"), true),
    paperExecutorEnabled: parseBoolArg(raw.get("paperExecutorEnabled"), true),
    lookbackBars: raw.get("lookbackBars") ? Number(raw.get("lookbackBars")) : undefined,
    statusOutput:
      raw.get("statusOutput") ?? "data/runtime/paper_diagnostic_status.latest.json",
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
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

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

main().catch((err) => {
  console.error("run_paper_runtime_diagnostic failed:", err);
  process.exit(1);
});
