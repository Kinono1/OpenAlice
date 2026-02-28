import { describe, expect, it } from "vitest";
import type { NewsItem } from "./interfaces";
import {
  mergeInstitutionalNews,
  parseRssNews,
  type MultiSourceNewsConfig,
} from "./news-sources.js";

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>ETF inflows accelerate for crypto products</title>
      <link>https://example.com/etf-inflows?utm_source=x</link>
      <description>Institutional flow remains strong.</description>
      <pubDate>Sun, 22 Feb 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Security breach triggers exchange withdrawals</title>
      <link>https://example.com/security-breach</link>
      <description>Traders react to hack-related concerns.</description>
      <pubDate>Sun, 22 Feb 2026 09:30:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

function makeConfig(): MultiSourceNewsConfig {
  return {
    enabled: true,
    lookbackHours: 72,
    maxTotalItems: 200,
    dedupeByTitleHours: 6,
    requestTimeoutMs: 6000,
    dotApiSourcePriority: 0.75,
    sources: [
      {
        id: "coindesk_rss",
        enabled: true,
        type: "rss",
        source: "CoinDesk",
        url: "https://example.com/rss",
        timeoutMs: 3000,
        maxItems: 50,
        category: "institutional-news",
        priority: 0.9,
      },
    ],
  };
}

describe("news-sources", () => {
  it("parses rss items into normalized NewsItem entries", () => {
    const source = makeConfig().sources[0];
    const parsed = parseRssNews(SAMPLE_RSS, source);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].metadata.source).toBe("CoinDesk");
    expect(parsed[0].metadata.sourceType).toBe("rss");
    expect(parsed[0].metadata.sourceUrl).toContain("example.com");
    expect(parsed[0].time).toBeInstanceOf(Date);
  });

  it("merges external feeds with dotapi feed and deduplicates by source url/title", async () => {
    const baseNews: NewsItem[] = [
      {
        time: new Date("2026-02-22T10:00:30.000Z"),
        title: "ETF inflows accelerate for crypto products",
        content: "TechFlow repost of same headline.",
        metadata: {
          source: "TechFlow",
          sourceUrl: "https://example.com/etf-inflows",
          category: "crypto-news",
        },
      },
    ];

    const merged = await mergeInstitutionalNews(baseNews, makeConfig(), {
      now: new Date("2026-02-22T12:00:00.000Z"),
      fetchImpl: async () =>
        new Response(SAMPLE_RSS, {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        }),
    });

    expect(merged.length).toBe(2);
    const etf = merged.find((n) => n.title.includes("ETF inflows"));
    expect(etf).toBeDefined();
    expect(etf?.metadata.source).toBe("CoinDesk");
    expect(etf?.metadata.sourcePriority).toBe("0.9");
  });

  it("keeps base feed when external source fails", async () => {
    const baseNews: NewsItem[] = [
      {
        time: new Date("2026-02-22T10:00:30.000Z"),
        title: "Base headline",
        content: "Fallback item",
        metadata: { source: "TechFlow", category: "crypto-news" },
      },
    ];

    const merged = await mergeInstitutionalNews(baseNews, makeConfig(), {
      now: new Date("2026-02-22T12:00:00.000Z"),
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });

    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("Base headline");
  });
});

