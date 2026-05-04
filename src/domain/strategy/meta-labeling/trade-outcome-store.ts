import type { HmmStateName } from '../regime/hmm/types.js'

export interface TradeOutcomeRecord {
  tradeId: string
  entryTime: number
  exitTime: number
  entryFeatures: Record<string, number>
  admissionScore: number
  tripleBarrierLabel: 0 | 1
  realizedReturnPct: number
  exitReason: 'take-profit' | 'stop-loss' | 'time-expiry'
}

export interface TradeOutcomeStoreConfig {
  maxRecords: number
  exportBatchSize: number
}

const DEFAULT_STORE_CONFIG: TradeOutcomeStoreConfig = {
  maxRecords: 5000,
  exportBatchSize: 100,
}

interface PendingEntry {
  tradeId: string
  entryTime: number
  entryFeatures: Record<string, number>
  admissionScore: number
}

export class TradeOutcomeStore {
  private outcomes: TradeOutcomeRecord[] = []
  private pendingEntries: Map<string, PendingEntry> = new Map()
  private config: TradeOutcomeStoreConfig

  constructor(config: Partial<TradeOutcomeStoreConfig> = {}) {
    this.config = { ...DEFAULT_STORE_CONFIG, ...config }
  }

  recordEntry(
    tradeId: string,
    features: Record<string, number>,
    admissionScore: number,
  ): void {
    this.pendingEntries.set(tradeId, {
      tradeId,
      entryTime: Date.now(),
      entryFeatures: { ...features },
      admissionScore,
    })
  }

  recordExit(
    tradeId: string,
    returnPct: number,
    exitReason: 'take-profit' | 'stop-loss' | 'time-expiry',
  ): void {
    const pending = this.pendingEntries.get(tradeId)
    if (!pending) {
      return
    }
    this.pendingEntries.delete(tradeId)

    const label: 0 | 1 = exitReason === 'take-profit' ? 1 : 0

    const record: TradeOutcomeRecord = {
      tradeId,
      entryTime: pending.entryTime,
      exitTime: Date.now(),
      entryFeatures: pending.entryFeatures,
      admissionScore: pending.admissionScore,
      tripleBarrierLabel: label,
      realizedReturnPct: returnPct,
      exitReason,
    }

    this.outcomes.push(record)
    if (this.outcomes.length > this.config.maxRecords) {
      this.outcomes = this.outcomes.slice(-Math.floor(this.config.maxRecords * 0.8))
    }
  }

  getOutcomes(lookback: number): TradeOutcomeRecord[] {
    return this.outcomes.slice(-lookback)
  }

  getRecentWinRate(lookback = 20): number {
    const recent = this.getOutcomes(lookback)
    if (recent.length === 0) {
      return 0.5
    }
    const wins = recent.filter((r) => r.tripleBarrierLabel === 1).length
    return wins / recent.length
  }

  exportForRetraining(): TradeOutcomeRecord[] {
    return this.outcomes.slice(-this.config.exportBatchSize)
  }

  get size(): number {
    return this.outcomes.length
  }

  get pendingCount(): number {
    return this.pendingEntries.size
  }
}
