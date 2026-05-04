/**
 * Stablecoin Flow Signal.
 *
 * Monitors net exchange inflow/outflow of USDT/USDC as a leading indicator
 * of buying/selling pressure. Backed by IMF Working Paper (Reuter, 2025)
 * and practitioner consensus.
 *
 * Large inflows (> $10M in 4h) typically lead price by 2-6 hours.
 */

import { buildFactorSignal, clamp } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface StablecoinTransfer {
  symbol: 'USDT' | 'USDC'
  amount: number
  from: string
  to: string
  timestamp: number
  txHash: string
}

export interface StablecoinFlowConfig {
  /** Minimum transfer amount to consider (USD) */
  minTransferUsd?: number
  /** Lookback window in hours */
  lookbackHours?: number
  /** Known exchange wallet addresses (lowercase) */
  exchangeAddresses?: Set<string>
  /** Threshold for net inflow ratio to signal bullish */
  inflowRatioBullish?: number
  /** Threshold for net outflow ratio to signal bearish */
  outflowRatioBearish?: number
}

const DEFAULT_CONFIG: Required<Omit<StablecoinFlowConfig, 'exchangeAddresses'>> & {
  exchangeAddresses: Set<string>
} = {
  minTransferUsd: 1_000_000,
  lookbackHours: 4,
  exchangeAddresses: new Set(),
  inflowRatioBullish: 0.02,
  outflowRatioBearish: 0.02,
}

const KNOWN_EXCHANGE_TAGS = [
  'binance', 'okx', 'bybit', 'kucoin', 'gate.io',
  'coinbase', 'kraken', 'bitfinex', 'huobi', 'bitget',
  'wintermute', 'jump', 'gsr', 'amber',
]

function isKnownExchange(label: string): boolean {
  const lower = label.toLowerCase()
  return KNOWN_EXCHANGE_TAGS.some(tag => lower.includes(tag))
}

export function evaluateStablecoinFlow(
  transfers: StablecoinTransfer[],
  totalExchangeBalance: number,
  config: StablecoinFlowConfig = {},
): FactorSignal {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const now = Date.now()
  const windowMs = cfg.lookbackHours * 3600_000
  const recentTransfers = transfers.filter(
    t => t.timestamp >= now - windowMs && t.amount >= cfg.minTransferUsd,
  )

  if (recentTransfers.length === 0) {
    return buildFactorSignal({
      name: 'stablecoin-flow',
      rawValue: 0,
      rawConfidence: 0.1,
      metadata: {
        netFlowUsd: 0,
        netFlowRatio: 0,
        transferCount: 0,
        totalExchangeBalance,
        lookbackHours: cfg.lookbackHours,
      },
    })
  }

  let netInflow = 0
  let inflowAmount = 0
  let outflowAmount = 0

  for (const tx of recentTransfers) {
    const toExchange =
      cfg.exchangeAddresses.has(tx.to.toLowerCase()) || isKnownExchange(tx.to)
    const fromExchange =
      cfg.exchangeAddresses.has(tx.from.toLowerCase()) || isKnownExchange(tx.from)

    if (toExchange && !fromExchange) {
      netInflow += tx.amount
      inflowAmount += tx.amount
    } else if (!toExchange && fromExchange) {
      netInflow -= tx.amount
      outflowAmount += tx.amount
    }
  }

  const balance = Math.max(totalExchangeBalance, 1)
  const netFlowRatio = netInflow / balance
  const totalFlow = inflowAmount + outflowAmount
  const flowIntensity = clamp(totalFlow / balance, 0, 1)

  let signal = 0
  let confidence = 0.15

  if (netFlowRatio > cfg.inflowRatioBullish) {
    signal = clamp(netFlowRatio * 25, 0, 1)
    confidence = clamp(netFlowRatio * 15 + 0.3, 0.3, 1)
  } else if (netFlowRatio < -cfg.outflowRatioBearish) {
    signal = clamp(netFlowRatio * 25, -1, 0)
    confidence = clamp(Math.abs(netFlowRatio) * 15 + 0.3, 0.3, 1)
  }

  return buildFactorSignal({
    name: 'stablecoin-flow',
    rawValue: signal,
    rawConfidence: confidence,
    metadata: {
      netFlowUsd: netInflow,
      netFlowRatio,
      inflowAmount,
      outflowAmount,
      flowIntensity,
      transferCount: recentTransfers.length,
      totalExchangeBalance,
      lookbackHours: cfg.lookbackHours,
    },
  })
}
