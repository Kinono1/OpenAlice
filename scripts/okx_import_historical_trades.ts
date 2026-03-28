import { appendFile, mkdir, readdir, readFile } from "fs/promises";
import { resolve } from "path";
import {
  compressCsvToZst,
  dayKey,
  ensureCsvFromZst,
  fileExists,
  listFilesRecursive,
  parseBoolean,
  parseList,
  parseRawArgs,
  readJsonFile,
  sanitizeSegment,
  writeJsonFile,
} from "./okx_historical_common.js";

type CliArgs = {
  inputDir: string;
  datasetRoot: string;
  statePath: string;
  summaryPath: string;
  includePatterns?: string[];
  append: boolean;
  compress: "none" | "zstd";
};

type ImportState = {
  schemaVersion: string;
  updatedAt: string;
  processedFiles: string[];
};

type TradeRecord = {
  tradeId: string;
  ts: string;
  px: string;
  sz: string;
  side: string;
  instId: string;
};

function printHelp(): void {
  console.log(`Usage:
  pnpm tsx scripts/okx_import_historical_trades.ts -- [options]

Options:
  --inputDir data/raw/okx/historical/trades
  --datasetRoot data/market/okx_historical
  --statePath data/market/okx_historical/state/trades_import.state.v1.json
  --summaryPath data/market/okx_historical/reports/trades_import_summary.v1.json
  --includePatterns *.csv,*.json,*.ndjson
  --append true
  --compress zstd
`);
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }
  const datasetRoot = raw.get("datasetRoot") ?? "data/market/okx_historical";
  const compressRaw = (raw.get("compress") ?? "zstd").toLowerCase();
  return {
    inputDir: raw.get("inputDir") ?? "data/raw/okx/historical/trades",
    datasetRoot,
    statePath:
      raw.get("statePath") ??
      resolve(datasetRoot, "state", "trades_import.state.v1.json"),
    summaryPath:
      raw.get("summaryPath") ??
      resolve(datasetRoot, "reports", "trades_import_summary.v1.json"),
    includePatterns: parseList(raw.get("includePatterns")) ?? [
      "*.csv",
      "*.json",
      "*.ndjson",
      "*.jsonl",
    ],
    append: parseBoolean(raw.get("append"), true),
    compress: compressRaw === "none" ? "none" : "zstd",
  };
}

function isWanted(path: string, patterns: string[]): boolean {
  const lower = path.toLowerCase();
  return patterns.some(p => {
    const pat = p.toLowerCase();
    if (pat.startsWith("*.")) return lower.endsWith(pat.slice(1));
    return lower.endsWith(pat);
  });
}

function toOutputPath(datasetRoot: string, instId: string, tsMs: number): string {
  return resolve(
    datasetRoot,
    "trades",
    sanitizeSegment(instId),
    `${dayKey(tsMs)}.ndjson`
  );
}

function normalizeRecord(input: Record<string, unknown>): TradeRecord | null {
  const tradeId = String(
    input.tradeId ??
      input.trade_id ??
      input.id ??
      input.tid ??
      ""
  ).trim();
  const tsRaw = String(input.ts ?? input.timestamp ?? input.time ?? "").trim();
  const px = String(input.px ?? input.price ?? "").trim();
  const sz = String(input.sz ?? input.size ?? input.qty ?? "").trim();
  const side = String(input.side ?? input.direction ?? "").trim().toLowerCase();
  const instId = String(input.instId ?? input.symbol ?? input.inst_id ?? "").trim();
  if (!tradeId || !tsRaw || !instId) return null;
  const tsNum = Number(tsRaw);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return null;
  return {
    tradeId,
    ts: String(Math.floor(tsNum)),
    px,
    sz,
    side,
    instId,
  };
}

function parseCsv(text: string): TradeRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(v => v.trim());
  const out: TradeRecord[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    if (cols.length < header.length) continue;
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < header.length; i += 1) {
      obj[header[i]] = cols[i];
    }
    const normalized = normalizeRecord(obj);
    if (normalized) out.push(normalized);
  }
  return out;
}

function parseNdjson(text: string): TradeRecord[] {
  const out: TradeRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const normalized = normalizeRecord(parsed);
      if (normalized) out.push(normalized);
    } catch {
      // ignore malformed rows
    }
  }
  return out;
}

function parseJson(text: string): TradeRecord[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map(item => normalizeRecord(item as Record<string, unknown>))
        .filter((row): row is TradeRecord => Boolean(row));
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const data = obj.data;
      if (Array.isArray(data)) {
        return data
          .map(item => normalizeRecord(item as Record<string, unknown>))
          .filter((row): row is TradeRecord => Boolean(row));
      }
    }
  } catch {
    // fallback to ndjson parser
  }
  return parseNdjson(text);
}

async function readRecords(path: string): Promise<TradeRecord[]> {
  const raw = await readFile(path, "utf-8");
  const lower = path.toLowerCase();
  if (lower.endsWith(".csv")) return parseCsv(raw);
  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) return parseNdjson(raw);
  return parseJson(raw);
}

async function ensureWritable(path: string, compress: "none" | "zstd"): Promise<void> {
  if (compress === "zstd") {
    await ensureCsvFromZst(path);
  }
  if (!(await fileExists(path))) {
    await mkdir(resolve(path, ".."), { recursive: true });
    await appendFile(path, "");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(resolve(args.datasetRoot, "trades"), { recursive: true });
  await mkdir(resolve(args.datasetRoot, "state"), { recursive: true });
  await mkdir(resolve(args.datasetRoot, "reports"), { recursive: true });

  const allFiles = await listFilesRecursive(args.inputDir, [".csv", ".json", ".ndjson", ".jsonl"]);
  const files = allFiles.filter(path => isWanted(path, args.includePatterns ?? []));
  const state = await readJsonFile<ImportState>(args.statePath, {
    schemaVersion: "okx_trades_import_state.v1",
    updatedAt: new Date().toISOString(),
    processedFiles: [],
  });
  const done = new Set(state.processedFiles);
  const candidates = args.append ? files.filter(path => !done.has(path)) : files;

  console.log(
    `trades import plan: inputFiles=${files.length}, pending=${candidates.length}, inputDir=${resolve(
      args.inputDir
    )}`
  );

  let importedFiles = 0;
  let importedRows = 0;
  let skippedFiles = 0;
  const touched = new Set<string>();
  const failures: Array<{ path: string; error: string }> = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const path = candidates[i];
    const prefix = `[${i + 1}/${candidates.length}] ${path}`;
    try {
      const rows = await readRecords(path);
      if (!rows.length) {
        skippedFiles += 1;
        done.add(path);
        console.log(`${prefix}: skip(empty)`);
        continue;
      }
      const byShard = new Map<string, string[]>();
      for (const row of rows) {
        const tsMs = Number(row.ts);
        if (!Number.isFinite(tsMs)) continue;
        const outPath = toOutputPath(args.datasetRoot, row.instId, tsMs);
        const line = JSON.stringify(row);
        const arr = byShard.get(outPath);
        if (arr) arr.push(line);
        else byShard.set(outPath, [line]);
      }
      for (const [outPath, lines] of byShard.entries()) {
        await ensureWritable(outPath, args.compress);
        await appendFile(outPath, `${lines.join("\n")}\n`);
        touched.add(outPath);
      }
      importedFiles += 1;
      importedRows += rows.length;
      done.add(path);
      console.log(`${prefix}: done rows=${rows.length}, shards=${byShard.size}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ path, error: message });
      console.error(`${prefix}: failed ${message}`);
    }
  }

  if (args.compress === "zstd") {
    for (const outPath of touched) {
      await compressCsvToZst(outPath);
    }
  }

  state.updatedAt = new Date().toISOString();
  state.processedFiles = Array.from(done).sort((a, b) => a.localeCompare(b));
  await writeJsonFile(args.statePath, state);

  const summary = {
    schemaVersion: "okx_trades_import_summary.v1",
    generatedAt: new Date().toISOString(),
    params: {
      inputDir: resolve(args.inputDir),
      datasetRoot: resolve(args.datasetRoot),
      statePath: resolve(args.statePath),
      includePatterns: args.includePatterns,
      append: args.append,
      compress: args.compress,
    },
    totals: {
      inputFiles: files.length,
      pendingFiles: candidates.length,
      importedFiles,
      importedRows,
      skippedFiles,
      failedFiles: failures.length,
      touchedShards: touched.size,
    },
    failures,
  };
  await writeJsonFile(args.summaryPath, summary);
  console.log(
    `trades import complete: importedFiles=${importedFiles}, importedRows=${importedRows}, failedFiles=${failures.length}`
  );
  console.log(`summary saved: ${resolve(args.summaryPath)}`);
}

main().catch(err => {
  console.error("okx_import_historical_trades failed:", err);
  process.exit(1);
});
