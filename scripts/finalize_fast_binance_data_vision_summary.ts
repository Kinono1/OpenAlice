import { readdir, readFile, stat, writeFile } from "fs/promises";
import { resolve } from "path";

type StatusTotals = {
  downloaded?: number;
  exists?: number;
  missing?: number;
  failed?: number;
};

type Summary = {
  startedAt?: string;
  endedAt?: string;
  mode?: string;
  args?: unknown;
  targetSymbols?: number;
  files?: number;
  totals?: StatusTotals;
  manifestPath?: string;
  coverage?: string;
  finalizedAt?: string;
  finalizedFrom?: unknown;
};

type ManifestRecord = {
  status?: string;
  zipPath?: string;
  outputPath?: string;
};

type ManifestSnapshot = {
  records: number;
  recordsWithoutZipPath: number;
  recordStatusCounts: Record<string, number>;
  uniqueZipPaths: number;
  latestStatusCounts: Record<string, number>;
  latestNonOkRecords: number;
  latestNonOkExamples: Array<{ zipPath: string; status: string }>;
  missingZipPaths: number;
  missingZipPathExamples: string[];
};

type Args = {
  outDir: string;
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

function parseArgs(argv: string[]): Args {
  const raw = parseRawArgs(argv);
  const outDir = raw.get("outDir");
  if (!outDir) throw new Error("Missing required --outDir");
  return { outDir: resolve(outDir) };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
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

function numberValue(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function increment(counts: Record<string, number>, rawStatus: string | undefined): void {
  const status = stringValue(rawStatus, "unknown");
  counts[status] = (counts[status] ?? 0) + 1;
}

function isOkStatus(status: string | undefined): boolean {
  return status === "downloaded" || status === "exists";
}

async function readManifestSnapshot(path: string): Promise<ManifestSnapshot> {
  const raw = await readFile(path, "utf8");
  const latestByZipPath = new Map<string, { lineNumber: number; status: string | undefined }>();
  const recordStatusCounts: Record<string, number> = {};
  let records = 0;
  let recordsWithoutZipPath = 0;
  let lineNumber = 0;

  for (const line of raw.split(/\n/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    records += 1;
    let record: ManifestRecord;
    try {
      record = JSON.parse(line) as ManifestRecord;
    } catch (err) {
      throw new Error(
        `Invalid JSON in manifest ${path}:${lineNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    increment(recordStatusCounts, record.status);
    const zipPath =
      typeof record.zipPath === "string" && record.zipPath.length > 0
        ? record.zipPath
        : typeof record.outputPath === "string" && record.outputPath.length > 0
          ? record.outputPath
          : undefined;
    if (!zipPath) {
      recordsWithoutZipPath += 1;
      continue;
    }
    const existing = latestByZipPath.get(zipPath);
    if (!existing || lineNumber > existing.lineNumber) {
      latestByZipPath.set(zipPath, { lineNumber, status: record.status });
    }
  }

  const latestStatusCounts: Record<string, number> = {};
  let latestNonOkRecords = 0;
  const latestNonOkExamples: Array<{ zipPath: string; status: string }> = [];
  let missingZipPaths = 0;
  const missingZipPathExamples: string[] = [];

  for (const [zipPath, latest] of latestByZipPath.entries()) {
    increment(latestStatusCounts, latest.status);
    if (!isOkStatus(latest.status)) {
      latestNonOkRecords += 1;
      if (latestNonOkExamples.length < 20) {
        latestNonOkExamples.push({ zipPath, status: stringValue(latest.status, "unknown") });
      }
    }
    if (!(await pathExists(zipPath))) {
      missingZipPaths += 1;
      if (missingZipPathExamples.length < 20) missingZipPathExamples.push(zipPath);
    }
  }

  return {
    records,
    recordsWithoutZipPath,
    recordStatusCounts,
    uniqueZipPaths: latestByZipPath.size,
    latestStatusCounts,
    latestNonOkRecords,
    latestNonOkExamples,
    missingZipPaths,
    missingZipPathExamples,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summaryPath = resolve(args.outDir, "summary.fast-binance-download.json");
  const retrySummaryPath = resolve(args.outDir, "summary.fast-binance-download.retry.json");
  const summary = await readJsonIfExists<Summary>(summaryPath);
  const retrySummary = await readJson<Summary>(retrySummaryPath);
  const [zipFiles, partFiles] = await Promise.all([
    countFilesWithSuffix(args.outDir, ".zip"),
    countFilesWithSuffix(args.outDir, ".part"),
  ]);

  const retryFiles = numberValue(retrySummary.files);
  const retryDownloaded = numberValue(retrySummary.totals?.downloaded);
  const retryExists = numberValue(retrySummary.totals?.exists);
  const retryFailed = numberValue(retrySummary.totals?.failed);
  const retryMissing = numberValue(retrySummary.totals?.missing);

  if (!summary) {
    const manifestPath = stringValue(
      typeof retrySummary.manifestPath === "string" ? retrySummary.manifestPath : undefined,
      resolve(args.outDir, "manifest.fast-binance-download.jsonl")
    );
    const manifest = await readManifestSnapshot(manifestPath);
    const checks = {
      retrySucceeded:
        retrySummary.coverage === "complete" &&
        retryFailed === 0 &&
        retryMissing === 0 &&
        retryDownloaded + retryExists === retryFiles,
      manifestHasZipPaths: manifest.uniqueZipPaths > 0,
      manifestRecordsHaveZipPaths: manifest.recordsWithoutZipPath === 0,
      manifestLatestRecordsAllOk: manifest.latestNonOkRecords === 0,
      allManifestZipPathsExist: manifest.missingZipPaths === 0,
      zipCountMatchesManifest: zipFiles === manifest.uniqueZipPaths,
      noPartFiles: partFiles === 0,
    };
    const failedChecks = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failedChecks.length > 0) {
      console.error(
        `cannot finalize summary from manifest: ${JSON.stringify({
          failedChecks,
          retryFiles,
          retryDownloaded,
          retryExists,
          retryFailed,
          retryMissing,
          retryCoverage: retrySummary.coverage,
          zipFiles,
          partFiles,
          manifest,
        })}`
      );
      process.exitCode = 2;
      return;
    }

    const now = new Date().toISOString();
    const finalized: Summary = {
      startedAt: retrySummary.startedAt,
      endedAt: now,
      mode: "manifest_reconciliation",
      args: retrySummary.args,
      files: manifest.uniqueZipPaths,
      totals: {
        downloaded: 0,
        exists: manifest.uniqueZipPaths,
        missing: 0,
        failed: 0,
      },
      manifestPath,
      coverage: "complete",
      finalizedAt: now,
      finalizedFrom: {
        method: "local_manifest_zip_reconciliation",
        retrySummaryPath,
        retryTotals: retrySummary.totals,
        retryFiles,
        retryCoverage: retrySummary.coverage,
        manifest,
        zipFiles,
        partFiles,
      },
    };
    await writeFile(summaryPath, `${JSON.stringify(finalized, null, 2)}\n`);
    console.log(`finalized summary: ${summaryPath}`);
    return;
  }

  const files = numberValue(summary.files);
  const originalFailed = numberValue(summary.totals?.failed);
  const originalMissing = numberValue(summary.totals?.missing);

  const checks = {
    hasPartialOrCompleteSummary: summary.coverage === "partial" || summary.coverage === "complete",
    originalHadNoMissing: originalMissing === 0,
    retryCoversOriginalFailed: retryFiles === originalFailed,
    retrySucceeded: retryFailed === 0 && retryMissing === 0 && retryDownloaded + retryExists === retryFiles,
    zipCountMatches: zipFiles === files,
    noPartFiles: partFiles === 0,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedChecks.length > 0) {
    console.error(
      `cannot finalize summary: ${JSON.stringify({
        failedChecks,
        files,
        originalFailed,
        originalMissing,
        retryFiles,
        retryDownloaded,
        retryExists,
        retryFailed,
        retryMissing,
        zipFiles,
        partFiles,
      })}`
    );
    process.exitCode = 2;
    return;
  }

  const finalized: Summary = {
    ...summary,
    endedAt: new Date().toISOString(),
    totals: {
      downloaded: 0,
      exists: files,
      missing: 0,
      failed: 0,
    },
    coverage: "complete",
    finalizedAt: new Date().toISOString(),
    finalizedFrom: {
      method: "local_retry_manifest_reconciliation",
      originalTotals: summary.totals,
      retryTotals: retrySummary.totals,
      zipFiles,
      partFiles,
    },
  };
  await writeFile(summaryPath, `${JSON.stringify(finalized, null, 2)}\n`);
  console.log(`finalized summary: ${summaryPath}`);
}

main().catch(err => {
  console.error("finalize_fast_binance_data_vision_summary failed:", err);
  process.exit(1);
});
