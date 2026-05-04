import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface CandleRow {
  timestamp: string;
  iso: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface StrictRequestNewsItem {
  headline: string;
  summary: string;
  source: string;
  publishedAt: string;
  url?: string;
}

export async function readCandles(
  path: string,
  opts: {
    lookbackBars: number;
    windowStart?: string;
    windowEnd?: string;
  },
): Promise<CandleRow[]> {
  const raw = await readFile(resolve(path), "utf-8");
  const lines = raw.trim().split("\n");
  const [header, ...rows] = lines;
  if (!header) return [];
  const keys = header.split(",");
  const parsed = rows
    .map((line) => {
      const values = line.split(",");
      const row = Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ""])) as Record<
        string,
        string
      >;
      return row as unknown as CandleRow;
    })
    .filter((row) => row.iso);
  const bounded = filterCandlesByWindow(parsed, opts.windowStart, opts.windowEnd);
  return bounded.slice(Math.max(0, bounded.length - opts.lookbackBars));
}

export async function readNewsItems(path: string | undefined): Promise<StrictRequestNewsItem[]> {
  if (!path) return [];
  const raw = await readFile(resolve(path), "utf-8");
  const parsed = parseNewsPayload(raw);
  return parsed.flatMap((item) => {
    const normalized = normalizeNewsItem(item);
    return normalized ? [normalized] : [];
  });
}

export function normalizeNewsItem(item: unknown): StrictRequestNewsItem | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Record<string, unknown>;
  const headline =
    stringField(value.headline) ??
    stringField(value.title) ??
    stringField(value.name);
  const summary =
    stringField(value.summary) ??
    stringField(value.description) ??
    stringField(value.content) ??
    headline;
  const source =
    stringField(value.source) ??
    stringField(value.publisher) ??
    stringField(value.provider) ??
    "unknown";
  const publishedAt =
    stringField(value.publishedAt) ??
    stringField(value.published_at) ??
    stringField(value.date) ??
    stringField(value.timestamp);
  if (!headline || !summary || !publishedAt) return null;
  const url = stringField(value.url) ?? stringField(value.link);
  return {
    headline,
    summary,
    source,
    publishedAt,
    ...(url ? { url } : {}),
  };
}

function filterCandlesByWindow(
  candles: CandleRow[],
  windowStart?: string,
  windowEnd?: string,
): CandleRow[] {
  const startMs = parseOptionalTime(windowStart);
  const endMs = parseOptionalTime(windowEnd);
  if (startMs === null && endMs === null) {
    return candles;
  }
  return candles.filter((row) => {
    const rowMs = parseOptionalTime(row.iso);
    if (rowMs === null) return false;
    if (startMs !== null && rowMs < startMs) return false;
    if (endMs !== null && rowMs > endMs) return false;
    return true;
  });
}

function parseOptionalTime(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNewsPayload(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)) {
      return (parsed as { items: unknown[] }).items;
    }
    return [parsed];
  } catch {
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
