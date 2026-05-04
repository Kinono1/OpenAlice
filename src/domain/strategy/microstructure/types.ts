/** A single level in the limit order book. */
export interface LOBLevel {
  price: number
  size: number
}

/** Snapshot of the top N levels of the order book. */
export interface LOBSnapshot {
  bids: LOBLevel[]  // sorted descending by price
  asks: LOBLevel[]  // sorted ascending by price
  timestamp: number
}

/** A single trade tick. */
export interface TradeTick {
  price: number
  size: number
  /** true = buyer-initiated (taker buy), false = seller-initiated (taker sell) */
  isBuy: boolean
  timestamp: number
}

export interface OFIResult {
  /** Multi-level OFI: net order flow imbalance across top N levels */
  ofi: number
  /** Normalized OFI: ofi / total_depth, in [-1, 1] */
  normalizedOfi: number
  /** Per-level OFI contributions */
  levelOfi: number[]
  timestamp: number
}

export interface VPINResult {
  /** Volume-Synchronized Probability of Informed Trading, in [0, 1] */
  vpin: number
  /** Number of completed volume buckets used */
  bucketsUsed: number
  /** Rolling average of |buyVol - sellVol| / bucketSize */
  timestamp: number
}

export interface ToxicFlowAlert {
  /** true = pre-crisis conditions detected */
  isAlert: boolean
  severity: 'none' | 'warning' | 'critical'
  /** Normalized OFI at alert time */
  ofi: number
  /** VPIN at alert time */
  vpin: number
  reason: string
  timestamp: number
}
