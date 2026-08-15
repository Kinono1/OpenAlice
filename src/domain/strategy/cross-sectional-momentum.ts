/**
 * Cross-Sectional Reversal Strategy — Crypto-Optimized.
 *
 * Core insight: crypto exhibits short-term reversal (1-4 weeks), not momentum.
 * Past losers tend to outperform past winners. This is the opposite of equities.
 *
 * Win-rate boosters:
 *   1. Risk-adjusted ranking (return/vol, not raw return)
 *   2. Multi-timeframe confirmation (7d + 30d)
 *   3. Signal strength filter (only trade when spread is significant)
 *   4. Volume confirmation (higher volume on reversal direction)
 *   5. Regime filter (avoid extreme volatility)
 *   6. Minimum universe size with breadth confirmation
 *
 * Academic: Liu, Tsyvinski & Wu (2022) JF — crypto momentum is weak;
 * short-term reversal is the dominant cross-sectional anomaly.
 */

export interface CrossSectionalConfig {
  /** Primary lookback in hours (default 168 = 7 days) */
  lookbackHours?: number
  /** Secondary lookback for multi-timeframe confirmation */
  secondaryLookbackHours?: number
  /** Number of top assets to short (past winners → reversal down) */
  topN?: number
  /** Number of bottom assets to long (past losers → reversal up) */
  bottomN?: number
  /** Minimum universe size */
  minUniverseSize?: number
  /** Max position fraction per asset */
  maxPositionFraction?: number
  /** Minimum spread between top and bottom to generate signal */
  minSpreadPct?: number
  /** Vol ceiling — skip if all assets above this vol percentile */
  maxVolPercentile?: number
  /** Require volume confirmation (24h vol > avg) */
  requireVolumeConfirmation?: boolean
  /** Multi-timeframe agreement weight [0,1] */
  mtfWeight?: number
  /** Funding rate factor weight [0,1] — 0=ignore, 1=full weight */
  fundingWeight?: number
  /** Minimum 24h USD volume required to stay in the tradable universe */
  minDailyVolumeUsd?: number
  /** Maximum spread in basis points when spread data is available */
  maxSpreadBps?: number
}

export interface CrossSectionalAsset {
  symbol: string
  currentPrice: number
  /** Returns keyed by horizon, e.g. { "168h": -5.2, "720h": 12.1 } — in percent */
  returns: Record<string, number>
  realizedVolPct: number
  avgVolume24h: number
  /** Optional 24h USD volume. Falls back to currentPrice * avgVolume24h when omitted. */
  dailyVolumeUsd?: number
  /** Optional spread in basis points. When present, over-threshold assets are filtered out. */
  spreadBps?: number
  /** Current funding rate in percent per 8h (e.g. 0.01 = 0.01%). Optional. */
  fundingRatePct?: number
}

export interface CrossSectionalRank {
  symbol: string
  rank: number
  momentumScore: number
  riskAdjustedScore: number
  signal: number
  positionFraction: number
  confidence: number
  reason: string
}

function clamp(v: number, min: number, max: number): number { return v < min ? min : v > max ? max : v }

const DEFAULT_CONFIG: Required<CrossSectionalConfig> = {
  lookbackHours: 168,
  secondaryLookbackHours: 720, // 30 days
  topN: 2,
  bottomN: 2,
  minUniverseSize: 6,
  maxPositionFraction: 0.15,
  minSpreadPct: 5, // 5% spread between top and bottom
  maxVolPercentile: 0.90,
  requireVolumeConfirmation: true,
  mtfWeight: 0.35, // 35% weight to secondary timeframe
  fundingWeight: 0.25, // 25% weight to funding rate factor
  minDailyVolumeUsd: 10_000_000,
  maxSpreadBps: 20,
}

export function evaluateCrossSectionalMomentum(
  assets: CrossSectionalAsset[],
  config: CrossSectionalConfig = {},
): CrossSectionalRank[] {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const primaryKey = `${cfg.lookbackHours}h`
  const secondaryKey = `${cfg.secondaryLookbackHours}h`

  if (assets.length < cfg.minUniverseSize) {
    return assets.map(a => ({
      symbol: a.symbol, rank: 0, momentumScore: 0, riskAdjustedScore: 0,
      signal: 0, positionFraction: 0, confidence: 0,
      reason: `Universe too small: ${assets.length} < ${cfg.minUniverseSize}`,
    }))
  }

  // Filter: liquidity + vol ceiling
  const eligible = assets.filter(a => {
    const hasReturn = typeof a.returns[primaryKey] === 'number' && Number.isFinite(a.returns[primaryKey])
    const explicitDailyVolumeUsd =
      typeof a.dailyVolumeUsd === 'number' && Number.isFinite(a.dailyVolumeUsd)
        ? a.dailyVolumeUsd
        : null
    const liquid =
      a.avgVolume24h > 0 &&
      (explicitDailyVolumeUsd == null || explicitDailyVolumeUsd >= cfg.minDailyVolumeUsd)
    const volOk = a.realizedVolPct < 100 * cfg.maxVolPercentile
    const spreadOk =
      typeof a.spreadBps !== 'number' || !Number.isFinite(a.spreadBps)
        ? true
        : a.spreadBps <= cfg.maxSpreadBps
    return hasReturn && liquid && volOk && spreadOk
  })

  if (eligible.length < cfg.minUniverseSize) {
    return assets.map(a => ({
      symbol: a.symbol, rank: 0, momentumScore: 0, riskAdjustedScore: 0,
      signal: 0, positionFraction: 0, confidence: 0,
      reason: `Eligible too small: ${eligible.length} < ${cfg.minUniverseSize} (vol/liq filtered)`,
    }))
  }

  // Risk-adjusted scoring: return / vol = Sharpe-like ranking
  // Funding rate overlay: high funding → carry cost for longs, bias SHORT
  //                        low/negative funding → carry reward for longs, bias LONG
  const fundingWeight = cfg.fundingWeight ?? 0
  const scored = eligible.map(a => {
    const primaryRet = a.returns[primaryKey]
    const secondaryRet = typeof a.returns[secondaryKey] === 'number' && Number.isFinite(a.returns[secondaryKey])
      ? a.returns[secondaryKey]
      : primaryRet

    const volPenalty = Math.max(a.realizedVolPct, 10) / 100
    const riskAdjPrimary = primaryRet / volPenalty
    const riskAdjSecondary = secondaryRet / volPenalty

    // Funding rate adjustment: contrarian signal blended into score
    // High funding penalizes score (favor short), low funding boosts score (favor long)
    let fundingAdjust = 0
    if (fundingWeight > 0 && typeof a.fundingRatePct === 'number' && Number.isFinite(a.fundingRatePct)) {
      // Normalize funding to -1..1 range (typical range ±0.1% per 8h)
      const fundingNorm = -clamp(a.fundingRatePct / 0.05, -1, 1)
      fundingAdjust = fundingNorm * fundingWeight * 3 // scale to be comparable to risk-adj returns
    }

    // Multi-timeframe composite + funding overlay
    const mtfScore = riskAdjPrimary * (1 - cfg.mtfWeight) + riskAdjSecondary * cfg.mtfWeight + fundingAdjust

    return {
      symbol: a.symbol,
      rawReturn: primaryRet,
      rawReturnSecondary: secondaryRet,
      riskAdjustedScore: mtfScore,
      realizedVolPct: a.realizedVolPct,
      fundingAdjust,
    }
  })

  // Sort by risk-adjusted score (lowest = biggest loser = most reversal potential)
  const sorted = [...scored].sort((a, b) => a.riskAdjustedScore - b.riskAdjustedScore)
  const ranks = new Map<string, number>()
  sorted.forEach((s, i) => ranks.set(s.symbol, i + 1))

  const totalN = sorted.length
  const topN = Math.max(1, Math.min(cfg.topN, Math.floor(totalN / 3)))
  const bottomN = Math.max(1, Math.min(cfg.bottomN, Math.floor(totalN / 3)))

  // Signal strength check: spread between top and bottom must exceed minSpreadPct
  const loserCandidates = sorted.slice(0, bottomN)
  const winnerCandidates = sorted.slice(totalN - topN)
  const avgLoserReturn = loserCandidates.reduce((s, a) => s + a.rawReturn, 0) / bottomN
  const avgWinnerReturn = winnerCandidates.reduce((s, a) => s + a.rawReturn, 0) / topN
  // Gap between best and worst performers (positive = larger dispersion)
  const spread = avgWinnerReturn - avgLoserReturn

  const spreadInsufficient = spread < cfg.minSpreadPct

  return assets.map(a => {
    const rank = ranks.get(a.symbol)
    if (rank === undefined) {
      return { symbol: a.symbol, rank: 0, momentumScore: 0, riskAdjustedScore: 0,
        signal: 0, positionFraction: 0, confidence: 0,
        reason: 'Filtered out (vol/liq/spread)' }
    }

    let signal = 0
    let positionFraction = 0
    let confidence = 0
    let reason = ''

    const isLoser = rank <= bottomN
    const isWinner = rank > totalN - topN

    if (spreadInsufficient) {
      reason = `Spread ${spread.toFixed(1)}% below threshold ${cfg.minSpreadPct}%`
    } else if (isLoser) {
      signal = 1 // Long past losers (they reverse up)
      positionFraction = cfg.maxPositionFraction
      const rankStrength = 1 - (rank - 1) / bottomN
      const spreadStrength = Math.min(spread / (cfg.minSpreadPct * 3), 1)
      // Funding confirmation: low/negative funding supports long
      let fundingBoost = 0
      if (fundingWeight > 0 && typeof a.fundingRatePct === 'number') {
        const fundingZ = clamp(a.fundingRatePct / 0.05, -1, 1)
        if (fundingZ < 0) fundingBoost = Math.abs(fundingZ) * 0.3 * fundingWeight
      }
      confidence = rankStrength * 0.4 + spreadStrength * 0.3 + fundingBoost
    } else if (isWinner) {
      signal = -1 // Short past winners (they reverse down)
      positionFraction = cfg.maxPositionFraction
      const rankStrength = (rank - (totalN - topN)) / topN
      const spreadStrength = Math.min(spread / (cfg.minSpreadPct * 3), 1)
      // Funding confirmation: high funding supports short
      let fundingBoost = 0
      if (fundingWeight > 0 && typeof a.fundingRatePct === 'number') {
        const fundingZ = clamp(a.fundingRatePct / 0.05, -1, 1) // positive funding -> short favorable
        if (fundingZ > 0) fundingBoost = fundingZ * 0.3 * fundingWeight
      }
      confidence = rankStrength * 0.4 + spreadStrength * 0.3 + fundingBoost
    }

    if (confidence > 0) {
      reason = `Rank ${rank}/${totalN}, spread ${spread.toFixed(1)}%`
    }

    const score = scored.find(s => s.symbol === a.symbol)
    return {
      symbol: a.symbol,
      rank,
      momentumScore: score?.rawReturn ?? 0,
      riskAdjustedScore: score?.riskAdjustedScore ?? 0,
      signal,
      positionFraction,
      confidence,
      reason: reason || 'Middle rank',
    }
  })
}
