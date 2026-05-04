import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface FundingHistoryPoint {
  symbol: string
  fundingRate: number
  previousFundingRate?: number
  timestamp: number
}

export interface OpenInterestHistoryPoint {
  symbol: string
  timeframe?: string
  openInterest: number
  openInterestValue?: number
  timestamp: number
}

export interface CarrySignalPoint {
  time: number
  observedAt?: number
  effectiveAt?: number
  fundingSpread: number
  fundingSpreadZScore: number
  openInterestValueRatio?: number
}

export async function loadFundingHistory(path: string): Promise<FundingHistoryPoint[]> {
  const raw = JSON.parse(await readFile(resolve(path), 'utf-8')) as FundingHistoryPoint[]
  return raw
    .filter((point) =>
      Number.isFinite(point.timestamp) &&
      Number.isFinite(point.fundingRate))
    .sort((left, right) => left.timestamp - right.timestamp)
}

export async function loadOpenInterestHistory(path: string): Promise<OpenInterestHistoryPoint[]> {
  const raw = JSON.parse(await readFile(resolve(path), 'utf-8')) as OpenInterestHistoryPoint[]
  return raw
    .filter((point) =>
      Number.isFinite(point.timestamp) &&
      Number.isFinite(point.openInterest))
    .sort((left, right) => left.timestamp - right.timestamp)
}

export function buildCarrySignalSeries(input: {
  leaderFunding: FundingHistoryPoint[]
  hedgeFunding: FundingHistoryPoint[]
  leaderOpenInterest?: OpenInterestHistoryPoint[]
  hedgeOpenInterest?: OpenInterestHistoryPoint[]
  zScoreLookback?: number
}): CarrySignalPoint[] {
  const hedgeFundingByTime = new Map(input.hedgeFunding.map((point) => [point.timestamp, point]))
  const leaderOiByTime = new Map((input.leaderOpenInterest ?? []).map((point) => [point.timestamp, point]))
  const hedgeOiByTime = new Map((input.hedgeOpenInterest ?? []).map((point) => [point.timestamp, point]))

  const points = input.leaderFunding
    .map((leaderPoint) => {
      const hedgePoint = hedgeFundingByTime.get(leaderPoint.timestamp)
      if (!hedgePoint) return null

      const leaderOi = leaderOiByTime.get(leaderPoint.timestamp)
      const hedgeOi = hedgeOiByTime.get(leaderPoint.timestamp)
      const leaderOiValue = leaderOi?.openInterestValue
      const hedgeOiValue = hedgeOi?.openInterestValue
      const fundingSpread = leaderPoint.fundingRate - hedgePoint.fundingRate

      const observedAt = leaderPoint.timestamp > 1e11 ? Math.floor(leaderPoint.timestamp / 1000) : Math.floor(leaderPoint.timestamp)
      return {
        time: observedAt,
        observedAt,
        effectiveAt: observedAt,
        fundingSpread,
        fundingSpreadZScore: 0,
        openInterestValueRatio:
          typeof leaderOiValue === 'number' &&
          Number.isFinite(leaderOiValue) &&
          leaderOiValue > 0 &&
          typeof hedgeOiValue === 'number' &&
          Number.isFinite(hedgeOiValue) &&
          hedgeOiValue > 0
            ? leaderOiValue / hedgeOiValue
            : undefined,
      }
    })
    .filter((point): point is CarrySignalPoint => point != null)

  const lookback = Math.max(8, input.zScoreLookback ?? 30)
  for (let index = 0; index < points.length; index += 1) {
    const start = Math.max(0, index - lookback)
    const window = points.slice(start, index)
    if (window.length < 8) {
      points[index].fundingSpreadZScore = 0
      continue
    }
    const mean = window.reduce((sum, point) => sum + point.fundingSpread, 0) / window.length
    const variance = window.reduce((sum, point) => sum + (point.fundingSpread - mean) ** 2, 0) / window.length
    const std = Math.sqrt(Math.max(variance, 0))
    points[index].fundingSpreadZScore =
      std > 0 ? (points[index].fundingSpread - mean) / std : 0
  }

  return points
}

export function buildCarryEntryGate(input: {
  series: CarrySignalPoint[]
  minAbsFundingSpread: number
  minAbsFundingZScore?: number
  minOpenInterestRatio?: number
}): { allowedEntryTimes: number[] } {
  const allowedEntryTimes = input.series
    .filter((point) => {
      if (Math.abs(point.fundingSpread) < input.minAbsFundingSpread) {
        return false
      }
      if (
        typeof input.minAbsFundingZScore === 'number' &&
        Math.abs(point.fundingSpreadZScore) < input.minAbsFundingZScore
      ) {
        return false
      }
      if (input.minOpenInterestRatio == null) {
        return true
      }
      return (
        typeof point.openInterestValueRatio === 'number' &&
        Number.isFinite(point.openInterestValueRatio) &&
        point.openInterestValueRatio >= input.minOpenInterestRatio
      )
    })
    .map((point) => point.time)

  return { allowedEntryTimes }
}
