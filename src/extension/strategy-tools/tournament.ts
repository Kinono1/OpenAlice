import type { AlphaCandidate } from "./candidates.js";
import type { StrategyDecision, StrategyParams, StrategyName } from "./types.js";

export interface TournamentSummaryMetrics {
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  winRatePct: number;
  profitFactor: number;
  tradeCount: number;
  totalFeesPaid: number;
  totalSlippagePaid: number;
  totalFundingPaid: number;
  finalEquity: number;
}

export interface TournamentSummary {
  strategy: StrategyName;
  params: StrategyParams;
  metrics: TournamentSummaryMetrics;
  lastDecision?: StrategyDecision;
}

export type TournamentEntrantSummary = TournamentSummary;

export interface TournamentEntrant {
  candidate: AlphaCandidate;
  summary: TournamentSummary;
  source?: string;
}

export interface TournamentScoreBreakdown {
  returnScore: number;
  sharpeScore: number;
  drawdownPenalty: number;
  tradeCountScore: number;
  costPenalty: number;
  totalScore: number;
}

export type TournamentVerdict = "promote" | "watch" | "reject";

export interface TournamentEntry {
  rank: number;
  candidateId: string;
  family: AlphaCandidate["family"];
  strategy: StrategyName;
  seedName: string;
  score: TournamentScoreBreakdown;
  metrics: TournamentSummaryMetrics;
  lastDecision?: StrategyDecision;
  verdict: TournamentVerdict;
  reasons: string[];
}

export interface TournamentLeaderboard {
  generatedAt: string;
  entryCount: number;
  winnerCandidateId: string | null;
  entries: TournamentEntry[];
}

export interface TournamentOptions {
  minTradeCount?: number;
  maxDrawdownPct?: number;
  promotionScoreMin?: number;
  watchScoreMin?: number;
  generatedAt?: string;
}

const DEFAULT_OPTIONS: Required<TournamentOptions> = {
  minTradeCount: 3,
  maxDrawdownPct: 35,
  promotionScoreMin: 0.35,
  watchScoreMin: 0.1,
  generatedAt: "1970-01-01T00:00:00.000Z",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function scoreTournamentEntrant(
  entrant: TournamentEntrant,
): TournamentScoreBreakdown {
  const metrics = entrant.summary.metrics;
  const returnScore = clamp(metrics.totalReturnPct / 100, -1, 1);
  const sharpeScore = clamp(metrics.sharpe / 3, -1, 1) * 0.8;
  const drawdownPenalty = clamp(metrics.maxDrawdownPct / 100, 0, 1);
  const tradeCountScore = clamp(metrics.tradeCount / 20, 0, 1) * 0.25;
  const totalCosts =
    metrics.totalFeesPaid + metrics.totalSlippagePaid + metrics.totalFundingPaid;
  const costPenalty = clamp(totalCosts / Math.max(metrics.finalEquity, 1), 0, 1);
  const totalScore =
    returnScore * 0.45 +
    sharpeScore * 0.3 +
    tradeCountScore * 0.15 -
    drawdownPenalty * 0.2 -
    costPenalty * 0.15;

  return {
    returnScore: round(returnScore),
    sharpeScore: round(sharpeScore),
    drawdownPenalty: round(drawdownPenalty),
    tradeCountScore: round(tradeCountScore),
    costPenalty: round(costPenalty),
    totalScore: round(totalScore),
  };
}

function buildVerdict(
  entrant: TournamentEntrant,
  score: TournamentScoreBreakdown,
  options: Required<TournamentOptions>,
): Pick<TournamentEntry, "verdict" | "reasons"> {
  const metrics = entrant.summary.metrics;
  const reasons: string[] = [];

  if (metrics.tradeCount < options.minTradeCount) {
    reasons.push("trade_count_below_min");
  }
  if (metrics.maxDrawdownPct > options.maxDrawdownPct) {
    reasons.push("drawdown_above_limit");
  }

  if (reasons.length > 0 || score.totalScore < options.watchScoreMin) {
    reasons.push("score_reject");
    return { verdict: "reject", reasons };
  }
  if (score.totalScore >= options.promotionScoreMin) {
    reasons.push("score_promote");
    return { verdict: "promote", reasons };
  }
  reasons.push("score_watch");
  return { verdict: "watch", reasons };
}

export function buildTournamentLeaderboard(
  entrants: TournamentEntrant[],
  options: TournamentOptions = {},
): TournamentLeaderboard {
  const resolved: Required<TournamentOptions> = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const ranked = entrants
    .map((entrant) => {
      const score = scoreTournamentEntrant(entrant);
      const verdict = buildVerdict(entrant, score, resolved);
      return {
        entrant,
        score,
        verdict,
      };
    })
    .sort((left, right) => {
      if (right.score.totalScore !== left.score.totalScore) {
        return right.score.totalScore - left.score.totalScore;
      }
      if (
        right.entrant.summary.metrics.totalReturnPct !==
        left.entrant.summary.metrics.totalReturnPct
      ) {
        return (
          right.entrant.summary.metrics.totalReturnPct -
          left.entrant.summary.metrics.totalReturnPct
        );
      }
      if (
        right.entrant.summary.metrics.sharpe !==
        left.entrant.summary.metrics.sharpe
      ) {
        return (
          right.entrant.summary.metrics.sharpe -
          left.entrant.summary.metrics.sharpe
        );
      }
      return left.entrant.candidate.candidateId.localeCompare(
        right.entrant.candidate.candidateId,
      );
    })
    .map((item, index) => ({
      rank: index + 1,
      candidateId: item.entrant.candidate.candidateId,
      family: item.entrant.candidate.family,
      strategy: item.entrant.summary.strategy,
      seedName: item.entrant.candidate.seedName,
      score: item.score,
      metrics: item.entrant.summary.metrics,
      lastDecision: item.entrant.summary.lastDecision,
      verdict: item.verdict.verdict,
      reasons: item.verdict.reasons,
    }));

  return {
    generatedAt: resolved.generatedAt,
    entryCount: ranked.length,
    winnerCandidateId: ranked[0]?.candidateId ?? null,
    entries: ranked,
  };
}
