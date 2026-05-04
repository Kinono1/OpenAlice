import type { HmmStateName } from '../regime/hmm/types.js'

export interface IcDecayMetrics {
  factorName: string
  symbol?: string
  horizon: number
  rollingIc: number
  rollingIcStd: number
  icIr: number
  sampleCount: number
  signStability: number
  trendSlope: number
  decayStatus: 'healthy' | 'warning' | 'decayed'
  lastUpdateMs: number
}

export interface FactorIcMonitorConfig {
  enabled: boolean
  mode: 'off' | 'shadow' | 'active'
  icHorizons: number[]
  lookbackWindows: number[]
  minSamples: number
  minSampleCount: number          // minimum to compute IC (default 50)
  warmupWindows: number           // cold-start protection (default 3)
  decayThresholds: {
    meanIcFloor: number
    icIrFloor: number
    signStabilityFloor: number
  }
  autoDisable: boolean
}

export const DEFAULT_IC_MONITOR_CONFIG: FactorIcMonitorConfig = {
  enabled: true,
  mode: 'shadow',
  icHorizons: [24, 48, 168],
  lookbackWindows: [24, 48, 168],
  minSamples: 20,
  minSampleCount: 50,
  warmupWindows: 3,
  decayThresholds: {
    meanIcFloor: 0.03,
    icIrFloor: 0.5,
    signStabilityFloor: 0.6,
  },
  autoDisable: false,
}

export interface IcMonitorSnapshot {
  signals: { factor: string; value: number; timestamp: number; symbol?: string }[]
  returns: { timestamp: number; value: number; symbol?: string }[]
  version: number
}

interface SignalRecord {
  factor: string
  value: number
  timestamp: number
  symbol: string
}

interface ReturnRecord {
  timestamp: number
  value: number
  symbol: string
}

const MAX_RECORDS = 10000
const TRIM_TO = 5000
const LEGACY_SYMBOL = '__legacy__'

export class FactorIcMonitor {
  private signals: SignalRecord[] = []
  private returns: ReturnRecord[] = []
  private config: FactorIcMonitorConfig
  private decayCache: Map<string, IcDecayMetrics> = new Map()
  private snapshotVersion = 0

  constructor(config: FactorIcMonitorConfig = DEFAULT_IC_MONITOR_CONFIG) {
    this.config = config
  }

  recordSignal(factor: string, value: number, timestamp: number, symbol = LEGACY_SYMBOL): void {
    if (!this.config.enabled) {
      return
    }
    const normalizedSymbol = normalizeSymbol(symbol)
    const existing = this.signals.findIndex(
      (record) =>
        record.factor === factor &&
        record.timestamp === timestamp &&
        record.symbol === normalizedSymbol,
    )
    if (existing >= 0) {
      this.signals[existing] = { factor, value, timestamp, symbol: normalizedSymbol }
      this.decayCache.clear()
      return
    }
    this.signals.push({ factor, value, timestamp, symbol: normalizedSymbol })
    if (this.signals.length > MAX_RECORDS) {
      this.signals = this.signals.slice(-TRIM_TO)
    }
    this.decayCache.clear()
  }

  recordReturn(timestamp: number, value: number, symbol = LEGACY_SYMBOL): void {
    if (!this.config.enabled) {
      return
    }
    const normalizedSymbol = normalizeSymbol(symbol)
    const existing = this.returns.findIndex(
      (record) => record.timestamp === timestamp && record.symbol === normalizedSymbol,
    )
    if (existing >= 0) {
      this.returns[existing] = { timestamp, value, symbol: normalizedSymbol }
      this.decayCache.clear()
      return
    }
    this.returns.push({ timestamp, value, symbol: normalizedSymbol })
    if (this.returns.length > MAX_RECORDS) {
      this.returns = this.returns.slice(-TRIM_TO)
    }
    this.decayCache.clear()
  }

  exportSnapshot(): IcMonitorSnapshot {
    this.snapshotVersion += 1
    return {
      signals: this.signals.slice(),
      returns: this.returns.slice(),
      version: this.snapshotVersion,
    }
  }

  importSnapshot(snapshot: IcMonitorSnapshot): void {
    this.signals = snapshot.signals.map(normalizeSignalRecord)
    this.returns = snapshot.returns.map(normalizeReturnRecord)
    this.snapshotVersion = snapshot.version
    this.decayCache.clear()
  }

  private spearmanCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length < this.config.minSamples) {
      return NaN
    }

    const rankX = this.computeRanks(x)
    const rankY = this.computeRanks(y)

    const n = x.length
    const meanRank = (n + 1) / 2
    let sumD2 = 0
    for (let i = 0; i < n; i++) {
      sumD2 += (rankX[i] - rankY[i]) ** 2
    }
    const rho = 1 - (6 * sumD2) / (n * (n ** 2 - 1))
    return rho
  }

  private computeRanks(values: number[]): number[] {
    const indexed = values.map((v, i) => ({ v, i }))
    indexed.sort((a, b) => a.v - b.v)
    const ranks: number[] = new Array(values.length).fill(0)
    let i = 0
    while (i < indexed.length) {
      let j = i
      while (j < indexed.length - 1 && indexed[j].v === indexed[j + 1].v) {
        j++
      }
      const avgRank = (i + j) / 2 + 1
      for (let k = i; k <= j; k++) {
        ranks[indexed[k].i] = avgRank
      }
      i = j + 1
    }
    return ranks
  }

  computeRollingIc(
    factor: string,
    horizon: number,
    icHorizonBars = 24,
    asOfMs?: number,
    symbol = LEGACY_SYMBOL,
  ): number {
    const now = asOfMs ?? Date.now()
    const windowMs = horizon * 60 * 60 * 1000
    const icHorizonMs = icHorizonBars * 60 * 60 * 1000
    const normalizedSymbol = normalizeSymbol(symbol)

    const windowSignals = this.signals.filter(
      (s) =>
        s.factor === factor &&
        s.symbol === normalizedSymbol &&
        s.timestamp <= now &&
        now - s.timestamp <= windowMs,
    )
    if (windowSignals.length < this.config.minSamples) {
      return NaN
    }

    const factorValues: number[] = []
    const returnValues: number[] = []

    for (const sig of windowSignals) {
      const futureReturn = this.returns.find(
        (r) => {
          const lag = r.timestamp - sig.timestamp
          return r.symbol === normalizedSymbol &&
            r.timestamp <= now &&
            lag >= icHorizonMs * 0.8 &&
            lag <= icHorizonMs * 1.2
        },
      )
      if (futureReturn) {
        factorValues.push(sig.value)
        returnValues.push(futureReturn.value)
      }
    }

    if (factorValues.length < this.config.minSamples) {
      return NaN
    }

    return this.spearmanCorrelation(factorValues, returnValues)
  }

  detectDecay(factor: string, asOfMs?: number, symbol = LEGACY_SYMBOL): IcDecayMetrics {
    const now = asOfMs ?? Date.now()
    const normalizedSymbol = normalizeSymbol(symbol)
    const cacheKey = `${normalizedSymbol}|${factor}`
    const cached = this.decayCache.get(cacheKey)
    if (cached && now >= cached.lastUpdateMs && now - cached.lastUpdateMs < 60 * 60 * 1000) {
      return cached
    }

    const icValues: number[] = []
    const icHorizons = this.config.icHorizons ?? this.config.lookbackWindows
    for (const icHorizon of icHorizons) {
      // Match lookback to horizon index if arrays align, otherwise use corresponding lookback
      const horizonIndex = this.config.icHorizons.indexOf(icHorizon)
      const lookback =
        horizonIndex >= 0 && horizonIndex < this.config.lookbackWindows.length
          ? this.config.lookbackWindows[horizonIndex]
          : icHorizon
      const ic = this.computeRollingIc(factor, lookback, icHorizon, now, normalizedSymbol)
      if (Number.isFinite(ic)) {
        icValues.push(ic)
      }
    }

    const sampleCount = this.signals.filter(
      (s) => s.factor === factor && s.symbol === normalizedSymbol,
    ).length

    let rollingIc = NaN
    let rollingIcStd = NaN
    let icIr = NaN
    let signStability = 0
    let trendSlope = 0

    if (icValues.length >= 2) {
      rollingIc = icValues.reduce((a, b) => a + b, 0) / icValues.length
      const variance =
        icValues.reduce((sum, ic) => sum + (ic - rollingIc) ** 2, 0) / icValues.length
      rollingIcStd = Math.sqrt(Math.max(variance, 0))
      if (rollingIcStd > 1e-12) {
        icIr = rollingIc / rollingIcStd
      } else {
        // Zero cross-horizon dispersion with non-zero IC is stable, not decayed.
        icIr = Math.abs(rollingIc) > 1e-12 ? Math.sign(rollingIc) * 1_000_000 : 0
      }

      const signs = icValues.map((ic) => Math.sign(ic))
      const posCount = signs.filter((s) => s > 0).length
      const negCount = signs.filter((s) => s < 0).length
      signStability = Math.max(posCount, negCount) / icValues.length

      const n = icValues.length
      const xMean = (n - 1) / 2
      const yMean = rollingIc
      let num = 0
      let den = 0
      for (let i = 0; i < n; i++) {
        num += (i - xMean) * (icValues[i] - yMean)
        den += (i - xMean) ** 2
      }
      trendSlope = den > 0 ? num / den : 0
    }

    const thresholds = this.config.decayThresholds
    let decayStatus: 'healthy' | 'warning' | 'decayed' = 'healthy'

    if (
      !Number.isFinite(rollingIc) ||
      !Number.isFinite(icIr) ||
      Math.abs(rollingIc) < thresholds.meanIcFloor ||
      Math.abs(icIr) < thresholds.icIrFloor
    ) {
      decayStatus = 'decayed'
    } else if (signStability < thresholds.signStabilityFloor) {
      decayStatus = 'warning'
    }

    const metrics: IcDecayMetrics = {
      factorName: factor,
      symbol: normalizedSymbol === LEGACY_SYMBOL ? undefined : normalizedSymbol,
      horizon: this.config.lookbackWindows[0] ?? 24,
      rollingIc: Number.isFinite(rollingIc) ? rollingIc : 0,
      rollingIcStd: Number.isFinite(rollingIcStd) ? rollingIcStd : 0,
      icIr: Number.isFinite(icIr) ? icIr : 0,
      sampleCount,
      signStability,
      trendSlope,
      decayStatus,
      lastUpdateMs: now,
    }

    this.decayCache.set(cacheKey, metrics)
    return metrics
  }

  getConditioning(asOfMs?: number, symbol = LEGACY_SYMBOL): {
    multipliers: Record<string, number>
    reasons: string[]
    decayedByFactor: Record<string, boolean>
  } {
    const multipliers: Record<string, number> = {}
    const reasons: string[] = []
    const decayedByFactor: Record<string, boolean> = {}

    const normalizedSymbol = normalizeSymbol(symbol)
    const factors = [
      ...new Set(
        this.signals
          .filter((s) => s.symbol === normalizedSymbol)
          .map((s) => s.factor),
      ),
    ]
    for (const factor of factors) {
      const metrics = this.detectDecay(factor, asOfMs, normalizedSymbol)
      const isDecayed = metrics.decayStatus === 'decayed'
      decayedByFactor[factor] = isDecayed

      if (isDecayed && this.config.autoDisable) {
        multipliers[factor] = 0
        reasons.push(`IC decay detected for ${factor}: |IC|=${Math.abs(metrics.rollingIc).toFixed(3)} < ${this.config.decayThresholds.meanIcFloor}`)
      } else if (metrics.decayStatus === 'warning') {
        multipliers[factor] = 0.5
        reasons.push(`IC warning for ${factor}: sign stability=${metrics.signStability.toFixed(2)} < ${this.config.decayThresholds.signStabilityFloor}`)
      } else {
        multipliers[factor] = 1
      }
    }

    return { multipliers, reasons, decayedByFactor }
  }

  loadIcSharpeByState(
    icData: Partial<Record<HmmStateName, Record<string, number>>>,
  ): Partial<Record<HmmStateName, Record<string, number>>> {
    return icData
  }

  clear(): void {
    this.signals = []
    this.returns = []
    this.decayCache.clear()
  }
}

function normalizeSymbol(symbol: string | undefined): string {
  const normalized = symbol?.trim()
  return normalized ? normalized : LEGACY_SYMBOL
}

function normalizeSignalRecord(record: IcMonitorSnapshot['signals'][number]): SignalRecord {
  return {
    factor: record.factor,
    value: record.value,
    timestamp: record.timestamp,
    symbol: normalizeSymbol(record.symbol),
  }
}

function normalizeReturnRecord(record: IcMonitorSnapshot['returns'][number]): ReturnRecord {
  return {
    timestamp: record.timestamp,
    value: record.value,
    symbol: normalizeSymbol(record.symbol),
  }
}
