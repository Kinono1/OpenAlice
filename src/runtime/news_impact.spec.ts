import { describe, expect, it } from "vitest";
import type { NewsItem } from "../extension/analysis-kit/data/interfaces.js";
import {
  analyzeEthCarryNewsImpact,
  analyzeNewsImpact,
} from "./news_impact.js";

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

  it("downgrades fraud and enforcement to elevated-only", () => {
    const news: NewsItem[] = [
      makeNews(
        "2026-02-22T08:00:00.000Z",
        "Court filing confirms laundering fraud case",
        "Fraud and enforcement investigation expands to multiple accounts.",
      ),
    ];

    const summary = analyzeNewsImpact(news, { now: new Date("2026-02-22T12:00:00.000Z") });
    expect(summary.overlay?.riskRegime).toBe("elevated");
    expect(summary.overlay?.hardVeto).toBe(false);
    expect(summary.highRiskNews).toBe(1);
    expect(summary.flags).toHaveLength(1);
    expect(summary.flags[0]).toMatchObject({
      reason: "fraud_or_enforcement",
      severity: "elevated",
    });
  });

  it("deduplicates near-identical severe headlines within six hours", () => {
    const news: NewsItem[] = [
      makeNews(
        "2026-02-22T08:00:00.000Z",
        "Major protocol hacked",
        "Hack reported after the incident.",
      ),
      makeNews(
        "2026-02-22T10:00:00.000Z",
        "Major protocol hacked",
        "Hack reported after the incident.",
      ),
    ];

    const summary = analyzeNewsImpact(news, { now: new Date("2026-02-22T12:00:00.000Z") });
    expect(summary.overlay?.riskRegime).toBe("severe");
    expect(summary.overlay?.hardVeto).toBe(true);
    expect(summary.highRiskNews).toBe(1);
    expect(summary.flags).toHaveLength(1);
    expect(summary.flags[0]).toMatchObject({
      reason: "security_incident",
      severity: "severe",
    });
  });

  it("decays severe impact after eight hours and drops it after twelve", () => {
    const decayedSevere = analyzeNewsImpact(
      [
        makeNews(
          "2026-02-22T00:30:00.000Z",
          "Major protocol hacked",
          "Security breach reported after the hack.",
        ),
      ],
      { now: new Date("2026-02-22T12:00:00.000Z") },
    );

    expect(decayedSevere.overlay?.riskRegime).toBe("severe");
    expect(decayedSevere.overlay?.hardVeto).toBe(false);
    expect(decayedSevere.overlay?.exposureMultiplier).toBeGreaterThan(0.35);
    expect(decayedSevere.overlay?.exposureMultiplier).toBeLessThan(1);

    const agedOutSevere = analyzeNewsImpact(
      [
        makeNews(
          "2026-02-21T23:00:00.000Z",
          "Major protocol hacked with exploit and breach",
          "Security breach, exploit, and loss reported after the hack.",
        ),
      ],
      { now: new Date("2026-02-22T12:00:00.000Z") },
    );

    expect(agedOutSevere.overlay?.hardVeto).toBe(false);
    expect(agedOutSevere.overlay?.riskRegime).toBe("elevated");
    expect(agedOutSevere.riskScore).toBeGreaterThan(0);
  });

  it("does not escalate generic macro or tariff headlines to severe", () => {
    const news: NewsItem[] = [
      makeNews(
        "2026-02-22T10:00:00.000Z",
        "Tariff data preview and CPI outlook keep markets cautious",
        "Macro data, tariff debate, and Fed rates dominate the session.",
      ),
    ];

    const summary = analyzeNewsImpact(news, { now: new Date("2026-02-22T12:00:00.000Z") });
    expect(summary.overlay?.hardVeto).toBe(false);
    expect(summary.overlay?.riskRegime).not.toBe("severe");
  });

  it("does not escalate geopolitical commentary headlines to severe", () => {
    const news: NewsItem[] = [
      makeNews(
        "2026-02-22T10:00:00.000Z",
        "Bitwise says geopolitical tension lifts bitcoin's appeal and calls $1 million a possible baseline price",
        "Research commentary argues tension could improve bitcoin demand over time.",
        "Reuters",
      ),
    ];

    const summary = analyzeNewsImpact(news, { now: new Date("2026-02-22T12:00:00.000Z") });
    expect(summary.overlay?.hardVeto).toBe(false);
    expect(summary.flags.some(flag => flag.reason === "geopolitical_risk")).toBe(false);
  });

  it("does not escalate market-rally headlines that only reference conflict as background context", () => {
    const news: NewsItem[] = [
      makeNews(
        "2026-02-22T10:00:00.000Z",
        "Hive, Bitfarms lead bitcoin miner rally with 11% gains as BTC hits two-month high",
        "Bitcoin climbed while equities recovered losses tied to the conflict in Iran.",
        "TheBlock",
      ),
    ];

    const summary = analyzeNewsImpact(news, { now: new Date("2026-02-22T12:00:00.000Z") });
    expect(summary.overlay?.hardVeto).toBe(false);
    expect(summary.flags.some(flag => flag.reason === "geopolitical_risk")).toBe(false);
  });

  it("does not escalate generic cybersecurity headlines without crypto incident context to severe", () => {
    const news: NewsItem[] = [
      makeNews(
        "2026-02-22T10:00:00.000Z",
        "Anthropic research reveals more vulnerabilities for cyberattacks",
        "A general software security discussion about enterprise cyberattacks and AI systems.",
        "Reuters",
      ),
    ];

    const summary = analyzeNewsImpact(news, { now: new Date("2026-02-22T12:00:00.000Z") });
    expect(summary.overlay?.hardVeto).toBe(false);
    expect(summary.flags.some(flag => flag.reason === "security_incident")).toBe(false);
  });

  it("keeps generic parsing clean while ETH carry helper escalates binance and okx incidents", () => {
    const incidentNews: NewsItem[] = [
      makeNews(
        "2026-02-22T08:00:00.000Z",
        "Binance suspends withdrawals after security incident",
        "Binance reports a service outage after an exchange incident.",
        "Reuters",
      ),
    ];

    const generic = analyzeNewsImpact(incidentNews, { now: new Date("2026-02-22T12:00:00.000Z") });
    expect(generic.overlay?.hardVeto).toBe(false);

    const ethCarry = analyzeEthCarryNewsImpact(incidentNews, {
      now: new Date("2026-02-22T12:00:00.000Z"),
    });
    expect(ethCarry.overlay?.hardVeto).toBe(true);
    expect(ethCarry.overlay?.riskRegime).toBe("severe");
    expect(ethCarry.flags.some(flag => flag.reason === "eth_carry_exchange_incident:binance")).toBe(
      true,
    );
  });
});
