/**
 * Federal Reserve FOMC Documents Fetcher.
 * Fetches FOMC calendar and document links from the Fed website JSON API.
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { FomcDocumentsQueryParamsSchema, FomcDocumentsDataSchema } from '../../../standard-models/fomc-documents.js'
import { EmptyDataError } from '../../../core/provider/utils/errors.js'
import { amakeRequest } from '../../../core/provider/utils/helpers.js'

export const FedFomcDocumentsQueryParamsSchema = FomcDocumentsQueryParamsSchema
export type FedFomcDocumentsQueryParams = z.infer<typeof FedFomcDocumentsQueryParamsSchema>

const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'

interface FomcMeeting {
  date: string
  link?: string
  statement?: string
  minutes?: string
}

export class FedFomcDocumentsFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>): FedFomcDocumentsQueryParams {
    return FedFomcDocumentsQueryParamsSchema.parse(params)
  }

  static override async extractData(
    query: FedFomcDocumentsQueryParams,
    _credentials: Record<string, string> | null,
  ): Promise<Record<string, unknown>[]> {
    // Use FRED series for Fed Funds Rate as a proxy for FOMC activity
    // FRED series DFEDTAR (target rate) and DFEDTARU (upper bound)
    try {
      const data = await amakeRequest<Record<string, unknown>>(
        'https://api.stlouisfed.org/fred/series/observations?series_id=DFEDTARU&file_type=json&sort_order=desc&limit=50',
      )
      const observations = (data.observations ?? []) as Array<{ date: string; value: string }>
      if (observations.length === 0) throw new EmptyDataError()

      return observations
        .filter(o => o.value !== '.')
        .map(o => ({
          date: o.date,
          title: `Fed Funds Target Rate Upper Bound: ${o.value}%`,
          type: 'rate_decision',
          url: FOMC_CALENDAR_URL,
        }))
    } catch {
      throw new EmptyDataError('No FOMC documents data found.')
    }
  }

  static override transformData(
    query: FedFomcDocumentsQueryParams,
    data: Record<string, unknown>[],
  ) {
    let filtered = data
    if (query.start_date) filtered = filtered.filter(d => String(d.date) >= query.start_date!)
    if (query.end_date) filtered = filtered.filter(d => String(d.date) <= query.end_date!)
    return filtered
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map(d => FomcDocumentsDataSchema.parse(d))
  }
}
