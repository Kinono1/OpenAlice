/**
 * Exchange Risk Diversification Check.
 *
 * Enforces practitioner-standard exchange risk limits:
 *   1. No exchange holds > 30% of total capital
 *   2. Total unrealized PnL on one exchange < 15% of AUM
 *   3. Withdrawal frequency: auto-settle to cold wallet daily
 *
 * Based on practices from Jump Crypto, Wintermute, GSR.
 */

export interface ExchangeBalance {
  exchange: string
  usdValue: number
  unrealizedPnl: number
  lastWithdrawalMs: number
  withdrawalEnabled: boolean
}

export interface ExchangeRiskConfig {
  /** Maximum fraction of capital on one exchange (default 0.30) */
  maxSingleExchangeFraction?: number
  /** Maximum unrealized PnL fraction of AUM on one exchange (default 0.15) */
  maxUnrealizedPnlFraction?: number
  /** Auto-settle interval in hours (default 24) */
  autoSettleIntervalHours?: number
  /** Minimum USD value to trigger auto-settlement */
  minAutoSettleUsd?: number
  /** Known insolvent or high-risk exchange names */
  blockedExchanges?: Set<string>
  /** Deterministic clock override for tests/replay. Defaults to Date.now(). */
  nowMs?: number
}

export interface ExchangeRiskResult {
  passed: boolean
  violations: ExchangeRiskViolation[]
  recommendations: string[]
}

export interface ExchangeRiskViolation {
  exchange: string
  rule: string
  current: number
  limit: number
  severity: 'critical' | 'warning'
}

const DEFAULT_CONFIG: Required<Omit<ExchangeRiskConfig, 'blockedExchanges' | 'nowMs'>> & {
  blockedExchanges: Set<string>
} = {
  maxSingleExchangeFraction: 0.30,
  maxUnrealizedPnlFraction: 0.15,
  autoSettleIntervalHours: 24,
  minAutoSettleUsd: 100_000,
  blockedExchanges: new Set(),
}

export function checkExchangeRisk(
  balances: ExchangeBalance[],
  totalAum: number,
  config: ExchangeRiskConfig = {},
): ExchangeRiskResult {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    blockedExchanges: normalizeExchangeSet(config.blockedExchanges ?? DEFAULT_CONFIG.blockedExchanges),
    nowMs: config.nowMs ?? Date.now(),
  }
  const violations: ExchangeRiskViolation[] = []
  const recommendations: string[] = []

  if (!Number.isFinite(totalAum) || totalAum <= 0) {
    return { passed: false, violations: [], recommendations: ['AUM is zero or negative'] }
  }

  for (const b of balances) {
    const exchange = b.exchange.trim() || 'unknown'
    if (!Number.isFinite(b.usdValue) || b.usdValue < 0) {
      violations.push({
        exchange,
        rule: 'invalid_exchange_balance',
        current: Number.isFinite(b.usdValue) ? b.usdValue : 0,
        limit: 0,
        severity: 'critical',
      })
      continue
    }
    if (!Number.isFinite(b.unrealizedPnl)) {
      violations.push({
        exchange,
        rule: 'invalid_unrealized_pnl',
        current: 0,
        limit: cfg.maxUnrealizedPnlFraction,
        severity: 'critical',
      })
      continue
    }

    if (cfg.blockedExchanges.has(exchange.toLowerCase())) {
      violations.push({
        exchange,
        rule: 'blocked_exchange',
        current: b.usdValue,
        limit: 0,
        severity: 'critical',
      })
    }

    const fraction = b.usdValue / totalAum
    if (fraction > cfg.maxSingleExchangeFraction) {
      violations.push({
        exchange,
        rule: 'max_single_exchange_fraction',
        current: fraction,
        limit: cfg.maxSingleExchangeFraction,
        severity: 'warning',
      })
      recommendations.push(
        `Reduce ${exchange} exposure from ${(fraction * 100).toFixed(1)}% to below ${(cfg.maxSingleExchangeFraction * 100).toFixed(0)}%. Withdraw ${(b.usdValue - totalAum * cfg.maxSingleExchangeFraction).toFixed(0)} USD.`,
      )
    }

    const pnlFraction = Math.abs(b.unrealizedPnl) / totalAum
    if (pnlFraction > cfg.maxUnrealizedPnlFraction) {
      violations.push({
        exchange,
        rule: 'max_unrealized_pnl_fraction',
        current: pnlFraction,
        limit: cfg.maxUnrealizedPnlFraction,
        severity: 'warning',
      })
      recommendations.push(
        `${exchange} unrealized PnL ${(pnlFraction * 100).toFixed(1)}% of AUM exceeds limit. Consider reducing position.`,
      )
    }

    const hoursSinceWithdrawal = (cfg.nowMs - b.lastWithdrawalMs) / 3_600_000
    if (
      b.withdrawalEnabled &&
      hoursSinceWithdrawal > cfg.autoSettleIntervalHours &&
      b.usdValue > cfg.minAutoSettleUsd
    ) {
      recommendations.push(
        `${exchange}: ${hoursSinceWithdrawal.toFixed(0)}h since last withdrawal. Auto-settle recommended (balance: ${b.usdValue.toFixed(0)} USD).`,
      )
    }
  }

  const totalExchangeFraction = balances.reduce((s, b) => s + b.usdValue, 0) / totalAum
  if (totalExchangeFraction > 0.75) {
    recommendations.push(
      `${(totalExchangeFraction * 100).toFixed(0)}% of AUM on exchanges. Consider moving more to cold storage.`,
    )
  }

  return {
    passed: violations.length === 0,
    violations,
    recommendations,
  }
}

function normalizeExchangeSet(exchanges: Set<string>): Set<string> {
  return new Set([...exchanges].map(exchange => exchange.trim().toLowerCase()).filter(Boolean))
}
