/**
 * Federal Reserve Central Bank Holdings Model.
 * Maps to: openbb_federal_reserve/models/central_bank_holdings.py
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { CentralBankHoldingsDataSchema } from '../../../standard-models/central-bank-holdings.js'
import { EmptyDataError } from '../../../core/provider/utils/errors.js'
import { amakeRequest } from '../../../core/provider/utils/helpers.js'

export const FedCentralBankHoldingsQueryParamsSchema = z.object({
  date: z.string().nullable().default(null).describe('Specific date for holdings data in YYYY-MM-DD.'),
}).passthrough()

export type FedCentralBankHoldingsQueryParams = z.infer<typeof FedCentralBankHoldingsQueryParamsSchema>

export const FedCentralBankHoldingsDataSchema = CentralBankHoldingsDataSchema.extend({
  treasury_holding_value: z.number().nullable().default(null).describe('Treasury securities held (millions USD).'),
  mbs_holding_value: z.number().nullable().default(null).describe('MBS held (millions USD).'),
  agency_holding_value: z.number().nullable().default(null).describe('Agency debt held (millions USD).'),
  total_assets: z.number().nullable().default(null).describe('Total assets (millions USD).'),
}).passthrough()

export type FedCentralBankHoldingsData = z.infer<typeof FedCentralBankHoldingsDataSchema>

// FRED series for Fed balance sheet
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'

export class FedCentralBankHoldingsFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>): FedCentralBankHoldingsQueryParams {
    return FedCentralBankHoldingsQueryParamsSchema.parse(params)
  }

  static override async extractData(
    query: FedCentralBankHoldingsQueryParams,
    credentials: Record<string, string> | null,
  ): Promise<Record<string, unknown>[]> {
    const fredKey = credentials?.fred_api_key ?? ''

    // Fed H.4.1 data is available from FRED
    // TREAST = Treasury securities held, MBST = MBS held, WSHOMCB = Total assets
    const series = ['TREAST', 'MBST', 'WSHOMCB']
    const dateParam = query.date ? `&observation_start=${query.date}&observation_end=${query.date}` : ''
    const apiKeyParam = fredKey ? `&api_key=${fredKey}` : ''

    const dataMap: Record<string, Record<string, number>> = {}

    for (const seriesId of series) {
      try {
        const url = `${FRED_BASE}?series_id=${seriesId}&file_type=json&sort_order=desc&limit=100${dateParam}${apiKeyParam}`
        const data = await amakeRequest<Record<string, unknown>>(url)
        const observations = (data.observations ?? []) as Array<{ date: string; value: string }>

        for (const obs of observations) {
          const val = parseFloat(obs.value)
          if (!isNaN(val)) {
            if (!dataMap[obs.date]) dataMap[obs.date] = {}
            dataMap[obs.date][seriesId] = val
          }
        }
      } catch {
        // Skip series that fail
      }
    }

    const results = Object.entries(dataMap).map(([date, values]) => ({
      date,
      treasury_holding_value: values.TREAST ?? null,
      mbs_holding_value: values.MBST ?? null,
      total_assets: values.WSHOMCB ?? null,
    }))

    if (results.length === 0) throw new EmptyDataError('No Fed holdings data found.')
    return results
  }

  static override transformData(
    _query: FedCentralBankHoldingsQueryParams,
    data: Record<string, unknown>[],
  ): FedCentralBankHoldingsData[] {
    return data
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map(d => FedCentralBankHoldingsDataSchema.parse(d))
  }
}
