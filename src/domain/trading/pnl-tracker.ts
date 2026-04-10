// ── Interfaces ──────────────────────────────────────────────────────────────

export interface PnLFill {
  symbol: string
  side: 'buy' | 'sell'
  size: number
  price: number
  timestamp: number
  orderId?: string
  intentId?: string
}

export interface PositionPnL {
  symbol: string
  side: 'long' | 'short'
  size: number
  avgCostBasis: number
  realizedPnL: number
  unrealizedPnL: number
}

export interface FIFOPositionPnL {
  symbol: string
  side: 'long' | 'short'
  lots: Array<{ size: number; price: number; timestamp: number }>
  realizedPnL: number
}

export interface ReconciliationResult {
  symbol: string
  avgCostRealizedPnL: number
  fifoRealizedPnL: number
  divergence: number
  divergencePct: number
  alert: boolean
}

// ── Internal state types ────────────────────────────────────────────────────

interface AvgCostState {
  symbol: string
  side: 'long' | 'short' | 'flat'
  size: number
  avgCost: number
  realizedPnL: number
  markPrice: number | undefined
}

interface FIFOState {
  symbol: string
  side: 'long' | 'short' | 'flat'
  lots: Array<{ size: number; price: number; timestamp: number }>
  realizedPnL: number
}

// ── PnLTracker ──────────────────────────────────────────────────────────────

export class PnLTracker {
  private reconciliationThresholdPct: number
  private avgCost: Map<string, AvgCostState> = new Map()
  private fifo: Map<string, FIFOState> = new Map()

  constructor(config?: { reconciliationThresholdPct: number }) {
    this.reconciliationThresholdPct = config?.reconciliationThresholdPct ?? 5
  }

  recordFill(fill: PnLFill): void {
    this.applyFillAvgCost(fill)
    this.applyFillFIFO(fill)
  }

  private getOrCreateAvgCost(symbol: string): AvgCostState {
    let s = this.avgCost.get(symbol)
    if (!s) {
      s = { symbol, side: 'flat', size: 0, avgCost: 0, realizedPnL: 0, markPrice: undefined }
      this.avgCost.set(symbol, s)
    }
    return s
  }

  private applyFillAvgCost(fill: PnLFill): void {
    const s = this.getOrCreateAvgCost(fill.symbol)
    const fillDirection: 'long' | 'short' = fill.side === 'buy' ? 'long' : 'short'

    if (s.side === 'flat' || s.size === 0) {
      s.side = fillDirection
      s.size = fill.size
      s.avgCost = fill.price
      return
    }

    if (s.side === fillDirection) {
      const newSize = s.size + fill.size
      s.avgCost = (s.size * s.avgCost + fill.size * fill.price) / newSize
      s.size = newSize
    } else {
      const closeQty = Math.min(fill.size, s.size)
      if (s.side === 'long') {
        s.realizedPnL += closeQty * (fill.price - s.avgCost)
      } else {
        s.realizedPnL += closeQty * (s.avgCost - fill.price)
      }

      const remaining = s.size - closeQty
      const overflow = fill.size - closeQty

      if (remaining > 0) {
        s.size = remaining
      } else if (overflow > 0) {
        s.side = fillDirection
        s.size = overflow
        s.avgCost = fill.price
      } else {
        s.side = 'flat'
        s.size = 0
        s.avgCost = 0
      }
    }
  }

  private getOrCreateFIFO(symbol: string): FIFOState {
    let s = this.fifo.get(symbol)
    if (!s) {
      s = { symbol, side: 'flat', lots: [], realizedPnL: 0 }
      this.fifo.set(symbol, s)
    }
    return s
  }

  private applyFillFIFO(fill: PnLFill): void {
    const s = this.getOrCreateFIFO(fill.symbol)
    const fillDirection: 'long' | 'short' = fill.side === 'buy' ? 'long' : 'short'

    if (s.side === 'flat' || s.lots.length === 0) {
      s.side = fillDirection
      s.lots.push({ size: fill.size, price: fill.price, timestamp: fill.timestamp })
      return
    }

    if (s.side === fillDirection) {
      s.lots.push({ size: fill.size, price: fill.price, timestamp: fill.timestamp })
    } else {
      let remaining = fill.size

      while (remaining > 0 && s.lots.length > 0) {
        const front = s.lots[0]
        const consumed = Math.min(remaining, front.size)

        if (s.side === 'long') {
          s.realizedPnL += consumed * (fill.price - front.price)
        } else {
          s.realizedPnL += consumed * (front.price - fill.price)
        }

        front.size -= consumed
        remaining -= consumed

        if (front.size <= 0) {
          s.lots.shift()
        }
      }

      if (remaining > 0) {
        s.side = fillDirection
        s.lots.push({ size: remaining, price: fill.price, timestamp: fill.timestamp })
      } else if (s.lots.length === 0) {
        s.side = 'flat'
      }
    }
  }

  getAvgCostPosition(symbol: string): PositionPnL | undefined {
    const s = this.avgCost.get(symbol)
    if (!s || s.side === 'flat' || s.size === 0) return undefined

    let unrealizedPnL = 0
    if (s.markPrice !== undefined) {
      unrealizedPnL =
        s.side === 'long'
          ? s.size * (s.markPrice - s.avgCost)
          : s.size * (s.avgCost - s.markPrice)
    }

    return {
      symbol: s.symbol,
      side: s.side,
      size: s.size,
      avgCostBasis: s.avgCost,
      realizedPnL: s.realizedPnL,
      unrealizedPnL,
    }
  }

  getFIFOPosition(symbol: string): FIFOPositionPnL | undefined {
    const s = this.fifo.get(symbol)
    if (!s || s.side === 'flat' || s.lots.length === 0) return undefined

    return {
      symbol: s.symbol,
      side: s.side,
      lots: s.lots.map(l => ({ ...l })),
      realizedPnL: s.realizedPnL,
    }
  }

  updateMarkPrice(symbol: string, markPrice: number): void {
    const s = this.getOrCreateAvgCost(symbol)
    s.markPrice = markPrice
  }

  reconcile(symbol: string): ReconciliationResult {
    const avg = this.avgCost.get(symbol)
    const fif = this.fifo.get(symbol)

    const avgReal = avg?.realizedPnL ?? 0
    const fifoReal = fif?.realizedPnL ?? 0
    const divergence = Math.abs(avgReal - fifoReal)
    const base = Math.max(Math.abs(avgReal), Math.abs(fifoReal), 1e-12)
    const divergencePct = (divergence / base) * 100

    return {
      symbol,
      avgCostRealizedPnL: avgReal,
      fifoRealizedPnL: fifoReal,
      divergence,
      divergencePct,
      alert: divergencePct > this.reconciliationThresholdPct,
    }
  }

  reconcileAll(): ReconciliationResult[] {
    const symbols = new Set<string>([
      ...this.avgCost.keys(),
      ...this.fifo.keys(),
    ])
    return [...symbols].map(s => this.reconcile(s))
  }

  getAllPositions(): PositionPnL[] {
    const results: PositionPnL[] = []
    for (const symbol of this.avgCost.keys()) {
      const pos = this.getAvgCostPosition(symbol)
      if (pos) results.push(pos)
    }
    return results
  }

  _resetForTest(): void {
    this.avgCost.clear()
    this.fifo.clear()
  }
}

