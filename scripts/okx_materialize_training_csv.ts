import { createReadStream } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { resolve } from "path";
import { createInterface } from "readline";
import { spawn } from "child_process";
import {
  listFilesRecursive,
  parseList,
  parseRawArgs,
  writeJsonFile,
} from "./okx_historical_common.js";

type CliArgs = {
  datasetRoot: string;
  outputDir: string;
  timeframe: string;
  instIds?: string[];
  maxSymbols?: number;
};

type Row = {
  ts: number;
  line: string;
};

const HEADER = "timestamp,iso,open,high,low,close,volume,symbol,timeframe,exchange";

function printHelp(): void {
  console.log(`Usage:
  pnpm tsx scripts/okx_materialize_training_csv.ts -- [options]

Options:
  --datasetRoot data/market/okx_historical
  --outputDir data/market/okx
  --timeframe 1h
  --instIds BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP
  --maxSymbols 20
`);
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }
  return {
    datasetRoot: raw.get("datasetRoot") ?? "data/market/okx_historical",
    outputDir: raw.get("outputDir") ?? "data/market/okx",
    timeframe: (raw.get("timeframe") ?? "1h").trim().toLowerCase(),
    instIds: parseList(raw.get("instIds")),
    maxSymbols: raw.get("maxSymbols") ? Number(raw.get("maxSymbols")) : undefined,
  };
}

function legacyFileName(instId: string, timeframe: string): string {
  const parts = instId.split("-");
  if (parts.length >= 3 && parts[2].toUpperCase() === "SWAP") {
    const base = parts[0].toUpperCase();
    const quote = parts[1].toUpperCase();
    return `${base}_${quote}_${quote}_${timeframe}.csv`;
  }
  if (parts.length >= 2) {
    const base = parts[0].toUpperCase();
    const quote = parts[1].toUpperCase();
    return `${base}_${quote}_${timeframe}.csv`;
  }
  const safe = instId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${safe}_${timeframe}.csv`;
}

async function readLinesFromZst(path: string): Promise<string[]> {
  return new Promise<string[]>((resolvePromise, rejectPromise) => {
    const proc = spawn("zstd", ["-q", "-d", "-c", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rl = createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });
    const lines: string[] = [];
    let stderr = "";
    proc.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    rl.on("line", line => {
      lines.push(line);
    });
    proc.on("error", rejectPromise);
    proc.on("close", code => {
      if (code === 0) {
        resolvePromise(lines);
        return;
      }
      rejectPromise(new Error(`zstd failed code=${code}: ${stderr || "unknown error"}`));
    });
  });
}

async function readLines(path: string): Promise<string[]> {
  if (path.endsWith(".zst")) {
    return readLinesFromZst(path);
  }
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  const out: string[] = [];
  for await (const line of rl) {
    out.push(line);
  }
  return out;
}

async function collectRows(shardPaths: string[]): Promise<Row[]> {
  const rowsByTs = new Map<number, string>();
  for (const path of shardPaths) {
    const lines = await readLines(path);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("timestamp")) continue;
      const firstComma = trimmed.indexOf(",");
      if (firstComma <= 0) continue;
      const ts = Number(trimmed.slice(0, firstComma));
      if (!Number.isFinite(ts)) continue;
      rowsByTs.set(ts, trimmed);
    }
  }
  return Array.from(rowsByTs.entries())
    .map(([ts, line]) => ({ ts, line }))
    .sort((a, b) => a.ts - b.ts);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.datasetRoot, "candles", args.timeframe);
  const allShardPaths = await listFilesRecursive(root, [".csv", ".csv.zst"]);
  const byInstId = new Map<string, string[]>();

  for (const path of allShardPaths) {
    const rel = path.replace(`${root}/`, "");
    const parts = rel.split("/");
    // structure: {instType}/{instId}/{YYYY-MM}.csv(.zst)
    if (parts.length < 3) continue;
    const instIdSanitized = parts[1];
    const arr = byInstId.get(instIdSanitized);
    if (arr) arr.push(path);
    else byInstId.set(instIdSanitized, [path]);
  }

  let selected = Array.from(byInstId.entries());
  if (args.instIds?.length) {
    const wanted = new Set(args.instIds.map(v => v.replace(/[^a-zA-Z0-9._-]+/g, "_")));
    selected = selected.filter(([instId]) => wanted.has(instId));
  }
  selected.sort((a, b) => a[0].localeCompare(b[0]));
  if (args.maxSymbols && selected.length > args.maxSymbols) {
    selected = selected.slice(0, args.maxSymbols);
  }
  if (!selected.length) {
    throw new Error(`No shards found for timeframe=${args.timeframe} under ${root}`);
  }

  await mkdir(resolve(args.outputDir), { recursive: true });
  const outputs: Array<{
    instId: string;
    output: string;
    rows: number;
    shards: number;
  }> = [];

  for (let i = 0; i < selected.length; i += 1) {
    const [instIdSanitized, shards] = selected[i];
    const prettyInstId = instIdSanitized.replace(/_/g, "-");
    const rows = await collectRows(shards);
    const outputName = legacyFileName(prettyInstId, args.timeframe);
    const outputPath = resolve(args.outputDir, outputName);
    const content =
      rows.length > 0
        ? `${HEADER}\n${rows.map(row => row.line).join("\n")}\n`
        : `${HEADER}\n`;
    await writeFile(outputPath, content, "utf-8");
    outputs.push({
      instId: prettyInstId,
      output: outputPath,
      rows: rows.length,
      shards: shards.length,
    });
    console.log(
      `[${i + 1}/${selected.length}] materialized ${prettyInstId} => ${outputPath} rows=${rows.length}`
    );
  }

  const summaryPath = resolve(args.datasetRoot, "reports", `materialize_${args.timeframe}_summary.v1.json`);
  await writeJsonFile(summaryPath, {
    schemaVersion: "okx_materialize_summary.v1",
    generatedAt: new Date().toISOString(),
    params: {
      datasetRoot: resolve(args.datasetRoot),
      outputDir: resolve(args.outputDir),
      timeframe: args.timeframe,
      instIds: args.instIds ?? null,
      maxSymbols: args.maxSymbols ?? null,
    },
    outputs,
  });
  console.log(`materialize complete: ${outputs.length} files, summary=${summaryPath}`);
}

main().catch(err => {
  console.error("okx_materialize_training_csv failed:", err);
  process.exit(1);
});
