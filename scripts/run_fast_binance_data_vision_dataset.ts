import { readdir, readFile, stat } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

type Market = "spot" | "um";
type Args = {
  market: Market;
  dataType: string;
  quote: string;
  symbols?: string;
  timeframe?: string;
  startMonth: string;
  endMonth?: string;
  outDir: string;
  proxy?: string;
  networkInterface?: string;
  dataEndpoint?: string;
  s3Endpoint?: string;
  discovery: string;
  symbolSourceDir?: string;
  listConcurrency: number;
  concurrency: number;
  retryConcurrency: number;
  maxRetries: number;
  retryMaxRetries: number;
  connectTimeoutSec: number;
  listMaxTimeSec: number;
  downloadMaxTimeSec: number;
  maxSymbols?: string;
  maxTasks?: string;
  retryRounds: number;
};

type DownloadSummary = {
  coverage?: string;
  files?: number;
  totals?: {
    failed?: number;
    missing?: number;
  };
};

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

function parseIntArg(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid --${name}: ${raw}`);
  return value;
}

function required(raw: Map<string, string>, key: string): string {
  const value = raw.get(key);
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

function normalizeProxy(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["0", "false", "no", "none", "direct", "off"].includes(normalized)) return undefined;
  return value;
}

function normalizeInterface(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["0", "false", "no", "none", "direct", "off"].includes(normalized)) return undefined;
  return value;
}

function parseArgs(argv: string[]): Args {
  const raw = parseRawArgs(argv);
  const market = required(raw, "market").toLowerCase();
  if (market !== "spot" && market !== "um") throw new Error(`Invalid --market: ${market}`);
  const proxy = normalizeProxy(raw.get("proxy"));
  return {
    market,
    dataType: required(raw, "dataType"),
    quote: (raw.get("quote") ?? "USDT").toUpperCase(),
    symbols: raw.get("symbols"),
    timeframe: raw.get("timeframe"),
    startMonth: required(raw, "startMonth"),
    endMonth: raw.get("endMonth"),
    outDir: resolve(required(raw, "outDir")),
    proxy,
    networkInterface: normalizeInterface(raw.get("interface") ?? process.env.BINANCE_BACKFILL_INTERFACE ?? "en0"),
    dataEndpoint: raw.get("dataEndpoint") ?? process.env.BINANCE_BACKFILL_DATA_ENDPOINT,
    s3Endpoint: raw.get("s3Endpoint") ?? process.env.BINANCE_BACKFILL_S3_ENDPOINT,
    discovery: raw.get("discovery") ?? process.env.BINANCE_BACKFILL_DISCOVERY ?? "s3",
    symbolSourceDir: raw.get("symbolSourceDir") ? resolve(raw.get("symbolSourceDir") ?? "") : undefined,
    listConcurrency: parseIntArg(raw.get("listConcurrency"), 8, "listConcurrency"),
    concurrency: parseIntArg(raw.get("concurrency"), 96, "concurrency"),
    retryConcurrency: parseIntArg(raw.get("retryConcurrency"), 60, "retryConcurrency"),
    maxRetries: parseIntArg(raw.get("maxRetries"), 12, "maxRetries"),
    retryMaxRetries: parseIntArg(raw.get("retryMaxRetries"), 12, "retryMaxRetries"),
    connectTimeoutSec: parseIntArg(raw.get("connectTimeoutSec"), 10, "connectTimeoutSec"),
    listMaxTimeSec: parseIntArg(raw.get("listMaxTimeSec"), 120, "listMaxTimeSec"),
    downloadMaxTimeSec: parseIntArg(raw.get("downloadMaxTimeSec"), 180, "downloadMaxTimeSec"),
    maxSymbols: raw.get("maxSymbols"),
    maxTasks: raw.get("maxTasks"),
    retryRounds: parseIntArg(raw.get("retryRounds"), 2, "retryRounds"),
  };
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function tsxCliPath(root: string): string {
  return resolve(root, "node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function countFilesWithSuffix(root: string, suffix: string): Promise<number> {
  if (!(await pathExists(root))) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = resolve(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile() && entry.name.endsWith(suffix)) count += 1;
    }
  }
  return count;
}

async function readSummary(outDir: string): Promise<DownloadSummary | undefined> {
  try {
    return JSON.parse(await readFile(resolve(outDir, "summary.fast-binance-download.json"), "utf8")) as DownloadSummary;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function isComplete(outDir: string): Promise<boolean> {
  const summary = await readSummary(outDir);
  if (!summary) return false;
  const [zipFiles, partFiles] = await Promise.all([
    countFilesWithSuffix(outDir, ".zip"),
    countFilesWithSuffix(outDir, ".part"),
  ]);
  return (
    summary.coverage === "complete" &&
    (summary.totals?.failed ?? 0) === 0 &&
    (summary.totals?.missing ?? 0) === 0 &&
    zipFiles === (summary.files ?? -1) &&
    partFiles === 0
  );
}

function downloaderArgs(args: Args, overrides: Partial<Pick<Args, "concurrency" | "maxRetries">> = {}): string[] {
  const out = [
    "scripts/fast_binance_data_vision_backfill.ts",
    "--market",
    args.market,
    "--dataType",
    args.dataType,
    "--quote",
    args.quote,
    "--startMonth",
    args.startMonth,
    "--outDir",
    args.outDir,
    "--listConcurrency",
    String(args.listConcurrency),
    "--concurrency",
    String(overrides.concurrency ?? args.concurrency),
    "--maxRetries",
    String(overrides.maxRetries ?? args.maxRetries),
    "--connectTimeoutSec",
    String(args.connectTimeoutSec),
    "--listMaxTimeSec",
    String(args.listMaxTimeSec),
    "--downloadMaxTimeSec",
    String(args.downloadMaxTimeSec),
    "--skipExisting",
    "true",
    "--proxy",
    args.proxy ?? "none",
    "--discovery",
    args.discovery,
  ];
  if (args.symbols) out.push("--symbols", args.symbols);
  if (args.networkInterface) out.push("--interface", args.networkInterface);
  if (args.dataEndpoint) out.push("--dataEndpoint", args.dataEndpoint);
  if (args.s3Endpoint) out.push("--s3Endpoint", args.s3Endpoint);
  if (args.symbolSourceDir) out.push("--symbolSourceDir", args.symbolSourceDir);
  if (args.timeframe) out.push("--timeframe", args.timeframe);
  if (args.endMonth) out.push("--endMonth", args.endMonth);
  if (args.maxSymbols) out.push("--maxSymbols", args.maxSymbols);
  if (args.maxTasks) out.push("--maxTasks", args.maxTasks);
  return out;
}

async function runDownloader(root: string, args: string[]): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, [tsxCliPath(root), ...args], {
      cwd: root,
      stdio: "inherit",
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
    proc.on("error", rejectPromise);
    proc.on("close", code => resolvePromise(code ?? 1));
  });
}

async function runAllowingPartial(root: string, args: string[], label: string): Promise<void> {
  const code = await runDownloader(root, args);
  if (code === 0 || code === 2) return;
  throw new Error(`${label} failed with exit code ${code}`);
}

async function runVerificationDiscovery(root: string, args: string[], label: string): Promise<boolean> {
  const code = await runDownloader(root, args);
  if (code === 0 || code === 2) return true;
  console.warn(`${label} failed with exit code ${code}; will continue if retry rounds remain`);
  return false;
}

async function tryFinalizeFromRetrySummary(root: string, outDir: string): Promise<boolean> {
  const code = await runDownloader(root, [
    "scripts/finalize_fast_binance_data_vision_summary.ts",
    "--outDir",
    outDir,
  ]);
  return code === 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const manifestPath = resolve(args.outDir, "manifest.fast-binance-download.jsonl");
  const manifestExists = await pathExists(manifestPath);

  console.log(`managed dataset start: ${JSON.stringify(args)}`);
  if (await isComplete(args.outDir)) {
    console.log("managed dataset already complete");
    return;
  }
  const initialPartFiles = await countFilesWithSuffix(args.outDir, ".part");
  if (initialPartFiles > 0) {
    console.error(
      `managed dataset appears to be in progress: partFiles=${initialPartFiles} outDir=${args.outDir}`
    );
    process.exitCode = 3;
    return;
  }

  const initialSummary = await readSummary(args.outDir);
  if (!initialSummary) {
    if (!manifestExists) {
      await runAllowingPartial(root, downloaderArgs(args), "initial discovery download");
      if (await isComplete(args.outDir)) {
        console.log("managed dataset complete after initial discovery");
        return;
      }
    } else {
      console.log(`managed dataset missing summary but manifest exists; skipping discovery: ${manifestPath}`);
    }
  } else {
    console.log(
      `managed dataset has existing authoritative summary: ${JSON.stringify({
        coverage: initialSummary.coverage,
        files: initialSummary.files,
        totals: initialSummary.totals,
      })}`
    );
  }

  for (let round = 1; round <= args.retryRounds; round += 1) {
    if (!manifestExists) {
      console.log(`manifest not found, running verification discovery instead: ${manifestPath}`);
    } else {
      console.log(`retry round ${round}/${args.retryRounds}: ${manifestPath}`);
      await runAllowingPartial(
        root,
        [
          ...downloaderArgs(args, { concurrency: args.retryConcurrency, maxRetries: args.retryMaxRetries }),
          "--retryManifest",
          manifestPath,
        ],
        `retry round ${round}`
      );
    }

    if (!manifestExists) {
      console.log(`verification discovery round ${round}/${args.retryRounds}`);
      await runVerificationDiscovery(root, downloaderArgs(args), `verification discovery round ${round}`);
    } else {
      console.log(`verification discovery skipped because manifest exists`);
    }
    if (await isComplete(args.outDir)) {
      console.log(`managed dataset complete after retry round ${round}`);
      return;
    }
  }

  console.log("attempting local retry-summary reconciliation finalize");
  if (await tryFinalizeFromRetrySummary(root, args.outDir)) {
    if (await isComplete(args.outDir)) {
      console.log("managed dataset complete after local retry-summary reconciliation finalize");
      return;
    }
  }

  const summary = await readSummary(args.outDir);
  const [zipFiles, partFiles] = await Promise.all([
    countFilesWithSuffix(args.outDir, ".zip"),
    countFilesWithSuffix(args.outDir, ".part"),
  ]);
  console.error(
    `managed dataset incomplete after ${args.retryRounds} retry rounds: ${JSON.stringify({
      summary,
      zipFiles,
      partFiles,
    })}`
  );
  process.exitCode = 2;
}

main().catch(err => {
  console.error("run_fast_binance_data_vision_dataset failed:", err);
  process.exit(1);
});
