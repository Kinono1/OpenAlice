import type { TradeTick, VPINResult } from './types.js'

/**
 * Volume-Synchronized Probability of Informed Trading (VPIN).
 * Easley, Lopez de Prado & O'Hara (2012).
 *
 * Algorithm:
 *   1. Accumulate trades into volume buckets of size `bucketSize`
 *   2. For each bucket: classify volume as buy (V_b) or sell (V_s) using tick rule
 *   3. VPIN = rolling mean of |V_b - V_s| / bucketSize over last `nBuckets` buckets
 */
export class VPINCalculator {
  private buckets: Array<{ buyVol: number; sellVol: number }> = []
  private currentBuyVol = 0
  private currentSellVol = 0
  private currentBucketVol = 0
  private lastPrice: number | null = null

  constructor(
    private readonly bucketSize: number = 50,
    private readonly nBuckets: number = 50,
  ) {}

  /** Feed a trade tick and return updated VPIN if a new bucket completes. */
  update(tick: TradeTick): VPINResult | null {
    // Tick rule: if no prior price, use isBuy flag directly
    const isBuy = this.lastPrice !== null
      ? tick.price > this.lastPrice
        ? true
        : tick.price < this.lastPrice
          ? false
          : tick.isBuy
      : tick.isBuy

    this.lastPrice = tick.price

    let remaining = tick.size
    while (remaining > 0) {
      const space = this.bucketSize - this.currentBucketVol
      const fill = Math.min(remaining, space)
      if (isBuy) this.currentBuyVol += fill
      else this.currentSellVol += fill
      this.currentBucketVol += fill
      remaining -= fill

      if (this.currentBucketVol >= this.bucketSize) {
        this.buckets.push({ buyVol: this.currentBuyVol, sellVol: this.currentSellVol })
        if (this.buckets.length > this.nBuckets) this.buckets.shift()
        this.currentBuyVol = 0
        this.currentSellVol = 0
        this.currentBucketVol = 0
      }
    }

    if (this.buckets.length < 2) return null
    return this.compute(tick.timestamp)
  }

  compute(timestamp: number): VPINResult {
    const n = this.buckets.length
    const vpin = this.buckets.reduce((s, b) => s + Math.abs(b.buyVol - b.sellVol), 0) / (n * this.bucketSize)
    return { vpin: Math.min(vpin, 1), bucketsUsed: n, timestamp }
  }

  reset(): void {
    this.buckets = []
    this.currentBuyVol = 0
    this.currentSellVol = 0
    this.currentBucketVol = 0
    this.lastPrice = null
  }
}
