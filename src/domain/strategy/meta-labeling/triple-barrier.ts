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
  const upperBarrierPrice = side === 'long'
    ? entryPrice * (1 + input.upperBarrierPct / 100)
    : entryPrice * (1 + input.lowerBarrierPct / 100)
  const lowerBarrierPrice = side === 'long'
    ? entryPrice * (1 - input.lowerBarrierPct / 100)
    : entryPrice * (1 - input.upperBarrierPct / 100)
  const finalIndex = Math.min(
    input.candles.length - 1,
    input.entryIndex + Math.max(1, input.maxHoldingBars),
  )

  for (let index = input.entryIndex + 1; index <= finalIndex; index += 1) {
    const candle = input.candles[index]
    if (!candle) {
      break
    }

    const upperHit = side === 'long'
      ? candle.high >= upperBarrierPrice
      : candle.high >= upperBarrierPrice
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

    const lowerHit = side === 'long'
      ? candle.low <= lowerBarrierPrice
      : candle.low <= lowerBarrierPrice
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
