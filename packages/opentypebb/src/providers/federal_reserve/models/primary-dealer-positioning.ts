/**
 * Federal Reserve Primary Dealer Positioning Fetcher.
 * Uses NY Fed Primary Dealer Statistics via FRED.
 * Series: PDTNCNET (Total Net Positions), etc.
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { PrimaryDealerPositioningQueryParamsSchema, PrimaryDealerPositioningDataSchema } from '../../../standard-models/primary-dealer-positioning.js'
import { EmptyDataError } from '../../../core/provider/utils/errors.js'
import { fetchFredMultiSeries, multiSeriesToRecords, getFredApiKey } from '../utils/fred-helpers.js'

export const FedPrimaryDealerPositioningQueryParamsSchema = PrimaryDealerPositioningQueryParamsSchema
export type FedPrimaryDealerPositioningQueryParams = z.infer<typeof FedPrimaryDealerPositioningQueryParamsSchema>

// Primary Dealer FRED series
const SERIES = ['PDTNCNET', 'PDUSTTOT', 'PDMBSTOT']
const FIELD_MAP: Record<string, string> = {
  PDTNCNET: 'total_net_position',
  PDUSTTOT: 'treasury_total',
  PDMBSTOT: 'mbs_total',
}

export class FedPrimaryDealerPositioningFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>): FedPrimaryDealerPositioningQueryParams {
    return FedPrimaryDealerPositioningQueryParamsSchema.parse(params)
  }

  static override async extractData(
    query: FedPrimaryDealerPositioningQueryParams,
    credentials: Record<string, string> | null,
  ): Promise<Record<string, unknown>[]> {
    const apiKey = getFredApiKey(credentials)
    const dataMap = await fetchFredMultiSeries(SERIES, apiKey, {
      startDate: query.start_date,
      endDate: query.end_date,
    })

    const records = multiSeriesToRecords(dataMap, FIELD_MAP)
    if (records.length === 0) throw new EmptyDataError('No primary dealer positioning data found.')
    return records
  }

  static override transformData(
    _query: FedPrimaryDealerPositioningQueryParams,
    data: Record<string, unknown>[],
  ) {
    return data.map(d => PrimaryDealerPositioningDataSchema.parse(d))
  }
}
