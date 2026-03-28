import { mkdir, readdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { spawn } from "child_process";

export type JsonObject = Record<string, unknown>;

export function parseRawArgs(argv: string[]): Map<string, string> {
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

export function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const out = raw
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

export function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const val = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(val)) return true;
  if (["0", "false", "no", "n", "off"].includes(val)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

export function parseIntArg(
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

export function parseNumberArg(
  raw: string | undefined,
  fallback: number,
  label: string
): number {
  if (raw == null) return fallback;
  const val = Number(raw);
  if (!Number.isFinite(val) || val <= 0) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return val;
}

export function parseDateMs(raw: string | undefined, fallback: number): number {
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

export function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => {
    setTimeout(resolvePromise, ms);
  });
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function toIso(ts: number): string {
  return new Date(ts).toISOString();
}

export function monthKey(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJsonFile<T = JsonObject>(
  path: string,
  fallback: T
): Promise<T> {
  if (!(await fileExists(path))) return fallback;
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(path: string, payload: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function runProcess(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    proc.on("error", rejectPromise);
    proc.on("close", code => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${cmd} exited with code=${code}: ${stderr || "unknown error"}`)
      );
    });
  });
}

export async function ensureCsvFromZst(csvPath: string): Promise<void> {
  if (await fileExists(csvPath)) return;
  const zstPath = `${csvPath}.zst`;
  if (!(await fileExists(zstPath))) return;
  await ensureDir(dirname(csvPath));
  await runProcess("zstd", ["-q", "-f", "-d", zstPath, "-o", csvPath]);
}

export async function compressCsvToZst(csvPath: string): Promise<void> {
  if (!(await fileExists(csvPath))) return;
  const zstPath = `${csvPath}.zst`;
  await runProcess("zstd", ["-q", "-f", "-T0", "-3", csvPath, "-o", zstPath]);
  await unlink(csvPath);
}

export async function directorySizeBytes(path: string): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = resolve(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else {
        try {
          const s = await stat(full);
          total += s.size;
        } catch {
          // ignore races
        }
      }
    }
  }
  await walk(path);
  return total;
}

export async function listFilesRecursive(
  path: string,
  suffixes: string[]
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = resolve(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (suffixes.some(sfx => full.endsWith(sfx))) {
        out.push(full);
      }
    }
  }
  await walk(path);
  return out.sort((a, b) => a.localeCompare(b));
}

export async function withRetry<T>(
  task: () => Promise<T>,
  opts: {
    maxRetries: number;
    baseDelayMs: number;
    label: string;
  }
): Promise<T> {
  let backoff = Math.max(50, opts.baseDelayMs);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxRetries; attempt += 1) {
    try {
      return await task();
    } catch (err) {
      lastErr = err;
      if (attempt >= opts.maxRetries) break;
      console.warn(
        `[retry] ${opts.label} attempt ${attempt}/${opts.maxRetries} failed: ${String(
          err
        )}; sleep=${backoff}ms`
      );
      await sleep(backoff);
      backoff *= 2;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function parseSizeBytes(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const trimmed = raw.trim().toLowerCase();
  const m = trimmed.match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb)?$/);
  if (!m) {
    throw new Error(`Invalid size format: ${raw}`);
  }
  const num = Number(m[1]);
  const unit = m[2] ?? "b";
  const mul =
    unit === "tb"
      ? 1024 ** 4
      : unit === "gb"
        ? 1024 ** 3
        : unit === "mb"
          ? 1024 ** 2
          : unit === "kb"
            ? 1024
            : 1;
  return Math.floor(num * mul);
}

export function bytesToHuman(n: number): string {
  if (n < 1024) return `${n}B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(2)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)}MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb.toFixed(2)}GB`;
  return `${(gb / 1024).toFixed(2)}TB`;
}
