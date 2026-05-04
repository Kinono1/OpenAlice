/**
 * Intrinio Options Unusual Model.
 * Maps to: openbb_intrinio/models/options_unusual.py
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { OptionsUnusualDataSchema } from '../../../standard-models/options-unusual.js'
import { EmptyDataError } from '../../../core/provider/utils/errors.js'
import { amakeRequest } from '../../../core/provider/utils/helpers.js'

export const IntrinioOptionsUnusualQueryParamsSchema = z.object({
  symbol: z.string().nullable().default(null).transform(v => v ? v.toUpperCase() : null).describe('Symbol to filter by.'),
}).passthrough()

export type IntrinioOptionsUnusualQueryParams = z.infer<typeof IntrinioOptionsUnusualQueryParamsSchema>
export type IntrinioOptionsUnusualData = z.infer<typeof OptionsUnusualDataSchema>

function createIntrinioUrl(path: string, apiKey: string, query?: Record<string, string | null>): string {
  const url = new URL(path, 'https://api-v2.intrinio.com')
  url.searchParams.set('api_key', apiKey)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

export class IntrinioOptionsUnusualFetcher extends Fetcher {
  static override requireCredentials = true

  static override transformQuery(params: Record<string, unknown>): IntrinioOptionsUnusualQueryParams {
    return IntrinioOptionsUnusualQueryParamsSchema.parse(params)
  }

  static override async extractData(
    query: IntrinioOptionsUnusualQueryParams,
    credentials: Record<string, string> | null,
  ): Promise<Record<string, unknown>[]> {
    const apiKey = credentials?.intrinio_api_key ?? ''
    if (!apiKey) throw new EmptyDataError('Intrinio API key required.')

    const url = createIntrinioUrl('/options/unusual_activity', apiKey, {
      symbol: query.symbol,
    })

    try {
      const data = await amakeRequest<Record<string, unknown>>(url)
      const activities = (data.trades ?? data.unusual_activity ?? []) as Record<string, unknown>[]
      if (!Array.isArray(activities) || activities.length === 0) throw new EmptyDataError()
      return activities
    } catch (err) {
      if (err instanceof EmptyDataError) throw err
      throw new EmptyDataError(`Failed to fetch Intrinio unusual options: ${err}`)
    }
  }

  static override transformData(
    _query: IntrinioOptionsUnusualQueryParams,
    data: Record<string, unknown>[],
  ): IntrinioOptionsUnusualData[] {
    return data.map(d => OptionsUnusualDataSchema.parse({
      underlying_symbol: d.symbol ?? d.underlying_symbol ?? null,
      contract_symbol: d.contract ?? d.contract_symbol ?? '',
    }))
  }
}
