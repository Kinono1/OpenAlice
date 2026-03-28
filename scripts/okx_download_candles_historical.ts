import { appendFile, mkdir, stat, writeFile } from "fs/promises";
import { resolve } from "path";
import {
  bytesToHuman,
  compressCsvToZst,
  dayKey,
  directorySizeBytes,
  ensureCsvFromZst,
  fileExists,
  monthKey,
  parseBoolean,
  parseDateMs,
  parseIntArg,
  parseList,
  parseRawArgs,
  parseSizeBytes,
  sleep,
  toIso,
  withRetry,
  writeJsonFile,
  readJsonFile,
  sanitizeSegment,
} from "./okx_historical_common.js";

type CatalogItem = {
  instId: string;
  instType?: string;
  state?: string;
};

type CandlesStateItem = {
  cursorAfter?: number;
  lastWrittenTs?: number;
  completed?: boolean;
  error?: string;
  updatedAt?: string;
};

type CandlesState = {
  schemaVersion: string;
  updatedAt: string;
  items: Record<string, CandlesStateItem>;
};

type CliArgs = {
  datasetRoot: string;
  catalogPath: string;
  statePath: string;
  summaryPath: string;
  reportDir: string;
  quote: string;
  includeNotLive: boolean;
  append: boolean;
  startMs: number;
  endMs: number;
  timeframes?: string[];
  barMode: "auto" | "okx";
  okxBars?: string[];
  maxSymbols?: number;
  instType: "all" | "spot" | "swap";
  symbols?: string[];
  limit: number;
  maxRetries: number;
  sleepMs: number;
  workers: number;
  compress: "none" | "zstd";
  maxDiskBytes: number;
  diskCheckEveryBatches: number;
};

type CandleRow = [number, number, number, number, number, number];

type DownloadTask = {
  instId: string;
  instType: "spot" | "swap";
  bar: string;
  timeframeLabel: string;
};

type TaskResult = {
  key: string;
  instId: string;
  instType: "spot" | "swap";
  bar: string;
  timeframeLabel: string;
  fetchedBars: number;
  writtenBars: number;
  firstWrittenTs: number | null;
  lastWrittenTs: number | null;
  touchedShards: number;
  error?: string;
};

class DiskBudgetExceeded extends Error {}

const CSV_HEADER = "timestamp,iso,open,high,low,close,volume,symbol,timeframe,exchange\n";

function printHelp(): void {
  console.log(`Usage:
  pnpm tsx scripts/okx_download_candles_historical.ts -- [options]

Options:
  --datasetRoot data/market/okx_historical
  --catalogPath data/market/okx_historical/catalog/usdt_all.v1.json
  --statePath data/market/okx_historical/state/candles.state.v1.json
  --summaryPath data/market/okx_historical/reports/candles_summary.v1.json
  --quote USDT
  --includeNotLive true
  --append true
  --start 2017-10-10
  --end 2026-03-04
  --timeframes 1h,15m,5m
  --barMode auto               auto | okx
  --okxBars 1H,15m,5m          used when --barMode okx
  --instType all               all | spot | swap
  --symbols BTC-USDT,BTC-USDT-SWAP
  --maxSymbols 100
  --limit 300
  --maxRetries 8
  --sleepMs 150
  --workers 1
  --compress zstd              zstd | none
  --maxDiskBytes 120GB
  --diskCheckEveryBatches 20
`);
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }
  const now = Date.now();
  const defaultRoot = "data/market/okx_historical";
  const datasetRoot = raw.get("datasetRoot") ?? defaultRoot;
  const barModeRaw = (raw.get("barMode") ?? "auto").toLowerCase();
  const barMode = barModeRaw === "okx" ? "okx" : "auto";
  const instTypeRaw = (raw.get("instType") ?? "all").toLowerCase();
  const instType =
    instTypeRaw === "spot" || instTypeRaw === "swap" ? instTypeRaw : "all";
  const compressRaw = (raw.get("compress") ?? "zstd").toLowerCase();
  const compress = compressRaw === "none" ? "none" : "zstd";
  const timeframes = parseList(raw.get("timeframes"));
  const okxBars = parseList(raw.get("okxBars"));

  return {
    datasetRoot,
    catalogPath:
      raw.get("catalogPath") ??
      resolve(datasetRoot, "catalog", "usdt_all.v1.json"),
    statePath:
      raw.get("statePath") ??
      resolve(datasetRoot, "state", "candles.state.v1.json"),
    summaryPath:
      raw.get("summaryPath") ??
      resolve(datasetRoot, "reports", "candles_summary.v1.json"),
    reportDir: raw.get("reportDir") ?? resolve(datasetRoot, "reports"),
    quote: (raw.get("quote") ?? "USDT").trim().toUpperCase(),
    includeNotLive: parseBoolean(raw.get("includeNotLive"), true),
    append: parseBoolean(raw.get("append"), true),
    startMs: parseDateMs(raw.get("start"), Date.parse("2017-10-10T00:00:00Z")),
    endMs: parseDateMs(raw.get("end"), now),
    timeframes: timeframes?.length ? timeframes : ["1h"],
    barMode,
    okxBars,
    maxSymbols: raw.get("maxSymbols")
      ? parseIntArg(raw.get("maxSymbols"), 0, "maxSymbols")
      : undefined,
    instType,
    symbols: parseList(raw.get("symbols")),
    limit: parseIntArg(raw.get("limit"), 300, "limit"),
    maxRetries: parseIntArg(raw.get("maxRetries"), 8, "maxRetries"),
    sleepMs: parseIntArg(raw.get("sleepMs"), 150, "sleepMs"),
    workers: parseIntArg(raw.get("workers"), 1, "workers"),
    compress,
    maxDiskBytes: parseSizeBytes(raw.get("maxDiskBytes"), 120 * 1024 ** 3),
    diskCheckEveryBatches: parseIntArg(
      raw.get("diskCheckEveryBatches"),
      20,
      "diskCheckEveryBatches"
    ),
  };
}

function timeframeToOkxBar(timeframe: string): string {
  const tf = timeframe.trim();
  const m = tf.match(/^(\d+)([mhdwM])$/);
  if (!m) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const n = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case "m":
      return `${n}m`;
    case "h":
      return `${n}H`;
    case "d":
      return `${n}D`;
    case "w":
      return `${n}W`;
    case "M":
      return `${n}M`;
    default:
      throw new Error(`Unsupported timeframe unit: ${unit}`);
  }
}

function okxBarToMs(bar: string): number {
  const m = bar.match(/^(\d+)(m|H|D|W|M)(utc)?$/i);
  if (!m) throw new Error(`Unsupported OKX bar: ${bar}`);
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  switch (unit) {
    case "M":
      if (m[2] === "m") return n * 60_000;
      return n * 30 * 86_400_000;
    case "H":
      return n * 3_600_000;
    case "D":
      return n * 86_400_000;
    case "W":
      return n * 7 * 86_400_000;
    default:
      throw new Error(`Unsupported OKX bar unit: ${bar}`);
  }
}

function normalizeLabelFromBar(bar: string): string {
  return bar.toLowerCase();
}

function buildBarList(args: CliArgs): Array<{ bar: string; timeframeLabel: string }> {
  const raw = args.barMode === "okx" ? args.okxBars ?? args.timeframes ?? [] : args.timeframes ?? [];
  if (!raw.length) {
    throw new Error("No bars/timeframes provided.");
  }
  if (args.barMode === "okx") {
    return raw.map(bar => {
      okxBarToMs(bar);
      return {
        bar,
        timeframeLabel: normalizeLabelFromBar(bar),
      };
    });
  }
  return raw.map(tf => {
    const bar = timeframeToOkxBar(tf);
    okxBarToMs(bar);
    return {
      bar,
      timeframeLabel: tf.toLowerCase(),
    };
  });
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

async function fetchHistoryCandles(
  instId: string,
  bar: string,
  after: number | undefined,
  limit: number,
  maxRetries: number
): Promise<CandleRow[]> {
  return withRetry(
    async () => {
      const url = new URL("https://www.okx.com/api/v5/market/history-candles");
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
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const payload = (await res.json()) as {
        code?: string;
        msg?: string;
        data?: Array<[string, string, string, string, string, string]>;
      };
      if (payload.code !== "0") {
        throw new Error(`code=${payload.code} msg=${payload.msg ?? ""}`);
      }
      const rows = (payload.data ?? []).map(
        row =>
          [
            Number(row[0]),
            Number(row[1]),
            Number(row[2]),
            Number(row[3]),
            Number(row[4]),
            Number(row[5]),
          ] as CandleRow
      );
      return rows.filter(r => Number.isFinite(r[0]));
    },
    {
      maxRetries,
      baseDelayMs: 700,
      label: `history-candles:${instId}:${bar}:${after ?? "latest"}`,
    }
  );
}

async function loadCatalog(args: CliArgs): Promise<CatalogItem[]> {
  if (args.symbols?.length) {
    return args.symbols.map(instId => ({
      instId,
      instType: instId.endsWith("-SWAP") ? "SWAP" : "SPOT",
      state: "live",
    }));
  }
  const payload = await readJsonFile<{ items?: CatalogItem[] }>(args.catalogPath, {});
  const rows = (payload.items ?? []).filter(row => Boolean(row.instId));
  return rows.filter(row => {
    const it = (row.instType ?? "").toUpperCase();
    const keepType =
      args.instType === "all" ||
      (args.instType === "spot" && it === "SPOT") ||
      (args.instType === "swap" && it === "SWAP");
    if (!keepType) return false;
    if (!args.includeNotLive && row.state !== "live") return false;
    const quoted = row.instId.includes(`-${args.quote}`);
    return quoted;
  });
}

function taskKey(task: DownloadTask): string {
  return `${task.instId}::${task.bar}`;
}

function splitByMonth(
  rows: Array<{
    ts: number;
    line: string;
  }>
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const key = monthKey(row.ts);
    const existing = out.get(key);
    if (existing) {
      existing.push(row.line);
    } else {
      out.set(key, [row.line]);
    }
  }
  return out;
}

async function appendShardLines(params: {
  csvPath: string;
  lines: string[];
  compress: "none" | "zstd";
}): Promise<void> {
  if (params.compress === "zstd") {
    await ensureCsvFromZst(params.csvPath);
  }
  await ensureCsvHeader(params.csvPath);
  await appendFile(params.csvPath, `${params.lines.join("\n")}\n`);
}

function toShardPath(args: CliArgs, task: DownloadTask, month: string): string {
  return resolve(
    args.datasetRoot,
    "candles",
    task.timeframeLabel,
    task.instType,
    sanitizeSegment(task.instId),
    `${month}.csv`
  );
}

async function enforceDiskBudget(args: CliArgs): Promise<void> {
  const used = await directorySizeBytes(args.datasetRoot);
  if (used > args.maxDiskBytes) {
    throw new DiskBudgetExceeded(
      `Disk budget exceeded: used=${bytesToHuman(used)} > max=${bytesToHuman(args.maxDiskBytes)}`
    );
  }
}

async function downloadTask(
  args: CliArgs,
  state: CandlesState,
  task: DownloadTask
): Promise<TaskResult> {
  const key = taskKey(task);
  const stateItem = state.items[key] ?? {};
  let cursorAfter = args.append ? stateItem.cursorAfter : undefined;
  let lastWrittenTs = args.append ? stateItem.lastWrittenTs ?? 0 : 0;
  const startTs = args.startMs;
  const stopBeforeTs = startTs;
  let fetchedBars = 0;
  let writtenBars = 0;
  let firstWrittenTs: number | null = null;
  let latestWrittenTs: number | null = lastWrittenTs > 0 ? lastWrittenTs : null;
  let batchCount = 0;
  const touchedShards = new Set<string>();

  while (true) {
    const batch = await fetchHistoryCandles(
      task.instId,
      task.bar,
      cursorAfter,
      args.limit,
      args.maxRetries
    );
    if (!batch.length) break;
    fetchedBars += batch.length;
    batchCount += 1;

    let oldestTs = Number.POSITIVE_INFINITY;
    const accepted: Array<{ ts: number; line: string }> = [];
    for (const row of batch) {
      const [ts, open, high, low, close, volume] = row;
      if (!Number.isFinite(ts)) continue;
      if (ts < oldestTs) oldestTs = ts;
      if (ts < startTs || ts > args.endMs) continue;
      const line = `${ts},${toIso(ts)},${open},${high},${low},${close},${volume},${task.instId},${task.timeframeLabel},okx`;
      accepted.push({ ts, line });
      if (firstWrittenTs == null || ts < firstWrittenTs) firstWrittenTs = ts;
      if (latestWrittenTs == null || ts > latestWrittenTs) latestWrittenTs = ts;
    }

    if (accepted.length > 0) {
      accepted.sort((a, b) => a.ts - b.ts);
      const byMonth = splitByMonth(accepted);
      for (const [month, rows] of byMonth.entries()) {
        const csvPath = toShardPath(args, task, month);
        await appendShardLines({
          csvPath,
          lines: rows,
          compress: args.compress,
        });
        touchedShards.add(csvPath);
      }
      writtenBars += accepted.length;
      const maxTs = accepted[accepted.length - 1].ts;
      if (maxTs > lastWrittenTs) lastWrittenTs = maxTs;
    }

    if (!Number.isFinite(oldestTs)) break;
    if (oldestTs <= stopBeforeTs) break;
    cursorAfter = oldestTs;

    if (batchCount % args.diskCheckEveryBatches === 0) {
      await enforceDiskBudget(args);
    }
    state.items[key] = {
      cursorAfter,
      lastWrittenTs,
      completed: false,
      updatedAt: new Date().toISOString(),
    };

    if (args.sleepMs > 0) {
      await sleep(args.sleepMs);
    }
  }

  if (args.compress === "zstd") {
    for (const csvPath of touchedShards) {
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
    instType: task.instType,
    bar: task.bar,
    timeframeLabel: task.timeframeLabel,
    fetchedBars,
    writtenBars,
    firstWrittenTs,
    lastWrittenTs: latestWrittenTs,
    touchedShards: touchedShards.size,
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
    { length: Math.min(Math.max(concurrency, 1), items.length || 1) },
    () => runOne()
  );
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.startMs >= args.endMs) {
    throw new Error("start must be earlier than end");
  }
  await mkdir(resolve(args.datasetRoot, "reports"), { recursive: true });
  await mkdir(resolve(args.datasetRoot, "state"), { recursive: true });
  await mkdir(resolve(args.datasetRoot, "candles"), { recursive: true });

  const bars = buildBarList(args);
  const catalog = await loadCatalog(args);
  let selected = catalog;
  if (args.maxSymbols && selected.length > args.maxSymbols) {
    selected = selected.slice(0, args.maxSymbols);
  }
  if (!selected.length) {
    throw new Error("No instruments selected. Check catalog/filters.");
  }
  const tasks: DownloadTask[] = [];
  for (const item of selected) {
    const instType = (item.instType ?? "").toUpperCase() === "SWAP" ? "swap" : "spot";
    for (const b of bars) {
      tasks.push({
        instId: item.instId,
        instType,
        bar: b.bar,
        timeframeLabel: b.timeframeLabel,
      });
    }
  }

  const startedAt = Date.now();
  const state = await readJsonFile<CandlesState>(args.statePath, {
    schemaVersion: "okx_candles_state.v1",
    updatedAt: new Date().toISOString(),
    items: {},
  });

  console.log(
    `candles plan: instruments=${selected.length}, bars=${bars.length}, tasks=${tasks.length}, workers=${args.workers}, datasetRoot=${resolve(
      args.datasetRoot
    )}`
  );
  console.log(
    `window: [${toIso(args.startMs)} -> ${toIso(args.endMs)}], diskBudget=${bytesToHuman(args.maxDiskBytes)}`
  );

  const results: TaskResult[] = [];
  let haltedByDiskBudget = false;
  let haltError = "";

  try {
    const outs = await withConcurrency(tasks, args.workers, async (task, idx) => {
      const prefix = `[${idx + 1}/${tasks.length}] ${task.instId} ${task.bar}`;
      const existing = state.items[taskKey(task)];
      if (args.append && existing?.completed) {
        console.log(`${prefix}: skip (completed in state)`);
        return {
          key: taskKey(task),
          instId: task.instId,
          instType: task.instType,
          bar: task.bar,
          timeframeLabel: task.timeframeLabel,
          fetchedBars: 0,
          writtenBars: 0,
          firstWrittenTs: null,
          lastWrittenTs: existing.lastWrittenTs ?? null,
          touchedShards: 0,
        } satisfies TaskResult;
      }
      try {
        console.log(`${prefix}: start`);
        const result = await downloadTask(args, state, task);
        console.log(
          `${prefix}: done written=${result.writtenBars} fetched=${result.fetchedBars} shards=${result.touchedShards}`
        );
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof DiskBudgetExceeded) {
          haltedByDiskBudget = true;
          haltError = message;
        }
        console.error(`${prefix}: failed ${message}`);
        state.items[taskKey(task)] = {
          ...(state.items[taskKey(task)] ?? {}),
          completed: false,
          error: message,
          updatedAt: new Date().toISOString(),
        };
        return {
          key: taskKey(task),
          instId: task.instId,
          instType: task.instType,
          bar: task.bar,
          timeframeLabel: task.timeframeLabel,
          fetchedBars: 0,
          writtenBars: 0,
          firstWrittenTs: null,
          lastWrittenTs: null,
          touchedShards: 0,
          error: message,
        } satisfies TaskResult;
      }
    });
    results.push(...outs);
  } finally {
    state.updatedAt = new Date().toISOString();
    await writeJsonFile(args.statePath, state);
  }

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

  const usedBytes = await directorySizeBytes(args.datasetRoot);
  const summary = {
    schemaVersion: "okx_candles_summary.v1",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    params: {
      datasetRoot: resolve(args.datasetRoot),
      catalogPath: resolve(args.catalogPath),
      statePath: resolve(args.statePath),
      quote: args.quote,
      includeNotLive: args.includeNotLive,
      append: args.append,
      start: toIso(args.startMs),
      end: toIso(args.endMs),
      timeframes: args.timeframes,
      barMode: args.barMode,
      okxBars: args.okxBars ?? null,
      instType: args.instType,
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
      usedBytes,
      usedHuman: bytesToHuman(usedBytes),
    },
    totals,
    results,
  };

  await writeJsonFile(args.summaryPath, summary);
  if (haltedByDiskBudget) {
    const pending = tasks
      .map(task => taskKey(task))
      .filter(key => !state.items[key]?.completed);
    await writeJsonFile(resolve(args.reportDir, "candles_pending_queue.v1.json"), {
      schemaVersion: "okx_candles_pending_queue.v1",
      generatedAt: new Date().toISOString(),
      pendingCount: pending.length,
      pending,
    });
    console.error(`halted by disk budget: ${haltError}`);
    process.exitCode = 2;
    return;
  }

  console.log(
    `candles complete: written=${totals.writtenBars}, fetched=${totals.fetchedBars}, failed=${totals.failedTasks}, used=${bytesToHuman(
      usedBytes
    )}`
  );
  console.log(`summary saved: ${resolve(args.summaryPath)}`);
}

main().catch(err => {
  console.error("okx_download_candles_historical failed:", err);
  process.exit(1);
});
