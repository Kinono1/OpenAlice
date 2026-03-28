import { describe, expect, it } from "vitest";
import { createAlphaCandidate } from "./candidates";
import { buildTournamentLeaderboard } from "./tournament";

describe("strategy tournament", () => {
  it("ranks stronger entrants first and promotes them", () => {
    const leaderboard = buildTournamentLeaderboard(
      [
        {
          candidate: createAlphaCandidate({
            family: "core_trend",
            strategy: "trend",
            seedName: "winner",
          }),
          summary: {
            strategy: "trend",
            params: {},
            metrics: {
              totalReturnPct: 48,
              annualizedReturnPct: 20,
              maxDrawdownPct: 12,
              sharpe: 1.8,
              winRatePct: 55,
              profitFactor: 1.5,
              tradeCount: 24,
              totalFeesPaid: 30,
              totalSlippagePaid: 20,
              totalFundingPaid: 0,
              finalEquity: 12000,
            },
          },
        },
        {
          candidate: createAlphaCandidate({
            family: "core_breakout",
            strategy: "breakout",
            seedName: "loser",
          }),
          summary: {
            strategy: "breakout",
            params: {},
            metrics: {
              totalReturnPct: 8,
              annualizedReturnPct: 4,
              maxDrawdownPct: 18,
              sharpe: 0.3,
              winRatePct: 48,
              profitFactor: 1.1,
              tradeCount: 8,
              totalFeesPaid: 40,
              totalSlippagePaid: 30,
              totalFundingPaid: 0,
              finalEquity: 10100,
            },
          },
        },
      ],
      { generatedAt: "2026-03-28T00:00:00.000Z" },
    );

    expect(leaderboard.generatedAt).toBe("2026-03-28T00:00:00.000Z");
    expect(leaderboard.winnerCandidateId).toBe(
      leaderboard.entries[0]?.candidateId,
    );
    expect(leaderboard.entries[0]?.verdict).toBe("promote");
  });

  it("rejects entrants with too few trades", () => {
    const leaderboard = buildTournamentLeaderboard([
      {
        candidate: createAlphaCandidate({
          family: "core_mean_reversion",
          strategy: "meanReversion",
        }),
        summary: {
          strategy: "meanReversion",
          params: {},
          metrics: {
            totalReturnPct: 20,
            annualizedReturnPct: 11,
            maxDrawdownPct: 10,
            sharpe: 1.1,
            winRatePct: 60,
            profitFactor: 1.4,
            tradeCount: 1,
            totalFeesPaid: 2,
            totalSlippagePaid: 2,
            totalFundingPaid: 0,
            finalEquity: 10400,
          },
        },
      },
    ]);

    expect(leaderboard.entries[0]?.verdict).toBe("reject");
    expect(leaderboard.entries[0]?.reasons).toContain("trade_count_below_min");
  });

  it("rejects entrants with excessive drawdown", () => {
    const leaderboard = buildTournamentLeaderboard([
      {
        candidate: createAlphaCandidate({
          family: "core_breakout",
          strategy: "breakout",
        }),
        summary: {
          strategy: "breakout",
          params: {},
          metrics: {
            totalReturnPct: 30,
            annualizedReturnPct: 14,
            maxDrawdownPct: 50,
            sharpe: 1,
            winRatePct: 50,
            profitFactor: 1.3,
            tradeCount: 12,
            totalFeesPaid: 10,
            totalSlippagePaid: 10,
            totalFundingPaid: 0,
            finalEquity: 11000,
          },
        },
      },
    ]);

    expect(leaderboard.entries[0]?.verdict).toBe("reject");
    expect(leaderboard.entries[0]?.reasons).toContain("drawdown_above_limit");
  });

  it("breaks ties by candidate id", () => {
    const leaderboard = buildTournamentLeaderboard([
      {
        candidate: createAlphaCandidate({
          family: "core_trend",
          strategy: "trend",
          seedName: "b",
          params: { trendFastPeriod: 20, trendSlowPeriod: 50 },
        }),
        summary: {
          strategy: "trend",
          params: {},
          metrics: {
            totalReturnPct: 10,
            annualizedReturnPct: 10,
            maxDrawdownPct: 10,
            sharpe: 1,
            winRatePct: 50,
            profitFactor: 1.1,
            tradeCount: 10,
            totalFeesPaid: 5,
            totalSlippagePaid: 5,
            totalFundingPaid: 0,
            finalEquity: 10500,
          },
        },
      },
      {
        candidate: createAlphaCandidate({
          family: "core_trend",
          strategy: "trend",
          seedName: "a",
          params: { trendFastPeriod: 10, trendSlowPeriod: 30 },
        }),
        summary: {
          strategy: "trend",
          params: {},
          metrics: {
            totalReturnPct: 10,
            annualizedReturnPct: 10,
            maxDrawdownPct: 10,
            sharpe: 1,
            winRatePct: 50,
            profitFactor: 1.1,
            tradeCount: 10,
            totalFeesPaid: 5,
            totalSlippagePaid: 5,
            totalFundingPaid: 0,
            finalEquity: 10500,
          },
        },
      },
    ]);

    expect(leaderboard.entries[0]?.candidateId).toBe(
      "core_trend:trend:trendFastPeriod=10|trendSlowPeriod=30",
    );
  });
});
