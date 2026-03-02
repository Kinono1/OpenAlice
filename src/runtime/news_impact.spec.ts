import { describe, expect, it } from "vitest";
import type { NewsItem } from "../extension/analysis-kit/data/interfaces.js";
import { analyzeNewsImpact } from "./news_impact.js";

function makeNews(
  time: string,
  title: string,
  content: string,
  source = "TechFlow",
): NewsItem {
  return {
    time: new Date(time),
    title,
    content,
    metadata: {
      source,
      category: "crypto-news",
    },
  };
}

describe("news_impact", () => {
  it("produces positive sentiment when constructive headlines dominate", () => {
    const news: NewsItem[] = [
      makeNews(
        "2026-02-22T10:00:00.000Z",
        "Spot ETF records strong inflow as institutions accumulate",
        "Institutional inflow and tokenized fund partnership improve market outlook.",
      ),
      makeNews(
        "2026-02-22T11:00:00.000Z",
        "Protocol upgrade approved after governance vote",
        "Upgrade and roadmap approval expected to support adoption.",
      ),
    ];

    const summary = analyzeNewsImpact(news, { now: new Date("2026-02-22T12:00:00.000Z") });
    expect(summary.totalNews).toBe(2);
    expect(summary.sentimentScore).toBeGreaterThan(0);
    expect(summary.positiveNews).toBe(2);
    expect(summary.riskScore).toBeLessThan(0.4);
  });

  it("raises risk score and flags on severe security or enforcement events", () => {
    const news: NewsItem[] = [
      makeNews(
        "2026-02-22T08:00:00.000Z",
        "Major protocol hacked; funds drained in exploit",
        "Security breach and exploit trigger heavy losses.",
      ),
      makeNews(
        "2026-02-22T09:00:00.000Z",
        "Court filing confirms laundering fraud case",
        "Fraud and laundering investigation expands to multiple accounts.",
      ),
    ];

    const summary = analyzeNewsImpact(news, { now: new Date("2026-02-22T12:00:00.000Z") });
    expect(summary.riskScore).toBeGreaterThan(0.5);
    expect(summary.highRiskNews).toBe(2);
    expect(summary.flags.length).toBeGreaterThan(0);
    expect(summary.sentimentScore).toBeLessThan(0);
  });
});

