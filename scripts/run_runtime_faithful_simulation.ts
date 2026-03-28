import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildGateSummary, formatGateSummary } from "../src/runtime/gate_summary.js";
import type { LiveMarketDataBar } from "../src/runtime/live_gate_manager.js";
import {
  loadPaperChampionRegistry,
} from "../src/runtime/paper_champion_registry.js";
import { loadReleaseGateStatus } from "../src/runtime/release_gate_status.js";
import { writePaperGateStatus } from "../src/runtime/paper_gate_status.js";
import { runRuntimeFaithfulSimulation } from "../src/runtime/runtime_faithful_simulation.js";

interface CliArgs {
  registryPath: string;
  releaseGateStatusPath: string;
  inputCsvBySymbolJson: string;
  output: string;
  paperGateStatusPath: string;
  runtimeHealthy: boolean;
  dataFresh: boolean;
  connectorHealthy: boolean;
  riskLimitsLoaded: boolean;
  paperExecutorEnabled: boolean;
  signalCodeCommitHash?: string;
  runtimeSchemaVersion?: string;
  vetoPolicyVersion?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = await loadPaperChampionRegistry(resolve(args.registryPath));
  const releaseGateStatus = await loadReleaseGateStatus(
    resolve(args.releaseGateStatusPath),
  );
  const inputCsvBySymbol = parseJsonArg<Record<string, string>>(
    args.inputCsvBySymbolJson,
    "inputCsvBySymbolJson",
  );

  const barsBySymbol: Record<string, LiveMarketDataBar[]> = {};
  for (const [symbol, rawPath] of Object.entries(inputCsvBySymbol)) {
    barsBySymbol[symbol] = await loadCsvBars(resolve(rawPath));
  }

  const artifact = runRuntimeFaithfulSimulation({
    registry,
    releaseGateStatus,
    barsBySymbol,
    runtimeFlags: {
      runtimeHealthy: args.runtimeHealthy,
      dataFresh: args.dataFresh,
      connectorHealthy: args.connectorHealthy,
      riskLimitsLoaded: args.riskLimitsLoaded,
      paperExecutorEnabled: args.paperExecutorEnabled,
    },
    expectations: {
      symbols: registry?.symbols,
      signalCodeCommitHash: args.signalCodeCommitHash,
      runtimeSchemaVersion: args.runtimeSchemaVersion,
      vetoPolicyVersion: args.vetoPolicyVersion,
    },
  });

  const outputPath = resolve(args.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  await writePaperGateStatus(artifact.paperGate, {
    filePath: resolve(args.paperGateStatusPath),
  });

  console.log(formatGateSummary(buildGateSummary(artifact)));
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        paperGateStatusPath: resolve(args.paperGateStatusPath),
        commitCount: artifact.summary.commitCount,
        operationCount: artifact.summary.operationCount,
        finalAllowPaperTrading: artifact.paperGate.finalAllowPaperTrading,
        blocked: artifact.blockingReasons,
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
    inputCsvBySymbolJson: raw.get("inputCsvBySymbolJson") ?? "{}",
    output:
      raw.get("output") ?? "data/runtime/runtime_faithful_simulation.latest.json",
    paperGateStatusPath:
      raw.get("paperGateStatusPath") ?? "data/runtime/paper_gate_status.json",
    runtimeHealthy: parseBoolArg(raw.get("runtimeHealthy"), true),
    dataFresh: parseBoolArg(raw.get("dataFresh"), true),
    connectorHealthy: parseBoolArg(raw.get("connectorHealthy"), true),
    riskLimitsLoaded: parseBoolArg(raw.get("riskLimitsLoaded"), true),
    paperExecutorEnabled: parseBoolArg(raw.get("paperExecutorEnabled"), true),
    signalCodeCommitHash: raw.get("signalCodeCommitHash") ?? undefined,
    runtimeSchemaVersion: raw.get("runtimeSchemaVersion") ?? undefined,
    vetoPolicyVersion: raw.get("vetoPolicyVersion") ?? undefined,
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

function parseJsonArg<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${String(err)}`);
  }
}

async function loadCsvBars(path: string): Promise<LiveMarketDataBar[]> {
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

  let inferredBarIntervalMs = 60 * 60 * 1000;
  const parsedRows: LiveMarketDataBar[] = [];
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
    parsedRows.push({
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
      tsOpenMs: tsMs,
      completed: true,
      sourceDomain: "csv_replay",
    });
  }
  parsedRows.sort((a, b) => (a.tsOpenMs ?? 0) - (b.tsOpenMs ?? 0));
  if (parsedRows.length >= 2) {
    inferredBarIntervalMs =
      (parsedRows[1].tsOpenMs ?? 0) - (parsedRows[0].tsOpenMs ?? 0) ||
      inferredBarIntervalMs;
  }
  return parsedRows.map((bar) => ({
    ...bar,
    barIntervalMs: inferredBarIntervalMs,
    barCloseMs: (bar.tsOpenMs ?? 0) + inferredBarIntervalMs,
  }));
}

main().catch((err) => {
  console.error("run_runtime_faithful_simulation failed:", err);
  process.exit(1);
});
