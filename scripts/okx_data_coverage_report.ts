import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { resolve } from "path";
import { createInterface } from "readline";
import { spawn } from "child_process";
import {
  bytesToHuman,
  listFilesRecursive,
  parseBoolean,
  parseRawArgs,
  writeJsonFile,
} from "./okx_historical_common.js";

type CliArgs = {
  datasetRoot: string;
  output: string;
  countRows: boolean;
};

type BucketAgg = {
  key: string;
  shardCount: number;
  totalBytes: number;
  earliestShard: string | null;
  latestShard: string | null;
  rowCount: number | null;
};

function printHelp(): void {
  console.log(`Usage:
  pnpm tsx scripts/okx_data_coverage_report.ts -- [options]

Options:
  --datasetRoot data/market/okx_historical
  --output data/market/okx_historical/reports/coverage_report.v1.json
  --countRows false
`);
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }
  const datasetRoot = raw.get("datasetRoot") ?? "data/market/okx_historical";
  return {
    datasetRoot,
    output:
      raw.get("output") ??
      resolve(datasetRoot, "reports", "coverage_report.v1.json"),
    countRows: parseBoolean(raw.get("countRows"), false),
  };
}

async function countPlainRows(path: string): Promise<number> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  let count = 0;
  for await (const line of rl) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

async function countZstRows(path: string): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const proc = spawn("zstd", ["-q", "-d", "-c", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rl = createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });
    let count = 0;
    let stderr = "";
    proc.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    rl.on("line", line => {
      if (line.trim().length > 0) count += 1;
    });
    proc.on("error", rejectPromise);
    proc.on("close", code => {
      if (code === 0) {
        resolvePromise(count);
        return;
      }
      rejectPromise(new Error(`zstd failed code=${code}: ${stderr || "unknown error"}`));
    });
  });
}

async function maybeCountRows(path: string, enabled: boolean): Promise<number | null> {
  if (!enabled) return null;
  if (path.endsWith(".zst")) return countZstRows(path);
  return countPlainRows(path);
}

function shardFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.csv(\.zst)?$/i, "").replace(/\.ndjson(\.zst)?$/i, "");
}

function upsertAgg(
  map: Map<string, BucketAgg>,
  key: string,
  shard: string,
  bytes: number,
  rows: number | null
): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      key,
      shardCount: 1,
      totalBytes: bytes,
      earliestShard: shard,
      latestShard: shard,
      rowCount: rows,
    });
    return;
  }
  existing.shardCount += 1;
  existing.totalBytes += bytes;
  if (!existing.earliestShard || shard < existing.earliestShard) {
    existing.earliestShard = shard;
  }
  if (!existing.latestShard || shard > existing.latestShard) {
    existing.latestShard = shard;
  }
  if (rows != null) {
    existing.rowCount = (existing.rowCount ?? 0) + rows;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.datasetRoot);
  const candlesFiles = await listFilesRecursive(resolve(root, "candles"), [
    ".csv",
    ".csv.zst",
  ]);
  const indexFiles = await listFilesRecursive(resolve(root, "index_candles"), [
    ".csv",
    ".csv.zst",
  ]);
  const tradesFiles = await listFilesRecursive(resolve(root, "trades"), [
    ".ndjson",
    ".ndjson.zst",
  ]);

  const candlesAgg = new Map<string, BucketAgg>();
  const indexAgg = new Map<string, BucketAgg>();
  const tradesAgg = new Map<string, BucketAgg>();

  for (const file of candlesFiles) {
    const s = await stat(file);
    const rel = file.replace(`${resolve(root, "candles")}/`, "");
    const parts = rel.split("/");
    if (parts.length < 4) continue;
    const timeframe = parts[0];
    const instType = parts[1];
    const instId = parts[2];
    const key = `${timeframe}::${instType}::${instId}`;
    const shard = shardFromPath(file);
    const rows = await maybeCountRows(file, args.countRows);
    upsertAgg(candlesAgg, key, shard, s.size, rows != null ? Math.max(0, rows - 1) : null);
  }

  for (const file of indexFiles) {
    const s = await stat(file);
    const rel = file.replace(`${resolve(root, "index_candles")}/`, "");
    const parts = rel.split("/");
    if (parts.length < 3) continue;
    const timeframe = parts[0];
    const instId = parts[1];
    const key = `${timeframe}::${instId}`;
    const shard = shardFromPath(file);
    const rows = await maybeCountRows(file, args.countRows);
    upsertAgg(indexAgg, key, shard, s.size, rows != null ? Math.max(0, rows - 1) : null);
  }

  for (const file of tradesFiles) {
    const s = await stat(file);
    const rel = file.replace(`${resolve(root, "trades")}/`, "");
    const parts = rel.split("/");
    if (parts.length < 2) continue;
    const instId = parts[0];
    const key = instId;
    const shard = shardFromPath(file);
    const rows = await maybeCountRows(file, args.countRows);
    upsertAgg(tradesAgg, key, shard, s.size, rows);
  }

  const candlesArray = Array.from(candlesAgg.values()).sort((a, b) =>
    a.key.localeCompare(b.key)
  );
  const indexArray = Array.from(indexAgg.values()).sort((a, b) =>
    a.key.localeCompare(b.key)
  );
  const tradesArray = Array.from(tradesAgg.values()).sort((a, b) =>
    a.key.localeCompare(b.key)
  );

  const totalBytes =
    candlesArray.reduce((acc, x) => acc + x.totalBytes, 0) +
    indexArray.reduce((acc, x) => acc + x.totalBytes, 0) +
    tradesArray.reduce((acc, x) => acc + x.totalBytes, 0);

  const report = {
    schemaVersion: "okx_coverage_report.v1",
    generatedAt: new Date().toISOString(),
    params: {
      datasetRoot: root,
      countRows: args.countRows,
    },
    totals: {
      candlesBuckets: candlesArray.length,
      indexBuckets: indexArray.length,
      tradesBuckets: tradesArray.length,
      bytes: totalBytes,
      bytesHuman: bytesToHuman(totalBytes),
    },
    candles: candlesArray,
    indexCandles: indexArray,
    trades: tradesArray,
  };

  await writeJsonFile(args.output, report);
  console.log(
    `coverage report saved: ${resolve(args.output)} | totalSize=${bytesToHuman(totalBytes)}`
  );
}

main().catch(err => {
  console.error("okx_data_coverage_report failed:", err);
  process.exit(1);
});
