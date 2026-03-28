import { mkdir } from "fs/promises";
import { resolve } from "path";
import { spawn } from "child_process";
import { parseList, parseRawArgs, writeJsonFile } from "./okx_historical_common.js";

type Phase = "catalog" | "candles" | "index" | "trades" | "trades_import";

type CliArgs = {
  datasetRoot: string;
  fromPhase: Phase;
  toPhase: Phase;
  resume: boolean;
  maxDiskBytes: string;
  timeframes: string[];
  indexBars: string[];
  maxSymbols?: number;
  workersCandles: number;
  workersIndex: number;
  workersTrades: number;
  includeTradesImport: boolean;
  tradesImportDir: string;
};

const PHASE_ORDER: Phase[] = ["catalog", "candles", "index", "trades", "trades_import"];

function printHelp(): void {
  console.log(`Usage:
  tsx scripts/okx_download_full_dataset.ts -- [options]

Options:
  --datasetRoot data/market/okx_historical
  --fromPhase catalog
  --toPhase trades
  --resume true
  --maxDiskBytes 120GB
  --timeframes 1h,15m,5m
  --indexBars 1H,1D,1Dutc
  --maxSymbols 300
  --workersCandles 1
  --workersIndex 1
  --workersTrades 2
  --includeTradesImport false
  --tradesImportDir data/raw/okx/historical/trades
`);
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }
  const datasetRoot = raw.get("datasetRoot") ?? "data/market/okx_historical";
  const fromPhaseRaw = (raw.get("fromPhase") ?? "catalog") as Phase;
  const toPhaseRaw = (raw.get("toPhase") ?? "trades") as Phase;
  const fromPhase = PHASE_ORDER.includes(fromPhaseRaw) ? fromPhaseRaw : "catalog";
  const toPhase = PHASE_ORDER.includes(toPhaseRaw) ? toPhaseRaw : "trades";
  return {
    datasetRoot,
    fromPhase,
    toPhase,
    resume: raw.get("resume") == null ? true : raw.get("resume") !== "false",
    maxDiskBytes: raw.get("maxDiskBytes") ?? "120GB",
    timeframes: parseList(raw.get("timeframes")) ?? ["1h", "15m", "5m"],
    indexBars: parseList(raw.get("indexBars")) ?? ["1H", "1D", "1Dutc"],
    maxSymbols: raw.get("maxSymbols") ? Number(raw.get("maxSymbols")) : undefined,
    workersCandles: raw.get("workersCandles") ? Number(raw.get("workersCandles")) : 1,
    workersIndex: raw.get("workersIndex") ? Number(raw.get("workersIndex")) : 1,
    workersTrades: raw.get("workersTrades") ? Number(raw.get("workersTrades")) : 2,
    includeTradesImport:
      raw.get("includeTradesImport") == null
        ? false
        : raw.get("includeTradesImport") !== "false",
    tradesImportDir:
      raw.get("tradesImportDir") ?? "data/raw/okx/historical/trades",
  };
}

function inRange(phase: Phase, from: Phase, to: Phase): boolean {
  const p = PHASE_ORDER.indexOf(phase);
  const f = PHASE_ORDER.indexOf(from);
  const t = PHASE_ORDER.indexOf(to);
  return p >= f && p <= t;
}

async function runCommand(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    proc.on("error", rejectPromise);
    proc.on("close", code => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${cmd} ${args.join(" ")} failed with code=${code}`));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const datasetRoot = resolve(args.datasetRoot);
  await mkdir(resolve(datasetRoot, "reports"), { recursive: true });

  const executed: Array<{ phase: Phase; status: "ok" | "skipped" }> = [];

  if (inRange("catalog", args.fromPhase, args.toPhase)) {
    await runCommand("tsx", [
      "scripts/okx_build_catalog.ts",
      "--datasetRoot",
      datasetRoot,
    ]);
    executed.push({ phase: "catalog", status: "ok" });
  } else {
    executed.push({ phase: "catalog", status: "skipped" });
  }

  if (inRange("candles", args.fromPhase, args.toPhase)) {
    const cmdArgs = [
      "scripts/okx_download_candles_historical.ts",
      "--datasetRoot",
      datasetRoot,
      "--catalogPath",
      resolve(datasetRoot, "catalog", "usdt_all.v1.json"),
      "--timeframes",
      args.timeframes.join(","),
      "--maxDiskBytes",
      args.maxDiskBytes,
      "--workers",
      String(args.workersCandles),
      "--append",
      String(args.resume),
    ];
    if (args.maxSymbols && Number.isFinite(args.maxSymbols)) {
      cmdArgs.push("--maxSymbols", String(args.maxSymbols));
    }
    await runCommand("tsx", cmdArgs);
    executed.push({ phase: "candles", status: "ok" });
  } else {
    executed.push({ phase: "candles", status: "skipped" });
  }

  if (inRange("index", args.fromPhase, args.toPhase)) {
    const cmdArgs = [
      "scripts/okx_download_index_candles.ts",
      "--datasetRoot",
      datasetRoot,
      "--catalogPath",
      resolve(datasetRoot, "catalog", "index_candidates.v1.json"),
      "--bars",
      args.indexBars.join(","),
      "--maxDiskBytes",
      args.maxDiskBytes,
      "--workers",
      String(args.workersIndex),
      "--append",
      String(args.resume),
    ];
    if (args.maxSymbols && Number.isFinite(args.maxSymbols)) {
      cmdArgs.push("--maxSymbols", String(args.maxSymbols));
    }
    await runCommand("tsx", cmdArgs);
    executed.push({ phase: "index", status: "ok" });
  } else {
    executed.push({ phase: "index", status: "skipped" });
  }

  if (inRange("trades", args.fromPhase, args.toPhase)) {
    const cmdArgs = [
      "scripts/okx_download_trades.ts",
      "--datasetRoot",
      datasetRoot,
      "--catalogPath",
      resolve(datasetRoot, "catalog", "usdt_all.v1.json"),
      "--maxDiskBytes",
      args.maxDiskBytes,
      "--workers",
      String(args.workersTrades),
      "--append",
      String(args.resume),
    ];
    if (args.maxSymbols && Number.isFinite(args.maxSymbols)) {
      cmdArgs.push("--maxSymbols", String(args.maxSymbols));
    }
    await runCommand("tsx", cmdArgs);
    executed.push({ phase: "trades", status: "ok" });
  } else {
    executed.push({ phase: "trades", status: "skipped" });
  }

  if (inRange("trades_import", args.fromPhase, args.toPhase)) {
    if (args.includeTradesImport) {
      await runCommand("tsx", [
        "scripts/okx_import_historical_trades.ts",
        "--datasetRoot",
        datasetRoot,
        "--inputDir",
        resolve(args.tradesImportDir),
        "--append",
        String(args.resume),
      ]);
      executed.push({ phase: "trades_import", status: "ok" });
    } else {
      executed.push({ phase: "trades_import", status: "skipped" });
    }
  } else {
    executed.push({ phase: "trades_import", status: "skipped" });
  }

  await writeJsonFile(resolve(datasetRoot, "reports", "full_run_summary.v1.json"), {
    schemaVersion: "okx_full_run_summary.v1",
    startedAt,
    endedAt: new Date().toISOString(),
    params: {
      datasetRoot,
      fromPhase: args.fromPhase,
      toPhase: args.toPhase,
      resume: args.resume,
      maxDiskBytes: args.maxDiskBytes,
      timeframes: args.timeframes,
      indexBars: args.indexBars,
      maxSymbols: args.maxSymbols ?? null,
      workersCandles: args.workersCandles,
      workersIndex: args.workersIndex,
      workersTrades: args.workersTrades,
      includeTradesImport: args.includeTradesImport,
      tradesImportDir: resolve(args.tradesImportDir),
    },
    executed,
  });

  console.log(`full dataset flow complete: datasetRoot=${datasetRoot}`);
}

main().catch(err => {
  console.error("okx_download_full_dataset failed:", err);
  process.exit(1);
});
