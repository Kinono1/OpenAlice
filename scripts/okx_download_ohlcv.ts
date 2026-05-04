import ccxt from "ccxt";
import { appendFile, mkdir, stat, writeFile } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { resolve } from "path";
import { loadConfig } from "../src/core/config.js";
import { SymbolMapper } from "../src/extension/crypto-trading/providers/ccxt/symbol-map.js";

type UniverseMode =
  | "config"
  | "all"
  | "all-swap"
  | "all-spot"
  | "all-swap-usdt"
  | "all-spot-usdt"
  | "all-usdt";

type CliArgs = {
  timeframe: string;
  startMs: number;
  endMs: number;
  outDir: string;
  symbols?: string[];
  internalSymbols?: string[];
  universe: UniverseMode;
  includeInactive: boolean;
  maxSymbols?: number;
  limit: number;
  maxRetries: number;
  sleepMs: number;
  append: boolean;
  marketType: "spot" | "swap";
};

type Candle = [number, number, number, number, number, number];

type DownloadResult = {
  symbol: string;
  filePath: string;
  fetchedBars: number;
  writtenBars: number;
  resumeFromTs: number | null;
  firstWrittenTs: number | null;
  lastWrittenTs: number | null;
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

function parseDateMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) throw new Error(`Invalid timestamp: ${raw}`);
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid date value: ${raw}`);
  }
  return parsed;
}

function timeframeToMs(timeframe: string): number {
  const m = timeframe.match(/^(\d+)([mhdwM])$/);
  if (!m) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const n = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    case "w":
      return n * 7 * 86_400_000;
    case "M":
      return n * 30 * 86_400_000;
    default:
      throw new Error(`Unsupported timeframe unit: ${unit}`);
  }
}

function timeframeToOkxBar(timeframe: string): string {
  const m = timeframe.match(/^(\d+)([mhdwM])$/);
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

function toIso(ts: number): string {
  return new Date(ts).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => {
    setTimeout(resolvePromise, ms);
  });
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function sanitizeSymbol(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function getLastTimestampFromCsv(path: string): Promise<number | null> {
  if (!(await fileExists(path))) return null;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  let lastLine = "";
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length > 0) lastLine = trimmed;
  }
  if (!lastLine || lastLine.startsWith("timestamp")) return null;
  const ts = Number(lastLine.split(",")[0]);
  return Number.isFinite(ts) ? ts : null;
}

async function ensureCsvHeader(
  path: string,
  forceReset = false
): Promise<void> {
  const header =
    "timestamp,iso,open,high,low,close,volume,symbol,timeframe,exchange\n";
  if (forceReset) {
    await writeFile(path, header);
    return;
  }
  if (!(await fileExists(path))) {
    await writeFile(path, header);
    return;
  }
  const s = await stat(path);
  if (s.size === 0) {
    await writeFile(path, header);
  }
}

async function loadOkxMarketsWithHostFallback(
  exchange: ccxt.okx
): Promise<string> {
  const ex = exchange as unknown as {
    hostname?: string;
    loadMarkets: (reload?: boolean) => Promise<void>;
  };
  const initial = ex.hostname;
  const candidates = uniq(
    [initial, "www.okx.com", "aws.okx.com"].filter((v): v is string =>
      Boolean(v)
    )
  );
  let lastError: unknown;
  for (const host of candidates) {
    try {
      ex.hostname = host;
      await ex.loadMarkets(true);
      return host;
    } catch (err) {
      lastError = err;
      console.warn(`loadMarkets failed on host '${host}': ${String(err)}`);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("OKX loadMarkets failed for all host fallbacks");
}

async function fetchHistoryCandlesWithRetry(
  exchange: ccxt.okx,
  instId: string,
  okxBar: string,
  after: number | undefined,
  limit: number,
  maxRetries: number
): Promise<Candle[]> {
  const ex = exchange as unknown as {
    publicGetMarketHistoryCandles: (params: Record<string, string>) => Promise<{
      data?: Array<[string, string, string, string, string, string]>;
    }>;
  };

  let lastError: unknown;
  let backoffMs = 1000;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const params: Record<string, string> = {
        instId,
        bar: okxBar,
        limit: String(limit),
      };
      if (after != null) params.after = String(after);

      const res = await ex.publicGetMarketHistoryCandles(params);
      const data = (res.data ?? []).map(
        row =>
          [
            Number(row[0]),
            Number(row[1]),
            Number(row[2]),
            Number(row[3]),
            Number(row[4]),
            Number(row[5]),
          ] as Candle
      );
      return data.filter(row => Number.isFinite(row[0]));
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isNoSuchInstrument =
        msg.includes("51001") || msg.toLowerCase().includes("doesn't exist");
      if (isNoSuchInstrument) {
        // Stale market entry: instrument removed on server side. Skip fast.
        break;
      }
      if (attempt >= maxRetries) break;
      console.warn(
        `[${instId}] history-candles attempt ${attempt}/${maxRetries} failed at after=${after ?? "latest"}: ${String(err)}; retry in ${backoffMs}ms`
      );
      await sleep(backoffMs);
      backoffMs *= 2;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function printHelp(): void {
  console.log(`Usage:
  pnpm data:download:okx -- [options]

Options:
  --timeframe 1h                 Candle timeframe (default: 1h)
  --start 2020-01-01             Start time (ISO/date string or unix seconds/ms)
  --end 2026-02-22               End time (default: now)
  --outDir data/market/okx       Output directory
  --symbols BTC/USDT:USDT,ETH/USDT:USDT
                                 Direct CCXT symbols
  --internalSymbols BTC/USD,ETH/USD
                                 Internal symbols (mapped via exchange markets)
  --universe config              One of:
                                 config | all | all-swap | all-spot |
                                 all-swap-usdt | all-spot-usdt | all-usdt
  --includeInactive true         Include markets with active=false (default: true)
  --maxSymbols 20                Max symbols to process (useful for smoke test)
  --marketType swap              Mapping preference for internal symbols: swap | spot
  --limit 300                    OHLCV API limit per call (default: 300)
  --maxRetries 5                 Retry attempts per OHLCV request
  --sleepMs 200                  Delay between successful pages
  --append true                  Continue from last row in existing CSV (default: true)

Examples:
  pnpm data:download:okx -- --universe config --timeframe 1h --start 2023-01-01
  pnpm data:download:okx -- --symbols BTC/USDT:USDT --timeframe 15m --start 2025-01-01
  pnpm data:download:okx -- --symbols BTC/USDT:USDT --timeframe 1h --start 2020-01-01 --append false
  pnpm data:download:okx -- --universe all --includeInactive true --timeframe 1d --start 2018-01-01
  pnpm data:download:okx -- --universe all-swap-usdt --maxSymbols 30 --start 2024-01-01`);
}

function parseCliArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }

  const now = Date.now();
  const defaultStart = Date.parse("2020-01-01T00:00:00Z");
  const universeRaw = raw.get("universe") ?? "config";
  const universe = universeRaw as UniverseMode;
  if (
    universe !== "config" &&
    universe !== "all" &&
    universe !== "all-swap" &&
    universe !== "all-spot" &&
    universe !== "all-swap-usdt" &&
    universe !== "all-spot-usdt" &&
    universe !== "all-usdt"
  ) {
    throw new Error(`Invalid universe: ${universeRaw}`);
  }

  const marketTypeRaw = (raw.get("marketType") ?? "swap").toLowerCase();
  const marketType = marketTypeRaw as "spot" | "swap";
  if (marketType !== "spot" && marketType !== "swap") {
    throw new Error(`Invalid marketType: ${marketTypeRaw}`);
  }

  const startMs = parseDateMs(raw.get("start"), defaultStart);
  const endMs = parseDateMs(raw.get("end"), now);
  if (startMs >= endMs) {
    throw new Error("start must be earlier than end");
  }

  return {
    timeframe: raw.get("timeframe") ?? "1h",
    startMs,
    endMs,
    outDir: raw.get("outDir") ?? "data/market/okx",
    symbols: parseList(raw.get("symbols")),
    internalSymbols: parseList(raw.get("internalSymbols")),
    universe,
    includeInactive: parseBoolean(raw.get("includeInactive"), true),
    maxSymbols: raw.get("maxSymbols")
      ? parseIntArg(raw.get("maxSymbols"), 0, "maxSymbols")
      : undefined,
    limit: parseIntArg(raw.get("limit"), 300, "limit"),
    maxRetries: parseIntArg(raw.get("maxRetries"), 5, "maxRetries"),
    sleepMs: parseIntArg(raw.get("sleepMs"), 200, "sleepMs"),
    append: parseBoolean(raw.get("append"), true),
    marketType,
  };
}

function resolveSymbolsFromUniverse(
  exchange: ccxt.okx,
  universe: UniverseMode,
  includeInactive: boolean
): string[] {
  const markets = Object.values(exchange.markets ?? {}) as Array<{
    symbol: string;
    active?: boolean;
    type?: string;
    quote?: string;
    settle?: string;
  }>;

  const isUsdt = (m: { quote?: string; settle?: string }) =>
    m.quote === "USDT" || m.settle === "USDT";
  const isSwap = (m: { type?: string }) =>
    m.type === "swap" || m.type === "future";
  const isSpot = (m: { type?: string }) => m.type === "spot";

  const filteredByActive = includeInactive
    ? markets
    : markets.filter(m => m.active !== false);

  let picked: typeof filteredByActive;
  if (universe === "all-swap-usdt") {
    picked = filteredByActive.filter(m => isUsdt(m) && isSwap(m));
  } else if (universe === "all-spot-usdt") {
    picked = filteredByActive.filter(m => isUsdt(m) && isSpot(m));
  } else if (universe === "all-usdt") {
    picked = filteredByActive.filter(
      m => isUsdt(m) && (isSwap(m) || isSpot(m))
    );
  } else if (universe === "all-swap") {
    picked = filteredByActive.filter(isSwap);
  } else if (universe === "all-spot") {
    picked = filteredByActive.filter(isSpot);
  } else {
    picked = filteredByActive.filter(m => isSwap(m) || isSpot(m));
  }
  return uniq(
    picked
      .map(m => m.symbol)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  );
}

async function resolveTargetSymbols(
  exchange: ccxt.okx,
  args: CliArgs
): Promise<string[]> {
  if (args.symbols?.length) return uniq(args.symbols);

  if (args.universe !== "config") {
    return resolveSymbolsFromUniverse(
      exchange,
      args.universe,
      args.includeInactive
    );
  }

  const config = await loadConfig();
  const configSymbols = config.crypto.allowedSymbols;
  const internalSymbols = args.internalSymbols?.length
    ? args.internalSymbols
    : configSymbols;

  const mapper = new SymbolMapper(internalSymbols, args.marketType);
  mapper.init(
    exchange.markets as unknown as Record<
      string,
      {
        symbol: string;
        base: string;
        quote: string;
        type: string;
        settle?: string;
        active?: boolean;
        precision?: { price?: number; amount?: number };
      }
    >
  );

  const out: string[] = [];
  for (const internal of internalSymbols) {
    try {
      out.push(mapper.toCcxt(internal));
    } catch {
      console.warn(`skip unmapped internal symbol: ${internal}`);
    }
  }
  return uniq(out);
}

async function downloadOneSymbol(
  exchange: ccxt.okx,
  args: CliArgs,
  symbol: string
): Promise<DownloadResult> {
  const tfMs = timeframeToMs(args.timeframe);
  const okxBar = timeframeToOkxBar(args.timeframe);
  const filePath = resolve(
    args.outDir,
    `${sanitizeSymbol(symbol)}_${args.timeframe}.csv`
  );
  await mkdir(args.outDir, { recursive: true });
  await ensureCsvHeader(filePath, !args.append);

  const resumeFromTs = args.append
    ? await getLastTimestampFromCsv(filePath)
    : null;
  const startTs =
    resumeFromTs != null
      ? Math.max(args.startMs, resumeFromTs + tfMs)
      : args.startMs;
  const stopBeforeTs = startTs;

  const market = (exchange.markets ?? {})[symbol] as
    | { id?: string }
    | undefined;
  const instId = market?.id ?? symbol;
  let fetchedBars = 0;
  let firstWrittenTs: number | null = null;
  let lastWrittenTs: number | null = resumeFromTs;
  let cursorAfter: number | undefined;
  const collected = new Map<number, Candle>();

  while (true) {
    const batch = await fetchHistoryCandlesWithRetry(
      exchange,
      instId,
      okxBar,
      cursorAfter,
      args.limit,
      args.maxRetries
    );
    if (!batch.length) break;
    fetchedBars += batch.length;

    let oldestTs = Number.POSITIVE_INFINITY;
    for (const row of batch) {
      const ts = row[0];
      if (!Number.isFinite(ts)) continue;
      if (ts < oldestTs) oldestTs = ts;
      if (ts < startTs || ts > args.endMs) continue;
      if (resumeFromTs != null && ts <= resumeFromTs) continue;
      collected.set(ts, row);
    }
    if (!Number.isFinite(oldestTs)) break;
    if (oldestTs <= stopBeforeTs) break;
    cursorAfter = oldestTs;
    if (args.sleepMs > 0) await sleep(args.sleepMs);
  }

  const rows = Array.from(collected.values()).sort((a, b) => a[0] - b[0]);
  if (rows.length > 0) {
    firstWrittenTs = rows[0][0];
    lastWrittenTs = rows[rows.length - 1][0];
    const lines = rows.map(
      ([ts, open, high, low, close, volume]) =>
        `${ts},${toIso(ts)},${open},${high},${low},${close},${volume},${symbol},${args.timeframe},okx`
    );
    await appendFile(filePath, `${lines.join("\n")}\n`);
  }

  return {
    symbol,
    filePath,
    fetchedBars,
    writtenBars: rows.length,
    resumeFromTs,
    firstWrittenTs,
    lastWrittenTs,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  timeframeToMs(args.timeframe);

  const config = await loadConfig();
  const useConfigProviderOptions =
    args.universe === "config" &&
    !args.symbols?.length &&
    !args.internalSymbols?.length;
  const providerOptions =
    useConfigProviderOptions &&
    config.crypto.provider.type === "ccxt" &&
    config.crypto.provider.exchange === "okx"
      ? (config.crypto.provider.options ?? {})
      : {};

  const exchange = new ccxt.okx({
    enableRateLimit: true,
    timeout: 30_000,
    apiKey: process.env.EXCHANGE_API_KEY,
    secret: process.env.EXCHANGE_API_SECRET,
    password: process.env.EXCHANGE_PASSWORD,
    ...providerOptions,
  });

  (
    exchange as unknown as { has: Record<string, unknown> }
  ).has.fetchCurrencies = false;
  const exOptions = (
    exchange as unknown as { options?: Record<string, unknown> }
  ).options;
  (exchange as unknown as { options: Record<string, unknown> }).options = {
    ...(exOptions ?? {}),
    defaultType: args.marketType,
  };

  const exchOptions = (
    exchange as unknown as {
      options: Record<string, unknown>;
    }
  ).options;
  const nestedOptions = (exchOptions.options ?? {}) as Record<string, unknown>;
  if (args.universe === "all" || args.universe === "all-usdt") {
    nestedOptions.fetchMarkets = { types: ["spot", "swap"] };
  } else if (
    args.universe === "all-spot" ||
    args.universe === "all-spot-usdt"
  ) {
    nestedOptions.fetchMarkets = { types: ["spot"] };
  } else if (
    args.universe === "all-swap" ||
    args.universe === "all-swap-usdt"
  ) {
    nestedOptions.fetchMarkets = { types: ["swap"] };
  }
  (exchange as unknown as { options: Record<string, unknown> }).options = {
    ...exchOptions,
    options: nestedOptions,
  };

  const summaryPath = resolve(args.outDir, "summary.json");
  const startedAt = Date.now();

  try {
    const host = await loadOkxMarketsWithHostFallback(exchange);
    console.log(`OKX markets loaded via host: ${host}`);
    const allMarkets = Object.values(exchange.markets ?? {}) as Array<{
      type?: string;
      active?: boolean;
    }>;
    const spotCount = allMarkets.filter(m => m.type === "spot").length;
    const swapCount = allMarkets.filter(
      m => m.type === "swap" || m.type === "future"
    ).length;
    const inactiveCount = allMarkets.filter(m => m.active === false).length;
    console.log(
      `markets snapshot: total=${allMarkets.length}, spot=${spotCount}, swap=${swapCount}, inactive=${inactiveCount}`
    );

    let symbols = await resolveTargetSymbols(exchange, args);
    if (!symbols.length) {
      throw new Error("No symbols resolved from current arguments/config");
    }
    if (args.maxSymbols && symbols.length > args.maxSymbols) {
      symbols = symbols.slice(0, args.maxSymbols);
    }

    console.log(
      `download plan: symbols=${symbols.length}, timeframe=${args.timeframe}, range=[${toIso(args.startMs)} -> ${toIso(args.endMs)}], outDir=${resolve(args.outDir)}`
    );

    const results: DownloadResult[] = [];
    for (let i = 0; i < symbols.length; i += 1) {
      const symbol = symbols[i];
      const prefix = `[${i + 1}/${symbols.length}] ${symbol}`;
      try {
        console.log(`${prefix}: start`);
        const result = await downloadOneSymbol(exchange, args, symbol);
        results.push(result);
        console.log(
          `${prefix}: done (written=${result.writtenBars}, last=${result.lastWrittenTs ? toIso(result.lastWrittenTs) : "n/a"})`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          symbol,
          filePath: resolve(
            args.outDir,
            `${sanitizeSymbol(symbol)}_${args.timeframe}.csv`
          ),
          fetchedBars: 0,
          writtenBars: 0,
          resumeFromTs: null,
          firstWrittenTs: null,
          lastWrittenTs: null,
          error: message,
        });
        console.error(`${prefix}: failed - ${message}`);
      }
    }

    const totals = results.reduce(
      (acc, row) => {
        acc.fetchedBars += row.fetchedBars;
        acc.writtenBars += row.writtenBars;
        if (row.error) acc.failedSymbols += 1;
        return acc;
      },
      { fetchedBars: 0, writtenBars: 0, failedSymbols: 0 }
    );

    await mkdir(args.outDir, { recursive: true });
    await writeFile(
      summaryPath,
      `${JSON.stringify(
        {
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          params: {
            timeframe: args.timeframe,
            start: toIso(args.startMs),
            end: toIso(args.endMs),
            universe: args.universe,
            includeInactive: args.includeInactive,
            marketType: args.marketType,
            symbols: args.symbols ?? null,
            internalSymbols: args.internalSymbols ?? null,
            maxSymbols: args.maxSymbols ?? null,
            limit: args.limit,
            maxRetries: args.maxRetries,
            sleepMs: args.sleepMs,
            append: args.append,
          },
          totals,
          results,
        },
        null,
        2
      )}\n`
    );

    console.log(
      `download complete: written=${totals.writtenBars}, fetched=${totals.fetchedBars}, failedSymbols=${totals.failedSymbols}`
    );
    console.log(`summary saved: ${summaryPath}`);
  } finally {
    await exchange.close();
  }
}

main().catch(err => {
  console.error("okx_download_ohlcv failed:", err);
  process.exit(1);
});
