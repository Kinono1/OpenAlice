import type { NewsItem } from "./interfaces";

export interface InstitutionalNewsSourceConfig {
  id: string;
  enabled: boolean;
  type: "rss";
  source: string;
  url: string;
  timeoutMs: number;
  maxItems: number;
  category: string;
  priority: number;
}

export interface MultiSourceNewsConfig {
  enabled: boolean;
  lookbackHours: number;
  maxTotalItems: number;
  dedupeByTitleHours: number;
  requestTimeoutMs: number;
  dotApiSourcePriority: number;
  sources: InstitutionalNewsSourceConfig[];
}

interface MergeOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
}

const DEFAULT_FETCH_TIMEOUT_MS = 6_000;

function decodeHtml(input: string): string {
  return input
    .replace(/<!\[CDATA\[(.*?)\]\]>/gis, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractBlocks(xml: string, tag: "item" | "entry"): string[] {
  const reg = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = reg.exec(xml)) !== null) {
    out.push(match[1]);
  }
  return out;
}

function extractTagText(block: string, tagName: string): string | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reg = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i");
  const match = block.match(reg);
  if (!match?.[1]) {
    return null;
  }
  return stripTags(decodeHtml(match[1]));
}

function extractAtomLink(block: string): string | null {
  const selfClosing = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (selfClosing?.[1]) {
    return selfClosing[1].trim();
  }
  const rssStyle = extractTagText(block, "link");
  return rssStyle ? rssStyle.trim() : null;
}

function parseTimestamp(raw: string | null): Date | null {
  if (!raw) {
    return null;
  }
  const parsed = Date.parse(raw.trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed);
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || key === "ref" || key === "source") {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 220);
}

function parseSourcePriority(item: NewsItem, fallback: number): number {
  const raw = item.metadata?.sourcePriority;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return fallback;
}

function dedupeAndSortNews(
  items: NewsItem[],
  dedupeByTitleHours: number,
  fallbackPriority: number,
): NewsItem[] {
  const dedupeMs = Math.max(1, dedupeByTitleHours) * 3_600_000;
  const byUrl = new Map<string, NewsItem>();
  const byTitleWindow = new Map<string, NewsItem>();

  const chooseWinner = (a: NewsItem, b: NewsItem) => {
    const pa = parseSourcePriority(a, fallbackPriority);
    const pb = parseSourcePriority(b, fallbackPriority);
    if (pb > pa) {
      return b;
    }
    if (pb < pa) {
      return a;
    }
    return b.time.getTime() >= a.time.getTime() ? b : a;
  };

  for (const item of items) {
    const sourceUrl = item.metadata?.sourceUrl?.trim();
    if (sourceUrl) {
      const key = `url:${normalizeUrl(sourceUrl)}`;
      const existing = byUrl.get(key);
      byUrl.set(key, existing ? chooseWinner(existing, item) : item);
      continue;
    }

    const normalizedTitle = normalizeTitle(item.title);
    const bucket = Math.floor(item.time.getTime() / dedupeMs);
    const key = `title:${normalizedTitle}|bucket:${bucket}`;
    const existing = byTitleWindow.get(key);
    byTitleWindow.set(key, existing ? chooseWinner(existing, item) : item);
  }

  const merged = [...byUrl.values(), ...byTitleWindow.values()];
  merged.sort((a, b) => a.time.getTime() - b.time.getTime());
  return merged;
}

export function parseRssNews(xml: string, source: InstitutionalNewsSourceConfig): NewsItem[] {
  const blocks = extractBlocks(xml, "item");
  const entries = blocks.length > 0 ? blocks : extractBlocks(xml, "entry");

  const out: NewsItem[] = [];
  for (const block of entries) {
    const title =
      extractTagText(block, "title") ??
      extractTagText(block, "headline") ??
      extractTagText(block, "summary");

    if (!title || title.length < 6) {
      continue;
    }

    const content =
      extractTagText(block, "content:encoded") ??
      extractTagText(block, "description") ??
      extractTagText(block, "summary") ??
      title;

    const link = extractAtomLink(block);
    const time =
      parseTimestamp(extractTagText(block, "pubDate")) ??
      parseTimestamp(extractTagText(block, "updated")) ??
      parseTimestamp(extractTagText(block, "published")) ??
      parseTimestamp(extractTagText(block, "dc:date"));

    if (!time) {
      continue;
    }

    out.push({
      time,
      title,
      content,
      metadata: {
        source: source.source,
        sourceUrl: link ?? source.url,
        category: source.category,
        sourceId: source.id,
        sourceType: source.type,
        sourcePriority: String(source.priority),
      },
    });
  }

  return out.slice(0, source.maxItems);
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSourceNews(
  source: InstitutionalNewsSourceConfig,
  config: MultiSourceNewsConfig,
  options: MergeOptions,
): Promise<NewsItem[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs =
    Number.isFinite(source.timeoutMs) && source.timeoutMs > 0
      ? source.timeoutMs
      : Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
        ? config.requestTimeoutMs
        : DEFAULT_FETCH_TIMEOUT_MS;

  const res = await fetchWithTimeout(fetchImpl, source.url, timeoutMs);
  if (!res.ok) {
    throw new Error(`[${source.id}] ${res.status} ${res.statusText}`);
  }
  const body = await res.text();
  return parseRssNews(body, source);
}

function clampToLookback(news: NewsItem[], now: Date, lookbackHours: number): NewsItem[] {
  const lookbackMs = Math.max(1, lookbackHours) * 3_600_000;
  const start = now.getTime() - lookbackMs;
  return news.filter((item) => {
    const ts = item.time.getTime();
    return ts <= now.getTime() && ts >= start;
  });
}

function withDotApiPriority(news: NewsItem[], priority: number): NewsItem[] {
  return news.map((item) => ({
    ...item,
    metadata: {
      ...item.metadata,
      source: item.metadata?.source ?? "TechFlow",
      sourceType: item.metadata?.sourceType ?? "dotapi",
      sourcePriority: item.metadata?.sourcePriority ?? String(priority),
    },
  }));
}

export async function mergeInstitutionalNews(
  baseNews: NewsItem[],
  config: MultiSourceNewsConfig,
  options?: MergeOptions,
): Promise<NewsItem[]> {
  const now = options?.now ?? new Date();
  const normalizedBase = withDotApiPriority(baseNews, config.dotApiSourcePriority);
  if (!config.enabled) {
    return clampToLookback(normalizedBase, now, config.lookbackHours);
  }

  const enabledSources = config.sources.filter((source) => source.enabled);
  if (enabledSources.length === 0) {
    return clampToLookback(normalizedBase, now, config.lookbackHours);
  }

  const results = await Promise.allSettled(
    enabledSources.map((source) => fetchSourceNews(source, config, options ?? {})),
  );

  const externalNews: NewsItem[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      externalNews.push(...result.value);
    } else {
      console.warn("news-source fetch failed:", result.reason);
    }
  }

  const merged = dedupeAndSortNews(
    [...normalizedBase, ...externalNews],
    config.dedupeByTitleHours,
    config.dotApiSourcePriority,
  );

  const bounded = clampToLookback(merged, now, config.lookbackHours);
  if (bounded.length > config.maxTotalItems) {
    return bounded.slice(-config.maxTotalItems);
  }
  return bounded;
}
