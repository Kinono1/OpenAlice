import { appendFile, mkdir, stat, writeFile } from "fs/promises";
import { resolve } from "path";
import {
  bytesToHuman,
  compressCsvToZst,
  directorySizeBytes,
  ensureCsvFromZst,
  fileExists,
  monthKey,
  parseDateMs,
  parseIntArg,
  parseList,
  parseRawArgs,
  parseSizeBytes,
  readJsonFile,
  sanitizeSegment,
  sleep,
  toIso,
  withRetry,
  writeJsonFile,
} from "./okx_historical_common.js";

type StateItem = {
  cursorAfter?: number;
  lastWrittenTs?: number;
  completed?: boolean;
  error?: string;
  updatedAt?: string;
};

type StatePayload = {
  schemaVersion: string;
  updatedAt: string;
  items: Record<string, StateItem>;
};

type CliArgs = {
  datasetRoot: string;
  catalogPath: string;
  statePath: string;
  summaryPath: string;
  startMs: number;
  endMs: number;
  bars: string[];
  symbols?: string[];
  maxSymbols?: number;
  limit: number;
  maxRetries: number;
  sleepMs: number;
  workers: number;
  compress: "none" | "zstd";
  maxDiskBytes: number;
  append: boolean;
};

type Task = {
  instId: string;
  bar: string;
  timeframeLabel: string;
};

type TaskResult = {
  key: string;
  instId: string;
  bar: string;
  fetchedBars: number;
  writtenBars: number;
  touchedShards: number;
  error?: string;
};

const CSV_HEADER =
  "timestamp,iso,open,high,low,close,volume,symbol,timeframe,exchange\n";

class DiskBudgetExceeded extends Error {}

function printHelp(): void {
  console.log(`Usage:
  pnpm tsx scripts/okx_download_index_candles.ts -- [options]

Options:
  --datasetRoot data/market/okx_historical
  --catalogPath data/market/okx_historical/catalog/index_candidates.v1.json
  --statePath data/market/okx_historical/state/index_candles.state.v1.json
  --summaryPath data/market/okx_historical/reports/index_candles_summary.v1.json
  --start 2019-12-31
  --end 2026-03-04
  --bars 1H,1D,1Dutc
  --symbols BTC-USDT,ETH-USDT
  --maxSymbols 50
  --limit 300
  --maxRetries 8
  --sleepMs 120
  --workers 1
  --compress zstd
  --maxDiskBytes 120GB
  --append true
`);
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }
  const now = Date.now();
  const datasetRoot = raw.get("datasetRoot") ?? "data/market/okx_historical";
  const bars = parseList(raw.get("bars")) ?? ["1H", "1D"];
  const compressRaw = (raw.get("compress") ?? "zstd").toLowerCase();
  return {
    datasetRoot,
    catalogPath:
      raw.get("catalogPath") ??
      resolve(datasetRoot, "catalog", "index_candidates.v1.json"),
    statePath:
      raw.get("statePath") ??
      resolve(datasetRoot, "state", "index_candles.state.v1.json"),
    summaryPath:
      raw.get("summaryPath") ??
      resolve(datasetRoot, "reports", "index_candles_summary.v1.json"),
    startMs: parseDateMs(raw.get("start"), Date.parse("2019-12-31T00:00:00Z")),
    endMs: parseDateMs(raw.get("end"), now),
    bars,
    symbols: parseList(raw.get("symbols")),
    maxSymbols: raw.get("maxSymbols")
      ? parseIntArg(raw.get("maxSymbols"), 0, "maxSymbols")
      : undefined,
    limit: parseIntArg(raw.get("limit"), 300, "limit"),
    maxRetries: parseIntArg(raw.get("maxRetries"), 8, "maxRetries"),
    sleepMs: parseIntArg(raw.get("sleepMs"), 120, "sleepMs"),
    workers: parseIntArg(raw.get("workers"), 1, "workers"),
    compress: compressRaw === "none" ? "none" : "zstd",
    maxDiskBytes: parseSizeBytes(raw.get("maxDiskBytes"), 120 * 1024 ** 3),
    append: raw.get("append") == null ? true : raw.get("append") !== "false",
  };
}

function barToMs(bar: string): number {
  const m = bar.match(/^(\d+)(m|H|D|W|M)(utc)?$/i);
  if (!m) throw new Error(`Unsupported bar: ${bar}`);
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  if (m[2] === "m") return n * 60_000;
  if (unit === "H") return n * 3_600_000;
  if (unit === "D") return n * 86_400_000;
  if (unit === "W") return n * 7 * 86_400_000;
  return n * 30 * 86_400_000;
}

function taskKey(task: Task): string {
  return `${task.instId}::${task.bar}`;
}

function shardPath(args: CliArgs, task: Task, month: string): string {
  return resolve(
    args.datasetRoot,
    "index_candles",
    task.timeframeLabel,
    sanitizeSegment(task.instId),
    `${month}.csv`
  );
}

async function ensureCsvHeader(path: string): Promise<void> {
  if (!(await fileExists(path))) {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, CSV_HEADER, "utf-8");
    return;
  }
  const s = await stat(path);
  if (s.size === 0) {
    await writeFile(path, CSV_HEADER, "utf-8");
  }
}

async function fetchIndexCandles(
  instId: string,
  bar: string,
  after: number | undefined,
  limit: number,
  maxRetries: number
): Promise<Array<[number, number, number, number, number]>> {
  return withRetry(
    async () => {
      const url = new URL("https://www.okx.com/api/v5/market/history-index-candles");
      url.searchParams.set("instId", instId);
      url.searchParams.set("bar", bar);
      url.searchParams.set("limit", String(limit));
      if (after != null) {
        url.searchParams.set("after", String(after));
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0",
        },
      }).finally(() => {
        clearTimeout(timeout);
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const payload = (await res.json()) as {
        code?: string;
        msg?: string;
        data?: Array<[string, string, string, string, string]>;
      };
      if (payload.code !== "0") {
        throw new Error(`code=${payload.code} msg=${payload.msg ?? ""}`);
      }
      return (payload.data ?? [])
        .map(row => [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4])] as [
          number,
          number,
          number,
          number,
          number,
        ])
        .filter(row => Number.isFinite(row[0]));
    },
    {
      maxRetries,
      baseDelayMs: 700,
      label: `history-index-candles:${instId}:${bar}:${after ?? "latest"}`,
    }
  );
}

async function resolveSymbols(args: CliArgs): Promise<string[]> {
  if (args.symbols?.length) {
    return args.symbols;
  }
  const payload = await readJsonFile<{ items?: string[] }>(args.catalogPath, {});
  return (payload.items ?? []).filter(Boolean);
}

async function enforceDisk(args: CliArgs): Promise<void> {
  const used = await directorySizeBytes(args.datasetRoot);
  if (used > args.maxDiskBytes) {
    throw new DiskBudgetExceeded(
      `Disk budget exceeded: used=${bytesToHuman(used)} > max=${bytesToHuman(args.maxDiskBytes)}`
    );
  }
}

async function runTask(
  args: CliArgs,
  state: StatePayload,
  task: Task
): Promise<TaskResult> {
  const key = taskKey(task);
  const existing = state.items[key] ?? {};
  let cursorAfter = args.append ? existing.cursorAfter : undefined;
  let lastWrittenTs = args.append ? existing.lastWrittenTs ?? 0 : 0;
  const startTs = args.startMs;
  const stopBeforeTs = startTs;
  let fetchedBars = 0;
  let writtenBars = 0;
  let batches = 0;
  const touched = new Set<string>();

  while (true) {
    const batch = await fetchIndexCandles(
      task.instId,
      task.bar,
      cursorAfter,
      args.limit,
      args.maxRetries
    );
    if (!batch.length) break;
    fetchedBars += batch.length;
    batches += 1;
    let oldestTs = Number.POSITIVE_INFINITY;
    const accepted: Array<{ ts: number; line: string }> = [];
    for (const row of batch) {
      const [ts, open, high, low, close] = row;
      if (!Number.isFinite(ts)) continue;
      if (ts < oldestTs) oldestTs = ts;
      if (ts < startTs || ts > args.endMs) continue;
      accepted.push({
        ts,
        line: `${ts},${toIso(ts)},${open},${high},${low},${close},0,${task.instId},${task.timeframeLabel},okx_index`,
      });
    }
    if (accepted.length > 0) {
      accepted.sort((a, b) => a.ts - b.ts);
      const byMonth = new Map<string, string[]>();
      for (const row of accepted) {
        const mk = monthKey(row.ts);
        const arr = byMonth.get(mk);
        if (arr) arr.push(row.line);
        else byMonth.set(mk, [row.line]);
      }
      for (const [mk, lines] of byMonth.entries()) {
        const csvPath = shardPath(args, task, mk);
        if (args.compress === "zstd") {
          await ensureCsvFromZst(csvPath);
        }
        await ensureCsvHeader(csvPath);
        await appendFile(csvPath, `${lines.join("\n")}\n`);
        touched.add(csvPath);
      }
      writtenBars += accepted.length;
      const maxTs = accepted[accepted.length - 1].ts;
      if (maxTs > lastWrittenTs) lastWrittenTs = maxTs;
    }
    if (!Number.isFinite(oldestTs)) break;
    if (oldestTs <= stopBeforeTs) break;
    cursorAfter = oldestTs;
    if (batches % 20 === 0) await enforceDisk(args);
    state.items[key] = {
      cursorAfter,
      lastWrittenTs,
      completed: false,
      updatedAt: new Date().toISOString(),
    };
    if (args.sleepMs > 0) await sleep(args.sleepMs);
  }

  if (args.compress === "zstd") {
    for (const csvPath of touched) {
      await compressCsvToZst(csvPath);
    }
  }
  state.items[key] = {
    cursorAfter,
    lastWrittenTs,
    completed: true,
    updatedAt: new Date().toISOString(),
  };
  return {
    key,
    instId: task.instId,
    bar: task.bar,
    fetchedBars,
    writtenBars,
    touchedShards: touched.size,
  };
}

async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function runOne(): Promise<void> {
    while (true) {
      const idx = next;
      next += 1;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length || 1) },
    () => runOne()
  );
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.startMs >= args.endMs) throw new Error("start must be earlier than end");
  const symbols = await resolveSymbols(args);
  let selected = symbols;
  if (args.maxSymbols && selected.length > args.maxSymbols) {
    selected = selected.slice(0, args.maxSymbols);
  }
  const tasks: Task[] = [];
  for (const instId of selected) {
    for (const bar of args.bars) {
      barToMs(bar);
      tasks.push({
        instId,
        bar,
        timeframeLabel: bar.toLowerCase(),
      });
    }
  }
  if (!tasks.length) throw new Error("No index-candle tasks generated.");

  await mkdir(resolve(args.datasetRoot, "index_candles"), { recursive: true });
  await mkdir(resolve(args.datasetRoot, "state"), { recursive: true });
  await mkdir(resolve(args.datasetRoot, "reports"), { recursive: true });

  const state = await readJsonFile<StatePayload>(args.statePath, {
    schemaVersion: "okx_index_candles_state.v1",
    updatedAt: new Date().toISOString(),
    items: {},
  });
  const startedAt = Date.now();
  let haltedByDiskBudget = false;
  let haltError = "";
  const results = await withConcurrency(tasks, args.workers, async (task, idx) => {
    const prefix = `[${idx + 1}/${tasks.length}] ${task.instId} ${task.bar}`;
    const existing = state.items[taskKey(task)];
    if (args.append && existing?.completed) {
      console.log(`${prefix}: skip (completed in state)`);
      return {
        key: taskKey(task),
        instId: task.instId,
        bar: task.bar,
        fetchedBars: 0,
        writtenBars: 0,
        touchedShards: 0,
      } satisfies TaskResult;
    }
    try {
      console.log(`${prefix}: start`);
      const result = await runTask(args, state, task);
      console.log(`${prefix}: done written=${result.writtenBars} fetched=${result.fetchedBars}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof DiskBudgetExceeded) {
        haltedByDiskBudget = true;
        haltError = message;
      }
      state.items[taskKey(task)] = {
        ...(state.items[taskKey(task)] ?? {}),
        completed: false,
        error: message,
        updatedAt: new Date().toISOString(),
      };
      console.error(`${prefix}: failed ${message}`);
      return {
        key: taskKey(task),
        instId: task.instId,
        bar: task.bar,
        fetchedBars: 0,
        writtenBars: 0,
        touchedShards: 0,
        error: message,
      } satisfies TaskResult;
    }
  });
  state.updatedAt = new Date().toISOString();
  await writeJsonFile(args.statePath, state);

  const totals = results.reduce(
    (acc, row) => {
      acc.fetchedBars += row.fetchedBars;
      acc.writtenBars += row.writtenBars;
      if (row.error) acc.failedTasks += 1;
      return acc;
    },
    {
      fetchedBars: 0,
      writtenBars: 0,
      failedTasks: 0,
    }
  );
  const used = await directorySizeBytes(args.datasetRoot);
  const summary = {
    schemaVersion: "okx_index_candles_summary.v1",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    params: {
      datasetRoot: resolve(args.datasetRoot),
      catalogPath: resolve(args.catalogPath),
      statePath: resolve(args.statePath),
      start: toIso(args.startMs),
      end: toIso(args.endMs),
      bars: args.bars,
      symbols: args.symbols ?? null,
      maxSymbols: args.maxSymbols ?? null,
      limit: args.limit,
      maxRetries: args.maxRetries,
      sleepMs: args.sleepMs,
      workers: args.workers,
      compress: args.compress,
      maxDiskBytes: args.maxDiskBytes,
      maxDiskHuman: bytesToHuman(args.maxDiskBytes),
    },
    haltedByDiskBudget,
    haltError: haltedByDiskBudget ? haltError : "",
    diskUsage: {
      usedBytes: used,
      usedHuman: bytesToHuman(used),
    },
    totals,
    results,
  };
  await writeJsonFile(args.summaryPath, summary);
  if (haltedByDiskBudget) {
    process.exitCode = 2;
    return;
  }
  console.log(
    `index candles complete: written=${totals.writtenBars}, fetched=${totals.fetchedBars}, failed=${totals.failedTasks}`
  );
  console.log(`summary saved: ${resolve(args.summaryPath)}`);
}

main().catch(err => {
  console.error("okx_download_index_candles failed:", err);
  process.exit(1);
});
