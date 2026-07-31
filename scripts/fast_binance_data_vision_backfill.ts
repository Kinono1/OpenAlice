import { createHash } from "crypto";
import { createReadStream, createWriteStream, type Dirent } from "fs";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { basename, resolve } from "path";
import { createInterface } from "readline";
import { pathToFileURL } from "url";

type Market = "spot" | "um";
type DiscoveryMode = "s3" | "probe";
type DataType =
  | "klines"
  | "trades"
  | "aggTrades"
  | "bookTicker"
  | "fundingRate"
  | "indexPriceKlines"
  | "markPriceKlines"
  | "premiumIndexKlines";
type Status = "downloaded" | "exists" | "missing" | "failed";

type Args = {
  market: Market;
  dataType: DataType;
  quote: string;
  symbols?: string[];
  timeframe: string;
  startMonth: string;
  endMonth: string;
  outDir: string;
  proxy?: string;
  networkInterface?: string;
  dataEndpoint: string;
  s3Endpoint: string;
  discovery: DiscoveryMode;
  symbolSourceDir?: string;
  listConcurrency: number;
  concurrency: number;
  maxRetries: number;
  connectTimeoutSec: number;
  listMaxTimeSec: number;
  downloadMaxTimeSec: number;
  maxSymbols?: number;
  maxTasks?: number;
  skipExisting: boolean;
  retryManifest?: string;
  manifestPath?: string;
  summaryPath?: string;
};

type ZipEntry = {
  market: Market;
  dataType: DataType;
  symbol: string;
  month: string;
  key: string;
};

type Task = ZipEntry & {
  url: string;
  zipPath: string;
};

export type RecordLine = Task & {
  status: Status;
  httpStatus?: number;
  error?: string;
};

type ArchiveLineageStatus = "available" | "local_file_observed" | "missing" | "failed";

export type DownloadManifestRecordV2 = RecordLine & {
  schemaVersion: "openalice.binance_data_vision.download_manifest.v2";
  generatedAt: string;
  jobId: string;
  collectionRunId: string;
  collectorObservedAt: string;
  observedAt: string;
  fetchedAt: string | null;
  availableAt: string | null;
  archiveFileAvailableAt: string | null;
  archiveLineageStatus: ArchiveLineageStatus;
  sourceEndpoint: string;
  sourceUrl: string;
  sourcePath: string;
  sourceManifestId: string;
  sourceRowHash: string;
  sourceRowHashScope: "archive_manifest_record";
  lineageScope: "archive_file";
  pitSuitability: "archive_download_lineage_only_not_row_pit";
  rowPITUsableForPromotion: false;
};

export type DownloadManifestContext = {
  generatedAt?: string;
  jobId: string;
  collectionRunId: string;
};

const S3_ENDPOINT = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
const DATA_ENDPOINT = "https://data.binance.vision";
const MANIFEST_SCHEMA_VERSION = "openalice.binance_data_vision.download_manifest.v2" as const;

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
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

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

function parseIntArg(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid --${name}: ${raw}`);
  }
  return value;
}

function parseOptionalInt(raw: string | undefined, name: string): number | undefined {
  if (raw == null) return undefined;
  return parseIntArg(raw, 1, name);
}

function parseList(raw: string | undefined): string[] | undefined {
  const values = raw
    ?.split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => value.toUpperCase());
  return values?.length ? Array.from(new Set(values)) : undefined;
}

function parseProxy(raw: string | undefined, fallback: string | undefined): string | undefined {
  if (raw == null) return fallback;
  const value = raw.trim();
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["0", "false", "no", "none", "direct", "off", "true"].includes(normalized)) {
    return undefined;
  }
  return value;
}

function parseInterface(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["0", "false", "no", "none", "direct", "off"].includes(normalized)) return undefined;
  return value;
}

function parseDiscoveryMode(raw: string | undefined): DiscoveryMode {
  const value = (raw ?? "s3").trim().toLowerCase();
  if (value === "s3" || value === "probe") return value;
  throw new Error(`Invalid --discovery: ${raw}`);
}

function parseEndpoint(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  if (!value) return fallback;
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeMonth(raw: string): string {
  const match = raw.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error(`Invalid month '${raw}', expected YYYY-MM`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2010 || month < 1 || month > 12) {
    throw new Error(`Invalid month '${raw}'`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function nowMonthUtc(): string {
  const now = new Date();
  return `${String(now.getUTCFullYear()).padStart(4, "0")}-${String(
    now.getUTCMonth() + 1
  ).padStart(2, "0")}`;
}

function monthNumber(month: string): number {
  const [year, rawMonth] = month.split("-").map(Number);
  return year * 12 + rawMonth - 1;
}

function monthRange(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  for (let value = monthNumber(startMonth); value <= monthNumber(endMonth); value += 1) {
    const year = Math.floor(value / 12);
    const month = (value % 12) + 1;
    months.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
  }
  return months;
}

function normalizeDataType(raw: string): DataType {
  if (
    raw === "klines" ||
    raw === "trades" ||
    raw === "aggTrades" ||
    raw === "bookTicker" ||
    raw === "fundingRate" ||
    raw === "indexPriceKlines" ||
    raw === "markPriceKlines" ||
    raw === "premiumIndexKlines"
  ) {
    return raw;
  }
  if (raw.toLowerCase() === "aggtrades") return "aggTrades";
  if (raw.toLowerCase() === "bookticker") return "bookTicker";
  if (raw.toLowerCase() === "fundingrate") return "fundingRate";
  if (raw.toLowerCase() === "indexpriceklines") return "indexPriceKlines";
  if (raw.toLowerCase() === "markpriceklines") return "markPriceKlines";
  if (raw.toLowerCase() === "premiumindexklines") return "premiumIndexKlines";
  throw new Error(`Invalid --dataType: ${raw}`);
}

function dataTypeRequiresUm(dataType: DataType): boolean {
  return (
    dataType === "bookTicker" ||
    dataType === "fundingRate" ||
    dataType === "indexPriceKlines" ||
    dataType === "markPriceKlines" ||
    dataType === "premiumIndexKlines"
  );
}

export function dataTypeUsesTimeframe(dataType: DataType): boolean {
  return dataType === "klines" || dataType.endsWith("PriceKlines") || dataType === "premiumIndexKlines";
}

function printHelp(): void {
  console.log(`Usage:
  tsx scripts/fast_binance_data_vision_backfill.ts --market spot --dataType klines --timeframe 1d --startMonth 2017-08 --outDir /Volumes/shield/cryptoData/openalice-data/market/binance-public/spot-all-usdt-klines-1d

Options:
  --market spot                 spot | um
  --dataType klines             klines | trades | aggTrades | bookTicker | fundingRate | indexPriceKlines | markPriceKlines | premiumIndexKlines
  --symbols BTCUSDT,ETHUSDT     Optional explicit symbols; otherwise all quote symbols are discovered
  --quote USDT                  Quote suffix filter
  --timeframe 1d                Required for klines
  --startMonth 2017-08          Start month inclusive
  --endMonth 2026-05            End month inclusive; defaults to current UTC month
  --outDir <path>               Output directory
  --proxy http://127.0.0.1:7890 Explicit curl proxy; omitted means direct/no proxy
  --interface en0               Optional curl interface binding to avoid VPN/tunnel routes
  --dataEndpoint <url>          Data zip endpoint; defaults to ${DATA_ENDPOINT}
  --s3Endpoint <url>            S3 listing endpoint; defaults to ${S3_ENDPOINT}
  --discovery s3                s3 | probe. probe uses data.binance.vision HEAD requests instead of S3 XML listing
  --symbolSourceDir <path>      Optional local completed klines-1d dataset for probe symbol discovery
  --listConcurrency 16          Concurrent S3 key-list requests
  --concurrency 32              Concurrent zip downloads
  --maxRetries 5                Retries per request
  --connectTimeoutSec 10        Curl connect timeout
  --listMaxTimeSec 60           Curl max time for S3 list requests
  --downloadMaxTimeSec 120      Curl max time for zip downloads
  --maxSymbols 10               Smoke-test limit
  --maxTasks 100                Smoke-test limit
  --retryManifest <path>        Download only failed records from a prior manifest JSONL
  --manifestPath <path>         Optional manifest JSONL output path; defaults under outDir
  --summaryPath <path>          Optional summary JSON output path; defaults under outDir
  --skipExisting true           Skip existing non-empty zip files`);
}

function parseArgs(argv: string[]): Args {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }
  const market = (raw.get("market") ?? "spot").toLowerCase();
  if (market !== "spot" && market !== "um") {
    throw new Error(`Invalid --market: ${raw.get("market")}`);
  }
  const dataType = normalizeDataType(raw.get("dataType") ?? "klines");
  if (market === "spot" && dataTypeRequiresUm(dataType)) {
    throw new Error(`--dataType ${dataType} is only available for --market um`);
  }
  return {
    market,
    dataType,
    quote: (raw.get("quote") ?? "USDT").toUpperCase(),
    symbols: parseList(raw.get("symbols")),
    timeframe: raw.get("timeframe") ?? "1d",
    startMonth: normalizeMonth(raw.get("startMonth") ?? "2017-08"),
    endMonth: normalizeMonth(raw.get("endMonth") ?? nowMonthUtc()),
    outDir: resolve(raw.get("outDir") ?? "data/market/binance-public"),
    proxy: parseProxy(raw.get("proxy"), undefined),
    networkInterface: parseInterface(raw.get("interface") ?? process.env.BINANCE_BACKFILL_INTERFACE ?? "en0"),
    dataEndpoint: parseEndpoint(raw.get("dataEndpoint") ?? process.env.BINANCE_BACKFILL_DATA_ENDPOINT, DATA_ENDPOINT),
    s3Endpoint: parseEndpoint(raw.get("s3Endpoint") ?? process.env.BINANCE_BACKFILL_S3_ENDPOINT, S3_ENDPOINT),
    discovery: parseDiscoveryMode(raw.get("discovery") ?? process.env.BINANCE_BACKFILL_DISCOVERY),
    symbolSourceDir: raw.get("symbolSourceDir") ? resolve(raw.get("symbolSourceDir") ?? "") : undefined,
    listConcurrency: parseIntArg(raw.get("listConcurrency"), 16, "listConcurrency"),
    concurrency: parseIntArg(raw.get("concurrency"), 32, "concurrency"),
    maxRetries: parseIntArg(raw.get("maxRetries"), 5, "maxRetries"),
    connectTimeoutSec: parseIntArg(raw.get("connectTimeoutSec"), 10, "connectTimeoutSec"),
    listMaxTimeSec: parseIntArg(raw.get("listMaxTimeSec"), 60, "listMaxTimeSec"),
    downloadMaxTimeSec: parseIntArg(raw.get("downloadMaxTimeSec"), 120, "downloadMaxTimeSec"),
    maxSymbols: parseOptionalInt(raw.get("maxSymbols"), "maxSymbols"),
    maxTasks: parseOptionalInt(raw.get("maxTasks"), "maxTasks"),
    skipExisting: parseBoolean(raw.get("skipExisting"), true),
    retryManifest: raw.has("retryManifest") ? resolve(raw.get("retryManifest") ?? "") : undefined,
    manifestPath: raw.has("manifestPath") ? resolve(raw.get("manifestPath") ?? "") : undefined,
    summaryPath: raw.has("summaryPath") ? resolve(raw.get("summaryPath") ?? "") : undefined,
  };
}

function marketPrefix(market: Market): string {
  return market === "spot" ? "data/spot" : "data/futures/um";
}

function monthlyDataPrefix(args: Pick<Args, "market" | "dataType" | "timeframe">): string {
  return `${marketPrefix(args.market)}/monthly/${args.dataType}/`;
}

function symbolPrefix(args: Pick<Args, "market" | "dataType" | "timeframe">, symbol: string): string {
  const root = `${marketPrefix(args.market)}/monthly/${args.dataType}/${symbol}`;
  return dataTypeUsesTimeframe(args.dataType) ? `${root}/${args.timeframe}/` : `${root}/`;
}

function readAllTags(xml: string, tag: string): string[] {
  const values: string[] = [];
  const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    values.push(match[1]);
  }
  return values;
}

function readTag(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1];
}

function isTruncated(xml: string): boolean {
  return /<IsTruncated>true<\/IsTruncated>/.test(xml);
}

function curlArgs(args: Args, url: string, maxTimeSec: number): string[] {
  const out = [
    "-L",
    "--silent",
    "--show-error",
    "--connect-timeout",
    String(args.connectTimeoutSec),
    "--max-time",
    String(maxTimeSec),
  ];
  if (args.proxy) out.push("--proxy", args.proxy);
  else out.push("--noproxy", "*");
  if (args.networkInterface) out.push("--interface", args.networkInterface);
  out.push(url);
  return out;
}

async function curlText(args: Args, url: string, label: string, maxTimeSec: number): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= args.maxRetries; attempt += 1) {
    try {
      return await new Promise<string>((resolvePromise, rejectPromise) => {
        const proc = spawn("curl", curlArgs(args, url, maxTimeSec), {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            http_proxy: "",
            https_proxy: "",
            all_proxy: "",
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
          },
        });
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
          if (code === 0) resolvePromise(stdout);
          else rejectPromise(new Error(`curl code=${code}: ${stderr.trim() || "unknown error"}`));
        });
      });
    } catch (err) {
      lastError = err;
      if (attempt >= args.maxRetries) break;
      console.warn(`${label} attempt ${attempt}/${args.maxRetries} failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(Math.min(10_000, 750 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function curlHeadArgs(args: Args, url: string, maxTimeSec: number): string[] {
  const out = [
    "-L",
    "--head",
    "--silent",
    "--show-error",
    "--connect-timeout",
    String(args.connectTimeoutSec),
    "--max-time",
    String(maxTimeSec),
  ];
  if (args.proxy) out.push("--proxy", args.proxy);
  else out.push("--noproxy", "*");
  if (args.networkInterface) out.push("--interface", args.networkInterface);
  out.push("--output", "/dev/null", "--write-out", "%{http_code}", url);
  return out;
}

async function curlHeadStatus(args: Args, url: string): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const proc = spawn("curl", curlHeadArgs(args, url, args.listMaxTimeSec), {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
      },
    });
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
      const status = Number(stdout.trim());
      if (code === 0 && Number.isInteger(status)) {
        resolvePromise(status);
        return;
      }
      rejectPromise(new Error(`curl code=${code} http=${stdout.trim() || "unknown"} ${stderr.trim()}`));
    });
  });
}

async function listS3Prefixes(args: Args, basePrefix: string): Promise<string[]> {
  const prefixes: string[] = [];
  let marker: string | undefined;
  while (true) {
    const url = new URL(args.s3Endpoint);
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("prefix", basePrefix);
    if (marker) url.searchParams.set("marker", marker);
    const xml = await curlText(args, url.toString(), `S3 prefixes ${basePrefix}`, args.listMaxTimeSec);
    prefixes.push(...readAllTags(xml, "Prefix").filter(prefix => prefix !== basePrefix));
    if (!isTruncated(xml)) break;
    marker = readTag(xml, "NextMarker");
    if (!marker) break;
  }
  return Array.from(new Set(prefixes));
}

async function listS3Keys(args: Args, basePrefix: string): Promise<string[]> {
  const keys: string[] = [];
  let marker: string | undefined;
  while (true) {
    const url = new URL(args.s3Endpoint);
    url.searchParams.set("prefix", basePrefix);
    if (marker) url.searchParams.set("marker", marker);
    const xml = await curlText(args, url.toString(), `S3 keys ${basePrefix}`, args.listMaxTimeSec);
    const pageKeys = readAllTags(xml, "Key");
    keys.push(...pageKeys);
    if (!isTruncated(xml)) break;
    marker = readTag(xml, "NextMarker") ?? pageKeys.at(-1);
    if (!marker) break;
  }
  return Array.from(new Set(keys));
}

async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function parseEntry(args: Args, key: string): ZipEntry | undefined {
  if (!key.endsWith(".zip")) return undefined;
  const parts = key.split("/");
  const file = parts.at(-1);
  if (!file) return undefined;
  const month = file.match(/-(\d{4}-\d{2})\.zip$/)?.[1];
  if (!month) return undefined;
  const monthValue = monthNumber(month);
  if (monthValue < monthNumber(args.startMonth) || monthValue > monthNumber(args.endMonth)) {
    return undefined;
  }
  const symbol = dataTypeUsesTimeframe(args.dataType) ? parts.at(-3) : parts.at(-2);
  if (!symbol) return undefined;
  return {
    market: args.market,
    dataType: args.dataType,
    symbol: symbol.toUpperCase(),
    month,
    key,
  };
}

export function fileNameForCandidate(args: Pick<Args, "dataType" | "timeframe">, symbol: string, month: string): string {
  if (dataTypeUsesTimeframe(args.dataType)) {
    return `${symbol}-${args.timeframe}-${month}.zip`;
  }
  return `${symbol}-${args.dataType}-${month}.zip`;
}

export function candidateEntry(
  args: Pick<Args, "market" | "dataType" | "timeframe" | "startMonth" | "endMonth">,
  symbol: string,
  month: string,
): ZipEntry {
  const key = `${symbolPrefix(args, symbol)}${fileNameForCandidate(args, symbol, month)}`;
  return {
    market: args.market,
    dataType: args.dataType,
    symbol,
    month,
    key,
  };
}

function outputPath(args: Args, entry: ZipEntry): string {
  const file = basename(entry.key);
  if (args.dataType === "klines") {
    return resolve(args.outDir, args.market, entry.symbol, args.timeframe, file);
  }
  if (dataTypeUsesTimeframe(args.dataType)) {
    return resolve(args.outDir, args.market, args.dataType, entry.symbol, args.timeframe, file);
  }
  return resolve(args.outDir, args.market, args.dataType, entry.symbol, file);
}

function taskFromEntry(args: Args, entry: ZipEntry): Task {
  return {
    ...entry,
    url: `${args.dataEndpoint}/${entry.key.split("/").map(encodeURIComponent).join("/")}`,
    zipPath: outputPath(args, entry),
  };
}

async function nonEmptyFileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function fileSizeIfExists(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function discoverSymbols(args: Args): Promise<string[]> {
  if (args.symbols?.length) return args.symbols;
  if (args.discovery === "probe") return discoverSymbolsFromLocalKlines(args);
  const prefix = monthlyDataPrefix(args);
  const prefixes = await listS3Prefixes(args, prefix);
  const symbols = prefixes
    .map(value => value.slice(prefix.length).replace(/\/$/, "").toUpperCase())
    .filter(symbol => symbol.endsWith(args.quote));
  const unique = Array.from(new Set(symbols)).sort((a, b) => a.localeCompare(b));
  return args.maxSymbols ? unique.slice(0, args.maxSymbols) : unique;
}

function defaultSymbolSourceDir(args: Args): string {
  return resolve(args.outDir, "..", `${args.market}-all-${args.quote.toLowerCase()}-klines-1d`);
}

async function discoverSymbolsFromLocalKlines(args: Args): Promise<string[]> {
  const sourceDir = args.symbolSourceDir ?? defaultSymbolSourceDir(args);
  const marketDir = resolve(sourceDir, args.market);
  let entries: Dirent[];
  try {
    entries = await readdir(marketDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `probe discovery needs a local symbol source at ${marketDir}; pass --symbols or --symbolSourceDir. ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const symbols = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name.toUpperCase())
    .filter(symbol => symbol.endsWith(args.quote))
    .sort((a, b) => a.localeCompare(b));
  const unique = Array.from(new Set(symbols));
  if (unique.length === 0) {
    throw new Error(`probe discovery found no ${args.quote} symbols under ${marketDir}`);
  }
  return args.maxSymbols ? unique.slice(0, args.maxSymbols) : unique;
}

async function probeTaskExists(args: Args, task: Task): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= args.maxRetries; attempt += 1) {
    try {
      const status = await curlHeadStatus(args, task.url);
      if (status >= 200 && status < 300) return true;
      if (status === 404) return false;
      lastError = new Error(`http=${status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < args.maxRetries) {
      await sleep(Math.min(10_000, 750 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(
    `probe failed for ${task.url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function discoverTasks(args: Args, symbols: string[]): Promise<Task[]> {
  if (args.discovery === "probe") {
    return discoverTasksByProbe(args, symbols);
  }
  let listed = 0;
  const groups = await withConcurrency(symbols, args.listConcurrency, async symbol => {
    const keys = await listS3Keys(args, symbolPrefix(args, symbol));
    listed += 1;
    if (listed % 50 === 0 || listed === symbols.length) {
      console.log(`listed ${listed}/${symbols.length} symbols`);
    }
    return keys
      .map(key => parseEntry(args, key))
      .filter((entry): entry is ZipEntry => Boolean(entry));
  });
  const tasks = groups.flat().map(entry => taskFromEntry(args, entry));
  const sorted = tasks.sort((a, b) => a.key.localeCompare(b.key));
  return args.maxTasks ? sorted.slice(0, args.maxTasks) : sorted;
}

async function discoverTasksByProbe(args: Args, symbols: string[]): Promise<Task[]> {
  const candidates = symbols.flatMap(symbol =>
    monthRange(args.startMonth, args.endMonth).map(month => taskFromEntry(args, candidateEntry(args, symbol, month)))
  );
  let probed = 0;
  let existing = 0;
  let absent = 0;
  const groups = await withConcurrency(candidates, args.listConcurrency, async task => {
    const exists = await probeTaskExists(args, task);
    probed += 1;
    if (exists) existing += 1;
    else absent += 1;
    if (probed % 1000 === 0 || probed === candidates.length) {
      console.log(`probed ${probed}/${candidates.length} urls existing=${existing} absent=${absent}`);
    }
    return exists ? task : undefined;
  });
  const tasks = groups.filter((task): task is Task => Boolean(task)).sort((a, b) => a.key.localeCompare(b.key));
  return args.maxTasks ? tasks.slice(0, args.maxTasks) : tasks;
}

function isRecordLine(value: unknown): value is RecordLine {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RecordLine>;
  return (
    record.status === "failed" &&
    typeof record.market === "string" &&
    typeof record.dataType === "string" &&
    typeof record.symbol === "string" &&
    typeof record.month === "string" &&
    typeof record.key === "string" &&
    typeof record.url === "string" &&
    typeof record.zipPath === "string"
  );
}

async function loadFailedTasksFromManifest(args: Args, path: string, maxTasks?: number): Promise<Task[]> {
  const tasks = new Map<string, Task>();
  const reader = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `Invalid JSON in retry manifest ${path}:${lineNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!isRecordLine(parsed)) continue;
    tasks.set(parsed.zipPath, {
      market: parsed.market,
      dataType: parsed.dataType,
      symbol: parsed.symbol,
      month: parsed.month,
      key: parsed.key,
      url: `${args.dataEndpoint}/${parsed.key.split("/").map(encodeURIComponent).join("/")}`,
      zipPath: parsed.zipPath,
    });
  }
  const sorted = Array.from(tasks.values()).sort((a, b) => a.key.localeCompare(b.key));
  return maxTasks ? sorted.slice(0, maxTasks) : sorted;
}

async function downloadTask(args: Args, task: Task): Promise<RecordLine> {
  if (args.skipExisting && (await nonEmptyFileExists(task.zipPath))) {
    return { ...task, status: "exists" };
  }
  await mkdir(resolve(task.zipPath, ".."), { recursive: true });
  const tmpPath = `${task.zipPath}.part`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= args.maxRetries; attempt += 1) {
    try {
      const existingPartSize = await fileSizeIfExists(tmpPath);
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        resolvePromise => {
          const proc = spawn(
            "curl",
            [
              "-L",
              "--silent",
              "--show-error",
              ...(existingPartSize > 0 ? ["--continue-at", "-"] : []),
              "--connect-timeout",
              String(args.connectTimeoutSec),
              "--max-time",
              String(args.downloadMaxTimeSec),
              ...(args.proxy ? ["--proxy", args.proxy] : []),
              ...(!args.proxy ? ["--noproxy", "*"] : []),
              ...(args.networkInterface ? ["--interface", args.networkInterface] : []),
              "--output",
              tmpPath,
              "--write-out",
              "%{http_code}",
              task.url,
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              http_proxy: "",
              https_proxy: "",
              all_proxy: "",
              HTTP_PROXY: "",
              HTTPS_PROXY: "",
              ALL_PROXY: "",
            },
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
          proc.on("error", err => {
            resolvePromise({ code: 1, stdout, stderr: err.message });
          });
          proc.on("close", code => {
            resolvePromise({ code, stdout, stderr });
          });
        }
      );
      const httpStatus = Number(result.stdout.trim());
      if (httpStatus >= 200 && httpStatus < 300 && result.code === 0) {
        await rename(tmpPath, task.zipPath);
        return { ...task, status: "downloaded", httpStatus };
      }
      if (httpStatus >= 400) await unlink(tmpPath).catch(() => {});
      if (httpStatus === 404) return { ...task, status: "missing", httpStatus };
      lastError = new Error(`curl code=${result.code} http=${result.stdout.trim() || "unknown"} ${result.stderr.trim()}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < args.maxRetries) {
      await sleep(Math.min(15_000, 750 * 2 ** (attempt - 1)));
    }
  }
  return {
    ...task,
    status: "failed",
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

function archiveLineageStatus(record: RecordLine): ArchiveLineageStatus {
  if (record.status === "downloaded") return "available";
  if (record.status === "exists") return "local_file_observed";
  if (record.status === "missing") return "missing";
  return "failed";
}

function recordSourceEndpoint(record: Pick<RecordLine, "url">): string {
  try {
    const url = new URL(record.url);
    return url.origin;
  } catch {
    return DATA_ENDPOINT;
  }
}

function sourceManifestId(record: Pick<RecordLine, "market" | "dataType" | "symbol" | "month" | "key">): string {
  const keyHash = createHash("sha256").update(record.key).digest("hex").slice(0, 16);
  return [
    "binance_data_vision",
    record.market,
    record.dataType,
    record.symbol,
    record.month,
    keyHash,
  ].join(":");
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function buildDownloadManifestRecord(
  record: RecordLine,
  context: DownloadManifestContext
): DownloadManifestRecordV2 {
  const generatedAt = context.generatedAt ?? new Date().toISOString();
  const archiveStatus = archiveLineageStatus(record);
  const archiveAvailableAt =
    archiveStatus === "available" || archiveStatus === "local_file_observed" ? generatedAt : null;
  const sourceId = sourceManifestId(record);
  const manifestRecord = {
    ...record,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt,
    jobId: context.jobId,
    collectionRunId: context.collectionRunId,
    collectorObservedAt: generatedAt,
    observedAt: generatedAt,
    fetchedAt: record.status === "downloaded" ? generatedAt : null,
    availableAt: archiveAvailableAt,
    archiveFileAvailableAt: archiveAvailableAt,
    archiveLineageStatus: archiveStatus,
    sourceEndpoint: recordSourceEndpoint(record),
    sourceUrl: record.url,
    sourcePath: record.key,
    sourceManifestId: sourceId,
    sourceRowHash: "",
    sourceRowHashScope: "archive_manifest_record" as const,
    lineageScope: "archive_file" as const,
    pitSuitability: "archive_download_lineage_only_not_row_pit" as const,
    rowPITUsableForPromotion: false as const,
  };
  return {
    ...manifestRecord,
    sourceRowHash: stableHash({
      ...manifestRecord,
      sourceRowHash: undefined,
    }),
  };
}

export function buildCollectionRunId(args: Pick<Args, "market" | "dataType" | "timeframe" | "startMonth" | "endMonth" | "outDir" | "retryManifest">, startedAt: string): string {
  return `fast_binance_data_vision_backfill:${stableHash({
    market: args.market,
    dataType: args.dataType,
    timeframe: args.timeframe,
    startMonth: args.startMonth,
    endMonth: args.endMonth,
    outDir: args.outDir,
    retryManifest: args.retryManifest ?? null,
    startedAt,
  }).slice(0, 20)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const jobId = "fast_binance_data_vision_backfill";
  const collectionRunId = buildCollectionRunId(args, startedAt);
  await mkdir(args.outDir, { recursive: true });
  console.log(
    `fast Binance backfill: market=${args.market} dataType=${args.dataType} timeframe=${args.timeframe} range=[${args.startMonth}..${args.endMonth}] outDir=${args.outDir} concurrency=${args.concurrency} proxy=${args.proxy ?? "none"} interface=${args.networkInterface ?? "default"} dataEndpoint=${args.dataEndpoint} s3Endpoint=${args.s3Endpoint} discovery=${args.discovery}`
  );

  const symbols = args.retryManifest ? [] : await discoverSymbols(args);
  const tasks = args.retryManifest
    ? await loadFailedTasksFromManifest(args, args.retryManifest, args.maxTasks)
    : await discoverTasks(args, symbols);
  if (args.retryManifest) {
    console.log(`retry manifest: ${args.retryManifest}`);
    console.log(`download plan: failedManifestZipFiles=${tasks.length}`);
  } else {
    console.log(`target symbols: ${symbols.length}`);
    console.log(`download plan: actualDataVisionZipFiles=${tasks.length}`);
  }
  if (tasks.length === 0) {
    throw new Error("No Data Vision zip files discovered for this dataset");
  }

  const manifestPath = args.manifestPath ?? resolve(args.outDir, "manifest.fast-binance-download.jsonl");
  await mkdir(resolve(manifestPath, ".."), { recursive: true });
  const manifest = createWriteStream(manifestPath, { flags: "a" });
  let completed = 0;
  const totals: Record<Status, number> = { downloaded: 0, exists: 0, missing: 0, failed: 0 };
  const progressEvery = Math.max(1, Math.floor(tasks.length / 100));

  await withConcurrency(tasks, args.concurrency, async task => {
    const record = await downloadTask(args, task);
    const manifestRecord = buildDownloadManifestRecord(record, {
      jobId,
      collectionRunId,
    });
    totals[record.status] += 1;
    completed += 1;
    manifest.write(`${JSON.stringify(manifestRecord)}\n`);
    if (completed % progressEvery === 0 || completed === tasks.length) {
      const pct = ((completed / tasks.length) * 100).toFixed(1);
      console.log(
        `progress ${completed}/${tasks.length} (${pct}%) downloaded=${totals.downloaded} exists=${totals.exists} missing=${totals.missing} failed=${totals.failed}`
      );
    }
    return record;
  });

  await new Promise<void>(resolvePromise => {
    manifest.end(resolvePromise);
  });
  const summary = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    startedAt,
    endedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    jobId,
    collectionRunId,
    lineageScope: "archive_file",
    pitSuitability: "archive_download_lineage_only_not_row_pit",
    rowPITUsableForPromotion: false,
    mode: args.retryManifest ? "retry_manifest" : args.discovery === "probe" ? "probe" : "discovery",
    args,
    targetSymbols: args.retryManifest ? undefined : symbols.length,
    files: tasks.length,
    totals,
    manifestPath,
    coverage: totals.failed === 0 && totals.missing === 0 ? "complete" : "partial",
  };
  const summaryPath =
    args.summaryPath ??
    resolve(args.outDir, args.retryManifest ? "summary.fast-binance-download.retry.json" : "summary.fast-binance-download.json");
  await mkdir(resolve(summaryPath, ".."), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`done: ${JSON.stringify(totals)}`);
  console.log(`summary saved: ${summaryPath}`);
  if (totals.failed > 0 || totals.missing > 0) {
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(err => {
    console.error("fast_binance_data_vision_backfill failed:", err);
    process.exit(1);
  });
}
