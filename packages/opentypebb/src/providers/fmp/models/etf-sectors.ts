/**
 * FMP ETF Sectors Model.
 * Maps to: openbb_fmp/models/etf_sectors.py
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { EtfSectorsQueryParamsSchema, EtfSectorsDataSchema } from '../../../standard-models/etf-sectors.js'
import { applyAliases } from '../../../core/provider/utils/helpers.js'
import { getDataMany } from '../utils/helpers.js'

const ALIAS_DICT: Record<string, string> = { weight: 'weightPercentage' }

export const FMPEtfSectorsQueryParamsSchema = EtfSectorsQueryParamsSchema
export type FMPEtfSectorsQueryParams = z.infer<typeof FMPEtfSectorsQueryParamsSchema>

export const FMPEtfSectorsDataSchema = EtfSectorsDataSchema.passthrough()
export type FMPEtfSectorsData = z.infer<typeof FMPEtfSectorsDataSchema>

export class FMPEtfSectorsFetcher extends Fetcher {
  static override transformQuery(params: Record<string, unknown>): FMPEtfSectorsQueryParams {
    return FMPEtfSectorsQueryParamsSchema.parse(params)
  }

  static override async extractData(
    query: FMPEtfSectorsQueryParams,
    credentials: Record<string, string> | null,
  ): Promise<Record<string, unknown>[]> {
    const apiKey = credentials?.fmp_api_key ?? ''
    const symbol = query.symbol
    return getDataMany(
      `https://financialmodelingprep.com/stable/etf/sector-weightings?symbol=${symbol}&apikey=${apiKey}`,
    )
  }

  static override transformData(
    _query: FMPEtfSectorsQueryParams,
    data: Record<string, unknown>[],
  ): FMPEtfSectorsData[] {
    const results = data.map((d) => {
      const aliased = applyAliases(d, ALIAS_DICT)
      return FMPEtfSectorsDataSchema.parse(aliased)
    })
    // Sort by weight descending
    return results.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
  }
}
