import ccxt from "ccxt";
import { mkdir, rename, stat, writeFile } from "fs/promises";
import { createWriteStream } from "fs";
import { resolve } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { spawn } from "child_process";

type MarketMode = "spot" | "um" | "both";
type SourceMode = "okx-usdt" | "binance-all-usdt" | "symbols";

type CliArgs = {
  market: MarketMode;
  source: SourceMode;
  symbols?: string[];
  timeframe: string;
  startMonth: string;
  endMonth: string;
  outDir: string;
  quote: string;
  includeInactiveOkx: boolean;
  maxSymbols?: number;
  maxMonths?: number;
  concurrency: number;
  maxRetries: number;
  sleepMs: number;
  extract: boolean;
  skipExisting: boolean;
};

type DownloadStatus = "downloaded" | "exists" | "missing" | "failed";

type DownloadRecord = {
  market: "spot" | "um";
  symbol: string;
  month: string;
  zipPath: string;
  csvPath?: string;
  status: DownloadStatus;
  httpStatus?: number;
  error?: string;
};

function parseRawArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const maybeVal = argv[i + 1];
    if (!maybeVal || maybeVal.startsWith("--")) {
      map.set(key, "true");
      continue;
    }
    map.set(key, maybeVal);
    i += 1;
  }
  return map;
}

function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const out = raw
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const val = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(val)) return true;
  if (["0", "false", "no", "n", "off"].includes(val)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

function parseIntArg(
  raw: string | undefined,
  fallback: number,
  label: string
): number {
  if (raw == null) return fallback;
  const val = Number(raw);
  if (!Number.isFinite(val) || !Number.isInteger(val) || val <= 0) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return val;
}

function normalizeTimeframe(tf: string): string {
  const lower = tf.toLowerCase();
  const m = lower.match(/^(\d+)(m|h|d|w|mo)$/);
  if (!m) {
    throw new Error(`Unsupported timeframe: ${tf}`);
  }
  const num = m[1];
  const unit = m[2];
  if (unit === "mo") return `${num}mo`;
  return `${num}${unit}`;
}

function normalizeMonth(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) {
    throw new Error(`Invalid month format '${month}', expected YYYY-MM`);
  }
  const y = Number(m[1]);
  const mm = Number(m[2]);
  if (y < 2010 || mm < 1 || mm > 12) {
    throw new Error(`Invalid month value: ${month}`);
  }
  return `${String(y).padStart(4, "0")}-${String(mm).padStart(2, "0")}`;
}

function monthToNumber(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return y * 12 + (m - 1);
}

function monthRange(startMonth: string, endMonth: string): string[] {
  const s = monthToNumber(startMonth);
  const e = monthToNumber(endMonth);
  if (s > e) throw new Error("startMonth must be <= endMonth");
  const out: string[] = [];
  for (let v = s; v <= e; v += 1) {
    const y = Math.floor(v / 12);
    const m = (v % 12) + 1;
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

function nowMonthUtc(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => {
    setTimeout(resolvePromise, ms);
  });
}

function printHelp(): void {
  console.log(`Usage:
  pnpm data:download:binance -- [options]

Options:
  --market both                 spot | um | both (default: both)
  --source okx-usdt             okx-usdt | binance-all-usdt | symbols
  --symbols BTCUSDT,ETHUSDT     Required when --source symbols
  --quote USDT                  Quote filter for source modes (default: USDT)
  --timeframe 1d                Kline timeframe (default: 1d)
  --startMonth 2018-01          Start month inclusive (YYYY-MM)
  --endMonth 2026-02            End month inclusive (default: current UTC month)
  --outDir data/market/binance-public
  --includeInactiveOkx true     Include inactive OKX markets when source=okx-usdt
  --maxSymbols 100              Limit symbols for smoke test
  --maxMonths 12                Limit months for smoke test
  --concurrency 4               Concurrent downloads
  --maxRetries 3                Retry count per file
  --sleepMs 30                  Delay between downloads in each worker
  --extract false               Also extract ZIP to CSV via unzip -p
  --skipExisting true           Skip existing ZIP file

Examples:
  pnpm data:download:binance -- --source okx-usdt --market both --timeframe 1d --startMonth 2020-01
  pnpm data:download:binance -- --source binance-all-usdt --market um --timeframe 1d --startMonth 2019-09 --maxSymbols 200
  pnpm data:download:binance -- --source symbols --symbols BTCUSDT,ETHUSDT --market spot --timeframe 1h --startMonth 2024-01 --endMonth 2024-12`);
}

function parseCliArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }

  const marketRaw = (raw.get("market") ?? "both").toLowerCase();
  const market = marketRaw as MarketMode;
  if (market !== "spot" && market !== "um" && market !== "both") {
    throw new Error(`Invalid --market: ${marketRaw}`);
  }

  const sourceRaw = (raw.get("source") ?? "okx-usdt").toLowerCase();
  const source = sourceRaw as SourceMode;
  if (
    source !== "okx-usdt" &&
    source !== "binance-all-usdt" &&
    source !== "symbols"
  ) {
    throw new Error(`Invalid --source: ${sourceRaw}`);
  }

  const symbols = parseList(raw.get("symbols"))?.map(s => s.toUpperCase());
  if (source === "symbols" && !symbols?.length) {
    throw new Error("--symbols is required when --source symbols");
  }

  const timeframe = normalizeTimeframe(raw.get("timeframe") ?? "1d");
  const startMonth = normalizeMonth(raw.get("startMonth") ?? "2018-01");
  const endMonth = normalizeMonth(raw.get("endMonth") ?? nowMonthUtc());

  return {
    market,
    source,
    symbols,
    timeframe,
    startMonth,
    endMonth,
    outDir: raw.get("outDir") ?? "data/market/binance-public",
    quote: (raw.get("quote") ?? "USDT").toUpperCase(),
    includeInactiveOkx: parseBoolean(raw.get("includeInactiveOkx"), true),
    maxSymbols: raw.get("maxSymbols")
      ? parseIntArg(raw.get("maxSymbols"), 0, "maxSymbols")
      : undefined,
    maxMonths: raw.get("maxMonths")
      ? parseIntArg(raw.get("maxMonths"), 0, "maxMonths")
      : undefined,
    concurrency: parseIntArg(raw.get("concurrency"), 4, "concurrency"),
    maxRetries: parseIntArg(raw.get("maxRetries"), 3, "maxRetries"),
    sleepMs: parseIntArg(raw.get("sleepMs"), 30, "sleepMs"),
    extract: parseBoolean(raw.get("extract"), false),
    skipExisting: parseBoolean(raw.get("skipExisting"), true),
  };
}

function isTruncated(xml: string): boolean {
  return /<IsTruncated>true<\/IsTruncated>/.test(xml);
}

function readTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m?.[1] ?? null;
}

function readAllPrefixTags(xml: string): string[] {
  const out: string[] = [];
  const reg = /<Prefix>([^<]+)<\/Prefix>/g;
  let m: RegExpExecArray | null;
  while ((m = reg.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

async function listS3Prefixes(basePrefix: string): Promise<string[]> {
  const endpoint =
    "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
  const prefixes: string[] = [];
  let marker: string | undefined;

  while (true) {
    const url = new URL(endpoint);
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("prefix", basePrefix);
    if (marker) url.searchParams.set("marker", marker);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`S3 list failed ${res.status}: ${url.toString()}`);
    }
    const xml = await res.text();
    const pagePrefixes = readAllPrefixTags(xml).filter(p => p !== basePrefix);
    prefixes.push(...pagePrefixes);

    if (!isTruncated(xml)) break;
    const nextMarker = readTag(xml, "NextMarker");
    if (!nextMarker) break;
    marker = nextMarker;
  }

  return uniq(prefixes);
}

async function listBinanceSymbolsByMarket(
  market: "spot" | "um"
): Promise<string[]> {
  const basePrefix =
    market === "spot"
      ? "data/spot/monthly/klines/"
      : "data/futures/um/monthly/klines/";
  const prefixes = await listS3Prefixes(basePrefix);
  const symbols: string[] = [];
  const matcher =
    market === "spot"
      ? /^data\/spot\/monthly\/klines\/([^/]+)\/$/
      : /^data\/futures\/um\/monthly\/klines\/([^/]+)\/$/;

  for (const p of prefixes) {
    const m = p.match(matcher);
    if (m?.[1]) symbols.push(m[1].toUpperCase());
  }
  return uniq(symbols).sort((a, b) => a.localeCompare(b));
}

async function loadOkxUsdtSymbols(
  includeInactive: boolean,
  quote: string
): Promise<string[]> {
  const ex = new ccxt.okx({
    enableRateLimit: true,
    timeout: 30_000,
    options: {
      fetchMarkets: { types: ["spot", "swap"] },
    },
  });

  try {
    await ex.loadMarkets(true);
    const markets = Object.values(ex.markets ?? {}) as Array<{
      type?: string;
      base?: string;
      quote?: string;
      settle?: string;
      active?: boolean;
    }>;
    const wanted = markets.filter(m => {
      const tradableType =
        m.type === "spot" || m.type === "swap" || m.type === "future";
      if (!tradableType) return false;
      if (!includeInactive && m.active === false) return false;
      const quoted = m.quote === quote || m.settle === quote;
      if (!quoted) return false;
      if (!m.base) return false;
      return true;
    });
    return uniq(
      wanted.map(m => `${String(m.base).toUpperCase()}${quote}`).filter(Boolean)
    ).sort((a, b) => a.localeCompare(b));
  } finally {
    await ex.close();
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function buildBinanceZipUrl(
  market: "spot" | "um",
  symbol: string,
  timeframe: string,
  month: string
): string {
  const root =
    market === "spot"
      ? "https://data.binance.vision/data/spot/monthly/klines"
      : "https://data.binance.vision/data/futures/um/monthly/klines";
  return `${root}/${symbol}/${timeframe}/${symbol}-${timeframe}-${month}.zip`;
}

async function downloadZipFile(
  url: string,
  zipPath: string,
  maxRetries: number
): Promise<{ status: DownloadStatus; httpStatus?: number; error?: string }> {
  let lastError: unknown;
  let backoffMs = 1_000;
  for (let i = 1; i <= maxRetries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return { status: "missing", httpStatus: 404 };
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      const tmp = `${zipPath}.tmp`;
      await mkdir(resolve(zipPath, ".."), { recursive: true });
      await pipeline(
        Readable.fromWeb(res.body as unknown as ReadableStream),
        createWriteStream(tmp)
      );
      await rename(tmp, zipPath);
      return { status: "downloaded", httpStatus: res.status };
    } catch (err) {
      lastError = err;
      if (i >= maxRetries) break;
      await sleep(backoffMs);
      backoffMs *= 2;
    }
  }
  return {
    status: "failed",
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

async function unzipToCsv(zipPath: string, csvPath: string): Promise<void> {
  await mkdir(resolve(csvPath, ".."), { recursive: true });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn("unzip", ["-p", zipPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = createWriteStream(csvPath);
    let stderr = "";
    proc.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    proc.stdout.pipe(out);
    proc.on("error", rejectPromise);
    proc.on("close", code => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(`unzip failed (code=${code}): ${stderr || "unknown error"}`)
        );
      }
    });
  });
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
    { length: Math.min(concurrency, items.length) },
    () => runOne()
  );
  await Promise.all(workers);
  return out;
}

type Task = {
  market: "spot" | "um";
  symbol: string;
  month: string;
  url: string;
  zipPath: string;
  csvPath: string;
};

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  console.log(
    `binance download config: market=${args.market}, source=${args.source}, timeframe=${args.timeframe}, range=[${args.startMonth}..${args.endMonth}]`
  );

  const markets: Array<"spot" | "um"> =
    args.market === "both" ? ["spot", "um"] : [args.market];

  const availableByMarket = new Map<"spot" | "um", Set<string>>();
  for (const market of markets) {
    const symbols = await listBinanceSymbolsByMarket(market);
    availableByMarket.set(market, new Set(symbols));
    console.log(`${market} available symbols: ${symbols.length}`);
  }

  let targetSymbols: string[] = [];
  if (args.source === "symbols") {
    targetSymbols = args.symbols ?? [];
  } else if (args.source === "okx-usdt") {
    targetSymbols = await loadOkxUsdtSymbols(
      args.includeInactiveOkx,
      args.quote
    );
  } else {
    const union = new Set<string>();
    for (const set of availableByMarket.values()) {
      for (const s of set) {
        if (s.endsWith(args.quote)) union.add(s);
      }
    }
    targetSymbols = Array.from(union).sort((a, b) => a.localeCompare(b));
  }

  targetSymbols = targetSymbols.filter(s => s.endsWith(args.quote));
  targetSymbols = uniq(targetSymbols).sort((a, b) => a.localeCompare(b));
  if (args.maxSymbols && targetSymbols.length > args.maxSymbols) {
    targetSymbols = targetSymbols.slice(0, args.maxSymbols);
  }
  if (!targetSymbols.length) {
    throw new Error("No target symbols after filtering");
  }

  const months = monthRange(args.startMonth, args.endMonth);
  const finalMonths = args.maxMonths ? months.slice(0, args.maxMonths) : months;

  const tasks: Task[] = [];
  const unavailableByMarket: Record<string, number> = {};
  for (const market of markets) {
    const avail = availableByMarket.get(market) ?? new Set<string>();
    for (const symbol of targetSymbols) {
      if (!avail.has(symbol)) {
        unavailableByMarket[market] = (unavailableByMarket[market] ?? 0) + 1;
        continue;
      }
      for (const month of finalMonths) {
        const zipPath = resolve(
          args.outDir,
          market,
          symbol,
          args.timeframe,
          `${symbol}-${args.timeframe}-${month}.zip`
        );
        const csvPath = resolve(
          args.outDir,
          market,
          symbol,
          args.timeframe,
          `${symbol}-${args.timeframe}-${month}.csv`
        );
        tasks.push({
          market,
          symbol,
          month,
          url: buildBinanceZipUrl(market, symbol, args.timeframe, month),
          zipPath,
          csvPath,
        });
      }
    }
  }

  console.log(
    `download plan: symbols=${targetSymbols.length}, markets=${markets.join(",")}, months=${finalMonths.length}, files=${tasks.length}`
  );

  let completed = 0;
  const progress = {
    downloaded: 0,
    exists: 0,
    missing: 0,
    failed: 0,
  };
  const progressEvery = Math.max(1, Math.floor(tasks.length / 40));
  const bumpProgress = (status: DownloadStatus) => {
    completed += 1;
    progress[status] += 1;
    if (completed % progressEvery === 0 || completed === tasks.length) {
      const pct = ((completed / tasks.length) * 100).toFixed(1);
      console.log(
        `progress ${completed}/${tasks.length} (${pct}%) d=${progress.downloaded} e=${progress.exists} m=${progress.missing} f=${progress.failed}`
      );
    }
  };

  const records = await withConcurrency(
    tasks,
    args.concurrency,
    async (task, idx) => {
      const prefix = `[${idx + 1}/${tasks.length}] ${task.market} ${task.symbol} ${task.month}`;
      try {
        if (args.skipExisting && (await fileExists(task.zipPath))) {
          if (args.extract && !(await fileExists(task.csvPath))) {
            await unzipToCsv(task.zipPath, task.csvPath);
          }
          if (args.sleepMs > 0) await sleep(args.sleepMs);
          const rec = {
            market: task.market,
            symbol: task.symbol,
            month: task.month,
            zipPath: task.zipPath,
            csvPath: args.extract ? task.csvPath : undefined,
            status: "exists" as const,
          } satisfies DownloadRecord;
          bumpProgress(rec.status);
          return rec;
        }

        const res = await downloadZipFile(
          task.url,
          task.zipPath,
          args.maxRetries
        );
        if (res.status === "downloaded" && args.extract) {
          await unzipToCsv(task.zipPath, task.csvPath);
        }
        if (args.sleepMs > 0) await sleep(args.sleepMs);
        if (res.status === "failed") {
          console.warn(`${prefix} failed: ${res.error}`);
        }
        const rec = {
          market: task.market,
          symbol: task.symbol,
          month: task.month,
          zipPath: task.zipPath,
          csvPath: args.extract ? task.csvPath : undefined,
          status: res.status,
          httpStatus: res.httpStatus,
          error: res.error,
        } satisfies DownloadRecord;
        bumpProgress(rec.status);
        return rec;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`${prefix} failed: ${message}`);
        const rec = {
          market: task.market,
          symbol: task.symbol,
          month: task.month,
          zipPath: task.zipPath,
          csvPath: args.extract ? task.csvPath : undefined,
          status: "failed",
          error: message,
        } satisfies DownloadRecord;
        bumpProgress(rec.status);
        return rec;
      }
    }
  );

  const totals = records.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<DownloadStatus, number>
  );

  const summary = {
    startedAt,
    endedAt: new Date().toISOString(),
    args,
    targetSymbols: targetSymbols.length,
    months: finalMonths.length,
    unavailableByMarket,
    files: tasks.length,
    totals,
    sampleFailures: records.filter(r => r.status === "failed").slice(0, 30),
  };

  const summaryPath = resolve(args.outDir, "summary.binance-download.json");
  await mkdir(args.outDir, { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `done: downloaded=${totals.downloaded ?? 0}, exists=${totals.exists ?? 0}, missing=${totals.missing ?? 0}, failed=${totals.failed ?? 0}`
  );
  console.log(`summary saved: ${summaryPath}`);
}

main().catch(err => {
  console.error("binance_public_download_klines failed:", err);
  process.exit(1);
});
