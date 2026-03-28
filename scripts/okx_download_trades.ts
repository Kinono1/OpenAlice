import { appendFile, mkdir, stat } from "fs/promises";
import { spawn } from "child_process";
import { resolve } from "path";
import {
  bytesToHuman,
  compressCsvToZst,
  dayKey,
  directorySizeBytes,
  ensureCsvFromZst,
  fileExists,
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

type CatalogItem = {
  instId: string;
  instType?: string;
  state?: string;
};

type TradeItem = {
  tradeId: string;
  ts: string;
  px: string;
  sz: string;
  side: string;
  instId: string;
};

type StateItem = {
  after?: string;
  oldestTs?: number;
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
  reportDir: string;
  symbols?: string[];
  maxSymbols?: number;
  instType: "all" | "spot" | "swap";
  includeNotLive: boolean;
  startMs: number;
  endMs: number;
  limit: number;
  maxRetries: number;
  sleepMs: number;
  workers: number;
  append: boolean;
  compress: "none" | "zstd";
  maxDiskBytes: number;
  diskCheckEveryBatches: number;
};

type Task = {
  instId: string;
};

type PersistStateFn = () => Promise<void>;

type TaskResult = {
  instId: string;
  fetchedRows: number;
  writtenRows: number;
  touchedShards: number;
  firstTs: number | null;
  lastTs: number | null;
  error?: string;
};

class DiskBudgetExceeded extends Error {}

async function fetchJsonViaCurl(url: string): Promise<{
  code?: string;
  msg?: string;
  data?: TradeItem[];
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(
      "curl",
      [
        "-fsSL",
        "--connect-timeout",
        "10",
        "--max-time",
        "20",
        "-A",
        "Mozilla/5.0",
        url,
      ],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    proc.on("error", rejectPromise);
    proc.on("close", code => {
      if (code !== 0) {
        rejectPromise(
          new Error(`curl exited with code=${code}: ${stderr.trim() || "unknown error"}`)
        );
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as { code?: string; msg?: string; data?: TradeItem[] });
      } catch (err) {
        rejectPromise(
          new Error(
            `curl json parse failed: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    });
  });
}

function printHelp(): void {
  console.log(`Usage:
  pnpm tsx scripts/okx_download_trades.ts -- [options]

Options:
  --datasetRoot data/market/okx_historical
  --catalogPath data/market/okx_historical/catalog/usdt_all.v1.json
  --statePath data/market/okx_historical/state/trades.state.v1.json
  --summaryPath data/market/okx_historical/reports/trades_summary.v1.json
  --symbols BTC-USDT,BTC-USDT-SWAP
  --maxSymbols 200
  --instType all              all | spot | swap
  --includeNotLive true
  --start 2025-12-04
  --end 2026-03-04
  --limit 100
  --maxRetries 8
  --sleepMs 120
  --workers 2
  --append true
  --compress zstd
  --maxDiskBytes 120GB
  --diskCheckEveryBatches 50
`);
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }
  const now = Date.now();
  const defaultStart = now - 90 * 86_400_000;
  const datasetRoot = raw.get("datasetRoot") ?? "data/market/okx_historical";
  const compressRaw = (raw.get("compress") ?? "zstd").toLowerCase();
  const instTypeRaw = (raw.get("instType") ?? "all").toLowerCase();
  const instType =
    instTypeRaw === "spot" || instTypeRaw === "swap" ? instTypeRaw : "all";
  return {
    datasetRoot,
    catalogPath:
      raw.get("catalogPath") ??
      resolve(datasetRoot, "catalog", "usdt_all.v1.json"),
    statePath:
      raw.get("statePath") ??
      resolve(datasetRoot, "state", "trades.state.v1.json"),
    summaryPath:
      raw.get("summaryPath") ??
      resolve(datasetRoot, "reports", "trades_summary.v1.json"),
    reportDir: raw.get("reportDir") ?? resolve(datasetRoot, "reports"),
    symbols: parseList(raw.get("symbols")),
    maxSymbols: raw.get("maxSymbols")
      ? parseIntArg(raw.get("maxSymbols"), 0, "maxSymbols")
      : undefined,
    instType,
    includeNotLive: raw.get("includeNotLive") == null ? true : raw.get("includeNotLive") !== "false",
    startMs: parseDateMs(raw.get("start"), defaultStart),
    endMs: parseDateMs(raw.get("end"), now),
    limit: parseIntArg(raw.get("limit"), 100, "limit"),
    maxRetries: parseIntArg(raw.get("maxRetries"), 8, "maxRetries"),
    sleepMs: parseIntArg(raw.get("sleepMs"), 120, "sleepMs"),
    workers: parseIntArg(raw.get("workers"), 2, "workers"),
    append: raw.get("append") == null ? true : raw.get("append") !== "false",
    compress: compressRaw === "none" ? "none" : "zstd",
    maxDiskBytes: parseSizeBytes(raw.get("maxDiskBytes"), 120 * 1024 ** 3),
    diskCheckEveryBatches: parseIntArg(
      raw.get("diskCheckEveryBatches"),
      50,
      "diskCheckEveryBatches"
    ),
  };
}

async function resolveTasks(args: CliArgs): Promise<Task[]> {
  if (args.symbols?.length) {
    return args.symbols.map(instId => ({ instId }));
  }
  const payload = await readJsonFile<{ items?: CatalogItem[] }>(args.catalogPath, {});
  let items = (payload.items ?? []).filter(row => Boolean(row.instId));
  items = items.filter(row => {
    const type = (row.instType ?? "").toUpperCase();
    const matchType =
      args.instType === "all" ||
      (args.instType === "spot" && type === "SPOT") ||
      (args.instType === "swap" && type === "SWAP");
    if (!matchType) return false;
    if (!args.includeNotLive && row.state !== "live") return false;
    return true;
  });
  let instIds = items.map(row => row.instId).sort((a, b) => a.localeCompare(b));
  if (args.maxSymbols && instIds.length > args.maxSymbols) {
    instIds = instIds.slice(0, args.maxSymbols);
  }
  return instIds.map(instId => ({ instId }));
}

function stateKey(task: Task): string {
  return task.instId;
}

function shardPath(args: CliArgs, instId: string, day: string): string {
  return resolve(
    args.datasetRoot,
    "trades",
    sanitizeSegment(instId),
    `${day}.ndjson`
  );
}

async function ensureFile(path: string): Promise<void> {
  if (await fileExists(path)) return;
  await mkdir(resolve(path, ".."), { recursive: true });
  await appendFile(path, "");
}

async function fetchHistoryTrades(
  instId: string,
  after: string | undefined,
  limit: number,
  maxRetries: number
): Promise<TradeItem[]> {
  return withRetry(
    async () => {
      const url = new URL("https://www.okx.com/api/v5/market/history-trades");
      url.searchParams.set("instId", instId);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("type", "1");
      if (after) url.searchParams.set("after", after);
      const transport = (process.env.OKX_TRADES_HTTP ?? "curl").toLowerCase();
      const payload =
        transport === "fetch"
          ? await (async () => {
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
              return (await res.json()) as {
                code?: string;
                msg?: string;
                data?: TradeItem[];
              };
            })()
          : await fetchJsonViaCurl(url.toString());
      if (payload.code !== "0") {
        throw new Error(`code=${payload.code} msg=${payload.msg ?? ""}`);
      }
      return (payload.data ?? []).filter(row => Boolean(row.tradeId) && Boolean(row.ts));
    },
    {
      maxRetries,
      baseDelayMs: 700,
      label: `history-trades:${instId}:${after ?? "latest"}`,
    }
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

async function runTask(
  args: CliArgs,
  state: StatePayload,
  task: Task,
  persistState: PersistStateFn,
  progressLabel: string
): Promise<TaskResult> {
  const key = stateKey(task);
  const existing = state.items[key] ?? {};
  let after = args.append ? existing.after : undefined;
  let fetchedRows = 0;
  let writtenRows = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let oldestTsSeen: number | null = args.append ? existing.oldestTs ?? null : null;
  let batches = 0;
  const touched = new Set<string>();

  while (true) {
    const batch = await fetchHistoryTrades(
      task.instId,
      after,
      args.limit,
      args.maxRetries
    );
    if (!batch.length) break;
    fetchedRows += batch.length;
    batches += 1;

    let oldestTs = Number.POSITIVE_INFINITY;
    const acceptedByDay = new Map<string, string[]>();
    const tradeIds: number[] = [];

    for (const row of batch) {
      const ts = Number(row.ts);
      if (!Number.isFinite(ts)) continue;
      if (ts < oldestTs) oldestTs = ts;
      const tradeIdNum = Number(row.tradeId);
      if (Number.isFinite(tradeIdNum)) tradeIds.push(tradeIdNum);
      if (ts < args.startMs || ts > args.endMs) continue;
      const day = dayKey(ts);
      const line = JSON.stringify({
        tradeId: row.tradeId,
        ts: row.ts,
        px: row.px,
        sz: row.sz,
        side: row.side,
        instId: row.instId || task.instId,
      });
      const arr = acceptedByDay.get(day);
      if (arr) arr.push(line);
      else acceptedByDay.set(day, [line]);

      writtenRows += 1;
      if (firstTs == null || ts < firstTs) firstTs = ts;
      if (lastTs == null || ts > lastTs) lastTs = ts;
    }

    for (const [day, lines] of acceptedByDay.entries()) {
      const outPath = shardPath(args, task.instId, day);
      if (args.compress === "zstd") {
        await ensureCsvFromZst(outPath);
      }
      await ensureFile(outPath);
      await appendFile(outPath, `${lines.join("\n")}\n`);
      touched.add(outPath);
    }

    if (!Number.isFinite(oldestTs)) break;
    if (oldestTsSeen == null || oldestTs < oldestTsSeen) {
      oldestTsSeen = oldestTs;
    }
    if (oldestTs <= args.startMs) break;

    if (tradeIds.length > 0) {
      const nextAfter = String(Math.min(...tradeIds));
      if (nextAfter === after) {
        throw new Error(`cursor stalled at after=${after ?? "latest"}`);
      }
      after = nextAfter;
    }

    state.items[key] = {
      after,
      oldestTs: oldestTsSeen ?? undefined,
      completed: false,
      updatedAt: new Date().toISOString(),
    };
    await persistState();

    if (batches === 1 || batches % 25 === 0) {
      console.log(
        `${progressLabel}: progress batches=${batches} written=${writtenRows} fetched=${fetchedRows} oldest=${toIso(
          oldestTs
        )} after=${after ?? "latest"}`
      );
    }

    if (batches % args.diskCheckEveryBatches === 0) {
      await enforceDiskBudget(args);
    }
    if (args.sleepMs > 0) await sleep(args.sleepMs);
  }

  if (args.compress === "zstd") {
    for (const outPath of touched) {
      await compressCsvToZst(outPath);
    }
  }

  state.items[key] = {
    after,
    oldestTs: oldestTsSeen ?? undefined,
    completed: true,
    updatedAt: new Date().toISOString(),
  };
  await persistState();

  return {
    instId: task.instId,
    fetchedRows,
    writtenRows,
    touchedShards: touched.size,
    firstTs,
    lastTs,
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
  if (args.startMs >= args.endMs) {
    throw new Error("start must be earlier than end");
  }
  await mkdir(resolve(args.datasetRoot, "trades"), { recursive: true });
  await mkdir(resolve(args.datasetRoot, "state"), { recursive: true });
  await mkdir(resolve(args.datasetRoot, "reports"), { recursive: true });

  const tasks = await resolveTasks(args);
  if (!tasks.length) {
    throw new Error("No trades tasks resolved.");
  }
  console.log(
    `trades plan: symbols=${tasks.length}, workers=${args.workers}, window=[${toIso(
      args.startMs
    )} -> ${toIso(args.endMs)}], datasetRoot=${resolve(args.datasetRoot)}`
  );
  const startedAt = Date.now();
  const state = await readJsonFile<StatePayload>(args.statePath, {
    schemaVersion: "okx_trades_state.v1",
    updatedAt: new Date().toISOString(),
    items: {},
  });
  let persistChain = Promise.resolve();
  const persistState: PersistStateFn = async () => {
    state.updatedAt = new Date().toISOString();
    persistChain = persistChain.then(() => writeJsonFile(args.statePath, state));
    await persistChain;
  };
  await persistState();
  let haltedByDiskBudget = false;
  let haltError = "";
  const results = await withConcurrency(tasks, args.workers, async (task, idx) => {
    const prefix = `[${idx + 1}/${tasks.length}] ${task.instId}`;
    const existing = state.items[stateKey(task)];
    if (args.append && existing?.completed) {
      console.log(`${prefix}: skip (completed in state)`);
      return {
        instId: task.instId,
        fetchedRows: 0,
        writtenRows: 0,
        touchedShards: 0,
        firstTs: null,
        lastTs: null,
      } satisfies TaskResult;
    }
    try {
      console.log(`${prefix}: start`);
      const result = await runTask(args, state, task, persistState, prefix);
      console.log(
        `${prefix}: done written=${result.writtenRows} fetched=${result.fetchedRows} shards=${result.touchedShards}`
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof DiskBudgetExceeded) {
        haltedByDiskBudget = true;
        haltError = message;
      }
      state.items[stateKey(task)] = {
        ...(state.items[stateKey(task)] ?? {}),
        completed: false,
        error: message,
        updatedAt: new Date().toISOString(),
      };
      await persistState();
      console.error(`${prefix}: failed ${message}`);
      return {
        instId: task.instId,
        fetchedRows: 0,
        writtenRows: 0,
        touchedShards: 0,
        firstTs: null,
        lastTs: null,
        error: message,
      } satisfies TaskResult;
    }
  });

  await persistState();

  const totals = results.reduce(
    (acc, row) => {
      acc.fetchedRows += row.fetchedRows;
      acc.writtenRows += row.writtenRows;
      if (row.error) acc.failedTasks += 1;
      return acc;
    },
    { fetchedRows: 0, writtenRows: 0, failedTasks: 0 }
  );
  const used = await directorySizeBytes(args.datasetRoot);
  const summary = {
    schemaVersion: "okx_trades_summary.v1",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    params: {
      datasetRoot: resolve(args.datasetRoot),
      catalogPath: resolve(args.catalogPath),
      statePath: resolve(args.statePath),
      symbols: args.symbols ?? null,
      maxSymbols: args.maxSymbols ?? null,
      instType: args.instType,
      includeNotLive: args.includeNotLive,
      start: toIso(args.startMs),
      end: toIso(args.endMs),
      limit: args.limit,
      maxRetries: args.maxRetries,
      sleepMs: args.sleepMs,
      workers: args.workers,
      append: args.append,
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
    const pending = tasks
      .map(task => task.instId)
      .filter(instId => !state.items[instId]?.completed);
    await writeJsonFile(resolve(args.reportDir, "trades_pending_queue.v1.json"), {
      schemaVersion: "okx_trades_pending_queue.v1",
      generatedAt: new Date().toISOString(),
      pendingCount: pending.length,
      pending,
    });
    process.exitCode = 2;
    return;
  }

  console.log(
    `trades complete: written=${totals.writtenRows}, fetched=${totals.fetchedRows}, failed=${totals.failedTasks}, used=${bytesToHuman(
      used
    )}`
  );
  console.log(`summary saved: ${resolve(args.summaryPath)}`);
}

main().catch(err => {
  console.error("okx_download_trades failed:", err);
  process.exit(1);
});
