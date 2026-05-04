export type AtrTrailingStopSide = 'long' | 'short'

export interface AtrTrailingStopInput {
  side: AtrTrailingStopSide
  price: number
  atr: number
  multiplier: number
  previousStop?: number | null
}

export interface AtrTrailingStopDecision {
  side: AtrTrailingStopSide
  stop: number
  rawCandidateStop: number
  tightened: boolean
}

export function computeAtrTrailingStop(input: AtrTrailingStopInput): AtrTrailingStopDecision {
  if (!Number.isFinite(input.price) || input.price <= 0) {
    throw new Error('price must be a finite number > 0')
  }
  if (!Number.isFinite(input.atr) || input.atr <= 0) {
    throw new Error('atr must be a finite number > 0')
  }
  if (!Number.isFinite(input.multiplier) || input.multiplier <= 0) {
    throw new Error('multiplier must be a finite number > 0')
  }

  const rawCandidateStop = input.side === 'long'
    ? input.price - input.multiplier * input.atr
    : input.price + input.multiplier * input.atr
  const previousStop = Number.isFinite(input.previousStop ?? Number.NaN)
    ? input.previousStop
    : null
  const stop = previousStop == null
    ? rawCandidateStop
    : input.side === 'long'
      ? Math.max(previousStop, rawCandidateStop)
      : Math.min(previousStop, rawCandidateStop)

  return {
    side: input.side,
    stop,
    rawCandidateStop,
    tightened: previousStop == null ? true : stop !== previousStop,
  }
}
