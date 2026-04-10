/**
 * Deribit Futures Curve Model.
 * Maps to: openbb_deribit/models/futures_curve.py
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { FuturesCurveDataSchema } from '../../../standard-models/futures-curve.js'
import { EmptyDataError } from '../../../core/provider/utils/errors.js'
import { getFuturesCurveSymbols, getTickerData, DERIBIT_FUTURES_CURVE_SYMBOLS } from '../utils/helpers.js'

export const DeribitFuturesCurveQueryParamsSchema = z.object({
  symbol: z.string().default('BTC').transform(v => v.toUpperCase()).describe('Symbol: BTC, ETH, or PAXG.'),
  date: z.string().nullable().default(null).describe('Not used for Deribit. Use hours_ago instead.'),
}).passthrough()

export type DeribitFuturesCurveQueryParams = z.infer<typeof DeribitFuturesCurveQueryParamsSchema>

export const DeribitFuturesCurveDataSchema = FuturesCurveDataSchema
export type DeribitFuturesCurveData = z.infer<typeof DeribitFuturesCurveDataSchema>

export class DeribitFuturesCurveFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>): DeribitFuturesCurveQueryParams {
    return DeribitFuturesCurveQueryParamsSchema.parse(params)
  }

  static override async extractData(
    query: DeribitFuturesCurveQueryParams,
    _credentials: Record<string, string> | null,
  ): Promise<Record<string, unknown>[]> {
    const symbol = query.symbol
    if (!DERIBIT_FUTURES_CURVE_SYMBOLS.includes(symbol)) {
      throw new Error(`Invalid symbol: ${symbol}. Valid: ${DERIBIT_FUTURES_CURVE_SYMBOLS.join(', ')}`)
    }

    const instrumentNames = await getFuturesCurveSymbols(symbol)
    if (instrumentNames.length === 0) throw new EmptyDataError('No instruments found.')

    const results: Record<string, unknown>[] = []
    const tasks = instrumentNames.map(async (name) => {
      try {
        const ticker = await getTickerData(name)
        return { instrument_name: name, ...ticker }
      } catch {
        return null
      }
    })
    const tickerResults = await Promise.all(tasks)
    for (const t of tickerResults) {
      if (t) results.push(t)
    }

    if (results.length === 0) throw new EmptyDataError('No ticker data found.')
    return results
  }

  static override transformData(
    _query: DeribitFuturesCurveQueryParams,
    data: Record<string, unknown>[],
  ): DeribitFuturesCurveData[] {
    const today = new Date().toISOString().slice(0, 10)

    return data.map(d => {
      const name = d.instrument_name as string
      const parts = name.split('-')
      let expiration = parts[1] ?? 'PERPETUAL'

      // Parse Deribit date format (e.g., "28MAR25") to ISO
      if (expiration === 'PERPETUAL') {
        expiration = today
      }

      const price = (d.last_price as number) ?? (d.mark_price as number) ?? 0

      return FuturesCurveDataSchema.parse({
        date: today,
        expiration,
        price,
      })
    }).sort((a, b) => a.expiration.localeCompare(b.expiration))
  }
}
