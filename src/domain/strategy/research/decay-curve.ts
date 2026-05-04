import { analyzeInformationCoefficient, type IcSample } from './ic-analyzer.js'

export interface DecayCurvePoint {
  horizon: number
  meanIc: number
  icIr: number
  winRate: number
}

export interface DecayCurveSampleSet {
  horizon: number
  samples: IcSample[]
}

export interface DecayCurveResult {
  points: DecayCurvePoint[]
  halfLifeHorizon: number | null
}

export function buildIcDecayCurve(
  inputs: DecayCurveSampleSet[],
): DecayCurveResult {
  const points = [...inputs]
    .sort((left, right) => left.horizon - right.horizon)
    .map((input) => {
      const summary = analyzeInformationCoefficient(input.samples)
      return {
        horizon: input.horizon,
        meanIc: summary.meanIc,
        icIr: summary.icIr,
        winRate: summary.winRate,
      }
    })

  const firstMagnitude = Math.abs(points[0]?.meanIc ?? 0)
  const halfLifeThreshold = firstMagnitude * 0.5
  const halfLifePoint = points.find((point) => Math.abs(point.meanIc) <= halfLifeThreshold)

  return {
    points,
    halfLifeHorizon: firstMagnitude > 0 ? (halfLifePoint?.horizon ?? null) : null,
  }
}
