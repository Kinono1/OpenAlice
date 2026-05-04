/**
 * Liquidation Cascade Detector.
 *
 * Tracks per-symbol liquidation volume in a rolling 1-second window.
 * Compares to historical 99th percentile to detect cascade conditions.
 * On cascade: recommends deep limit-maker placement zones for "catching falling knives".
 */

export interface LiquidationEvent {
  symbol: string
  side: 'long' | 'short'   // which side was liquidated
  contracts: number
  price: number
  timestamp: number
}

export interface LiquidationCascadeSignal {
  symbol: string
  /** true = cascade detected this second */
  isCascade: boolean
  /** Liquidation volume in the last 1s window */
  windowVolumeContracts: number
  /** Historical 99th percentile threshold */
  p99Threshold: number
  /** Which side is being liquidated (dominant) */
  dominantSide: 'long' | 'short' | 'mixed'
  /** Suggested limit-maker entry zone: [lower, upper] price range */
  entryZone: [number, number] | null
  /** Confidence in [0, 1] */
  confidence: number
  timestamp: number
}

export interface CascadeDetectorConfig {
  /** Rolling window for cascade detection (ms, default 1000) */
  windowMs?: number
  /** Number of historical windows to keep for percentile estimation (default 3600 = 1h at 1s) */
  historySize?: number
  /** Percentile threshold for cascade detection (default 0.99) */
  percentile?: number
  /** How far below current price to place limit orders (default 0.05 = 5%) */
  entryDepthFraction?: number
  /** Width of the entry zone (default 0.02 = 2%) */
  entryZoneWidth?: number
}

const DEFAULT: Required<CascadeDetectorConfig> = {
  windowMs: 1_000,
  historySize: 3_600,
  percentile: 0.99,
  entryDepthFraction: 0.05,
  entryZoneWidth: 0.02,
}

export class LiquidationCascadeDetector {
  private readonly cfg: Required<CascadeDetectorConfig>
  /** Recent events within the current window */
  private windowEvents: LiquidationEvent[] = []
  /** Historical per-window volume totals for percentile estimation */
  private history: number[] = []
  private lastWindowFlushMs = Date.now()

  constructor(config: CascadeDetectorConfig = {}) {
    this.cfg = { ...DEFAULT, ...config }
  }

  /** Ingest a liquidation event from the websocket feed. */
  ingest(event: LiquidationEvent): LiquidationCascadeSignal | null {
    const now = Date.now()

    // Flush expired window
    if (now - this.lastWindowFlushMs >= this.cfg.windowMs) {
      const windowVol = this.windowEvents.reduce((s, e) => s + e.contracts, 0)
      this.history.push(windowVol)
      if (this.history.length > this.cfg.historySize) this.history.shift()
      this.windowEvents = []
      this.lastWindowFlushMs = now
    }

    this.windowEvents.push(event)

    // Need enough history to compute percentile
    if (this.history.length < 30) return null

    const windowVol = this.windowEvents.reduce((s, e) => s + e.contracts, 0)
    const p99 = this.computePercentile(this.history, this.cfg.percentile)

    if (windowVol < p99) {
      return {
        symbol: event.symbol,
        isCascade: false,
        windowVolumeContracts: windowVol,
        p99Threshold: p99,
        dominantSide: 'mixed',
        entryZone: null,
        confidence: 0,
        timestamp: now,
      }
    }

    // Cascade detected
    const longVol = this.windowEvents.filter(e => e.side === 'long').reduce((s, e) => s + e.contracts, 0)
    const shortVol = this.windowEvents.filter(e => e.side === 'short').reduce((s, e) => s + e.contracts, 0)
    const dominantSide: 'long' | 'short' | 'mixed' =
      longVol > shortVol * 1.5 ? 'long' :
      shortVol > longVol * 1.5 ? 'short' : 'mixed'

    // Entry zone: place limit makers below current price (for long liquidation cascade = price drop)
    const currentPrice = event.price
    const entryZone = this.buildEntryZone(currentPrice, dominantSide)

    const excess = (windowVol - p99) / p99
    const confidence = Math.min(excess / 2, 1)  // saturates at 3x p99

    return {
      symbol: event.symbol,
      isCascade: true,
      windowVolumeContracts: windowVol,
      p99Threshold: p99,
      dominantSide,
      entryZone,
      confidence,
      timestamp: now,
    }
  }

  /** Build limit-maker entry zone based on cascade direction. */
  private buildEntryZone(price: number, side: 'long' | 'short' | 'mixed'): [number, number] | null {
    if (side === 'mixed') return null
    // Long liquidation = price falling -> buy below current price
    // Short liquidation = price rising -> sell above current price
    if (side === 'long') {
      const lower = price * (1 - this.cfg.entryDepthFraction - this.cfg.entryZoneWidth)
      const upper = price * (1 - this.cfg.entryDepthFraction)
      return [lower, upper]
    } else {
      const lower = price * (1 + this.cfg.entryDepthFraction)
      const upper = price * (1 + this.cfg.entryDepthFraction + this.cfg.entryZoneWidth)
      return [lower, upper]
    }
  }

  private computePercentile(sorted: number[], p: number): number {
    const arr = [...sorted].sort((a, b) => a - b)
    const idx = Math.floor(arr.length * p)
    return arr[Math.min(idx, arr.length - 1)] ?? 0
  }

  reset(): void {
    this.windowEvents = []
    this.history = []
    this.lastWindowFlushMs = Date.now()
  }
}
