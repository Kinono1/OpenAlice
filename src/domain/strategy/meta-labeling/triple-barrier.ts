import type { OhlcvData } from '../../analysis/indicator/types.js'

export type TripleBarrierSide = 'long' | 'short'
export type TripleBarrierExitReason = 'take-profit' | 'stop-loss' | 'time-expiry'

export interface TripleBarrierInput {
  candles: OhlcvData[]
  entryIndex: number
  upperBarrierPct: number
  lowerBarrierPct: number
  maxHoldingBars: number
  side?: TripleBarrierSide
  barrierMode?: 'static_pct' | 'volatility_scaled'
  volatilityLookbackBars?: number
  volatilityEstimator?: 'garman_klass' | 'parkinson' | 'close_to_close'
}

export interface TripleBarrierLabel {
  label: 0 | 1
  exitReason: TripleBarrierExitReason
  exitIndex: number
  entryPrice: number
  exitPrice: number
  realizedReturnPct: number
  hitUpperBarrier: boolean
  hitLowerBarrier: boolean
}

function signedReturnPct(
  side: TripleBarrierSide,
  entryPrice: number,
  exitPrice: number,
): number {
  const raw = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0
  return side === 'long' ? raw : -raw
}

export function evaluateTripleBarrierLabel(
  input: TripleBarrierInput,
): TripleBarrierLabel {
  const side = input.side ?? 'long'
  const entryCandle = input.candles[input.entryIndex]
  if (!entryCandle) {
    throw new Error(`entryIndex ${input.entryIndex} is out of range.`)
  }

  const entryPrice = entryCandle.close
  const barrierPct = resolveBarrierPct(input)
  const upperBarrierPrice = entryPrice * (1 + barrierPct.upper / 100)
  const lowerBarrierPrice = entryPrice * (1 - barrierPct.lower / 100)
  const finalIndex = Math.min(
    input.candles.length - 1,
    input.entryIndex + Math.max(1, input.maxHoldingBars),
  )

  for (let index = input.entryIndex + 1; index <= finalIndex; index += 1) {
    const candle = input.candles[index]
    if (!candle) {
      break
    }

    const upperHit = candle.high >= upperBarrierPrice
    if (upperHit) {
      const exitPrice = upperBarrierPrice
      return {
        label: side === 'long' ? 1 : 0,
        exitReason: side === 'long' ? 'take-profit' : 'stop-loss',
        exitIndex: index,
        entryPrice,
        exitPrice,
        realizedReturnPct: signedReturnPct(side, entryPrice, exitPrice),
        hitUpperBarrier: true,
        hitLowerBarrier: false,
      }
    }

    const lowerHit = candle.low <= lowerBarrierPrice
    if (lowerHit) {
      const exitPrice = lowerBarrierPrice
      return {
        label: side === 'long' ? 0 : 1,
        exitReason: side === 'long' ? 'stop-loss' : 'take-profit',
        exitIndex: index,
        entryPrice,
        exitPrice,
        realizedReturnPct: signedReturnPct(side, entryPrice, exitPrice),
        hitUpperBarrier: false,
        hitLowerBarrier: true,
      }
    }
  }

  const exitCandle = input.candles[finalIndex]
  return {
    label:
      signedReturnPct(side, entryPrice, exitCandle.close) > 0 ? 1 : 0,
    exitReason: 'time-expiry',
    exitIndex: finalIndex,
    entryPrice,
    exitPrice: exitCandle.close,
    realizedReturnPct: signedReturnPct(side, entryPrice, exitCandle.close),
    hitUpperBarrier: false,
    hitLowerBarrier: false,
  }
}

function resolveBarrierPct(input: TripleBarrierInput): { upper: number; lower: number } {
  if (input.barrierMode !== 'volatility_scaled') {
    return {
      upper: input.upperBarrierPct,
      lower: input.lowerBarrierPct,
    }
  }

  const volPct = estimateVolatilityPct({
    candles: input.candles,
    entryIndex: input.entryIndex,
    lookbackBars: input.volatilityLookbackBars ?? 24,
    estimator: input.volatilityEstimator ?? 'garman_klass',
  })
  const safeVolPct = Math.max(volPct, 0.01)
  return {
    upper: Math.max(0.01, input.upperBarrierPct * safeVolPct),
    lower: Math.max(0.01, input.lowerBarrierPct * safeVolPct),
  }
}

function estimateVolatilityPct(input: {
  candles: OhlcvData[]
  entryIndex: number
  lookbackBars: number
  estimator: 'garman_klass' | 'parkinson' | 'close_to_close'
}): number {
  const start = Math.max(0, input.entryIndex - Math.max(2, input.lookbackBars) + 1)
  const window = input.candles.slice(start, input.entryIndex + 1)
  if (window.length < 2) return 0

  if (input.estimator === 'garman_klass') {
    const terms = window
      .filter((candle) => candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0)
      .map((candle) => {
        const highLow = Math.log(candle.high / candle.low)
        const closeOpen = Math.log(candle.close / candle.open)
        return 0.5 * highLow * highLow - (2 * Math.log(2) - 1) * closeOpen * closeOpen
      })
    if (terms.length > 0) {
      return Math.sqrt(Math.max(mean(terms), 0)) * 100
    }
  }

  if (input.estimator === 'parkinson') {
    const terms = window
      .filter((candle) => candle.high > 0 && candle.low > 0)
      .map((candle) => {
        const highLow = Math.log(candle.high / candle.low)
        return highLow * highLow / (4 * Math.log(2))
      })
    if (terms.length > 0) {
      return Math.sqrt(Math.max(mean(terms), 0)) * 100
    }
  }

  const returns: number[] = []
  for (let index = 1; index < window.length; index += 1) {
    const prev = window[index - 1].close
    const current = window[index].close
    if (prev > 0 && current > 0) {
      returns.push(Math.log(current / prev))
    }
  }
  if (returns.length === 0) return 0
  const avg = mean(returns)
  return Math.sqrt(mean(returns.map((value) => (value - avg) ** 2))) * 100
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
