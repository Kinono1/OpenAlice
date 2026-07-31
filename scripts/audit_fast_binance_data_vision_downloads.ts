import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, resolve } from "path";

type Market = "spot" | "um";
type DatasetStatus =
  | "complete"
  | "missing_dir"
  | "in_progress"
  | "no_summary"
  | "needs_retry"
  | "needs_verification"
  | "zip_mismatch"
  | "partial";

type DatasetSpec = {
  id: string;
  market: Market;
  dataType: string;
  timeframe?: string;
  startMonth: string;
  directory: string;
};

type DownloadSummary = {
  coverage?: string;
  files?: number;
  targetSymbols?: number;
  totals?: {
    downloaded?: number;
    exists?: number;
    missing?: number;
    failed?: number;
  };
};

type DatasetAudit = DatasetSpec & {
  path: string;
  exists: boolean;
  zipFiles: number;
  partFiles: number;
  summary?: DownloadSummary;
  retrySummary?: DownloadSummary;
  complete: boolean;
  status: DatasetStatus;
  reason: string;
};

type Args = {
  root: string;
  jsonOut?: string;
  strict: boolean;
};

const KLINE_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1mo",
] as const;

const DERIVATIVE_KLINE_TYPES = ["markPriceKlines", "indexPriceKlines", "premiumIndexKlines"] as const;

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

function defaultRoot(): string {
  const dataRoot = process.env.OPENALICE_DATA_ROOT;
  if (dataRoot) return resolve(dataRoot, "market/binance-public");
  return "/Volumes/shield/cryptoData/openalice-data/market/binance-public";
}

function parseArgs(argv: string[]): Args {
  const raw = parseRawArgs(argv);
  return {
    root: resolve(raw.get("root") ?? defaultRoot()),
    jsonOut: raw.get("jsonOut") ? resolve(raw.get("jsonOut") ?? "") : undefined,
    strict: parseBoolean(raw.get("strict"), false),
  };
}

function plannedDatasets(): DatasetSpec[] {
  const specs: DatasetSpec[] = [];
  for (const timeframe of KLINE_INTERVALS) {
    specs.push({
      id: `spot-all-usdt-klines-${timeframe}`,
      market: "spot",
      dataType: "klines",
      timeframe,
      startMonth: "2017-08",
      directory: `spot-all-usdt-klines-${timeframe}`,
    });
    specs.push({
      id: `um-all-usdt-klines-${timeframe}`,
      market: "um",
      dataType: "klines",
      timeframe,
      startMonth: "2019-09",
      directory: `um-all-usdt-klines-${timeframe}`,
    });
  }

  for (const dataType of ["aggTrades", "trades"] as const) {
    specs.push({
      id: `spot-all-usdt-${dataType}`,
      market: "spot",
      dataType,
      startMonth: "2017-08",
      directory: `spot-all-usdt-${dataType}`,
    });
    specs.push({
      id: `um-all-usdt-${dataType}`,
      market: "um",
      dataType,
      startMonth: "2019-09",
      directory: `um-all-usdt-${dataType}`,
    });
  }

  for (const dataType of ["fundingRate", "bookTicker"] as const) {
    specs.push({
      id: `um-all-usdt-${dataType}`,
      market: "um",
      dataType,
      startMonth: "2019-09",
      directory: `um-all-usdt-${dataType}`,
    });
  }

  for (const dataType of DERIVATIVE_KLINE_TYPES) {
    for (const timeframe of KLINE_INTERVALS) {
      specs.push({
        id: `um-all-usdt-${dataType}-${timeframe}`,
        market: "um",
        dataType,
        timeframe,
        startMonth: "2019-09",
        directory: `um-all-usdt-${dataType}-${timeframe}`,
      });
    }
  }

  return specs;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
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
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        count += 1;
      }
    }
  }
  return count;
}

function statusFor(input: {
  exists: boolean;
  zipFiles: number;
  partFiles: number;
  summary?: DownloadSummary;
}): Pick<DatasetAudit, "complete" | "status" | "reason"> {
  const { exists, zipFiles, partFiles, summary } = input;
  if (!exists) return { complete: false, status: "missing_dir", reason: "dataset directory does not exist" };
  if (partFiles > 0) return { complete: false, status: "in_progress", reason: "part files are present" };
  if (!summary) return { complete: false, status: "no_summary", reason: "authoritative summary is missing" };

  const failed = summary.totals?.failed ?? 0;
  const missing = summary.totals?.missing ?? 0;
  const files = summary.files ?? 0;
  if (failed > 0 || missing > 0) {
    return {
      complete: false,
      status: "needs_retry",
      reason: `summary has failed=${failed} missing=${missing}`,
    };
  }
  if (summary.coverage !== "complete") {
    return {
      complete: false,
      status: "partial",
      reason: `summary coverage is ${summary.coverage ?? "unknown"}`,
    };
  }
  if (zipFiles !== files) {
    return {
      complete: false,
      status: "zip_mismatch",
      reason: `zip count ${zipFiles} does not match summary.files ${files}`,
    };
  }
  return { complete: true, status: "complete", reason: "complete summary, zero failed/missing, zip count matches" };
}

async function auditDataset(root: string, spec: DatasetSpec): Promise<DatasetAudit> {
  const path = resolve(root, spec.directory);
  const exists = await pathExists(path);
  const [zipFiles, partFiles, summary, retrySummary] = await Promise.all([
    countFilesWithSuffix(path, ".zip"),
    countFilesWithSuffix(path, ".part"),
    readJsonIfExists<DownloadSummary>(resolve(path, "summary.fast-binance-download.json")),
    readJsonIfExists<DownloadSummary>(resolve(path, "summary.fast-binance-download.retry.json")),
  ]);
  const status = statusFor({ exists, zipFiles, partFiles, summary });
  return {
    ...spec,
    path,
    exists,
    zipFiles,
    partFiles,
    summary,
    retrySummary,
    ...status,
  };
}

function printTable(audits: DatasetAudit[]): void {
  const header = [
    "status".padEnd(18),
    "zip".padStart(7),
    "part".padStart(5),
    "files".padStart(7),
    "failed".padStart(6),
    "missing".padStart(7),
    "dataset",
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const audit of audits) {
    console.log(
      [
        audit.status.padEnd(18),
        String(audit.zipFiles).padStart(7),
        String(audit.partFiles).padStart(5),
        String(audit.summary?.files ?? 0).padStart(7),
        String(audit.summary?.totals?.failed ?? 0).padStart(6),
        String(audit.summary?.totals?.missing ?? 0).padStart(7),
        audit.id,
      ].join("  ")
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const specs = plannedDatasets();
  const audits = await Promise.all(specs.map(spec => auditDataset(args.root, spec)));
  const totals = {
    plannedDatasets: audits.length,
    completeDatasets: audits.filter(audit => audit.complete).length,
    incompleteDatasets: audits.filter(audit => !audit.complete).length,
    zipFiles: audits.reduce((sum, audit) => sum + audit.zipFiles, 0),
    partFiles: audits.reduce((sum, audit) => sum + audit.partFiles, 0),
    verifiedZipFiles: audits.filter(audit => audit.complete).reduce((sum, audit) => sum + audit.zipFiles, 0),
  };
  const payload = {
    generatedAt: new Date().toISOString(),
    root: args.root,
    totals,
    audits,
  };

  printTable(audits);
  console.log(`totals: ${JSON.stringify(totals)}`);

  if (args.jsonOut) {
    await mkdir(dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`audit saved: ${args.jsonOut}`);
  }

  if (args.strict && totals.incompleteDatasets > 0) {
    process.exitCode = 2;
  }
}

main().catch(err => {
  console.error("audit_fast_binance_data_vision_downloads failed:", err);
  process.exit(1);
});
