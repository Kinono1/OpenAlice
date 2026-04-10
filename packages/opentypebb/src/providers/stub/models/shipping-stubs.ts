/**
 * Shipping Stub Fetchers.
 *
 * These register the shipping endpoints with proper schemas but always throw
 * EmptyDataError. Once a reliable public API for shipping data is found,
 * replace with real fetchers.
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { PortInfoQueryParamsSchema } from '../../../standard-models/port-info.js'
import { PortVolumeQueryParamsSchema } from '../../../standard-models/port-volume.js'
import { ChokepointInfoQueryParamsSchema } from '../../../standard-models/chokepoint-info.js'
import { ChokepointVolumeQueryParamsSchema } from '../../../standard-models/chokepoint-volume.js'
import { EmptyDataError } from '../../../core/provider/utils/errors.js'

// --- Port Info ---

export class StubPortInfoFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>) {
    return PortInfoQueryParamsSchema.parse(params)
  }

  static override async extractData(): Promise<Record<string, unknown>[]> {
    throw new EmptyDataError('Port info data source not yet implemented. No reliable public API available.')
  }

  static override transformData(_query: unknown, data: Record<string, unknown>[]) {
    return data
  }
}

// --- Port Volume ---

export class StubPortVolumeFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>) {
    return PortVolumeQueryParamsSchema.parse(params)
  }

  static override async extractData(): Promise<Record<string, unknown>[]> {
    throw new EmptyDataError('Port volume data source not yet implemented. No reliable public API available.')
  }

  static override transformData(_query: unknown, data: Record<string, unknown>[]) {
    return data
  }
}

// --- Chokepoint Info ---

export class StubChokepointInfoFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>) {
    return ChokepointInfoQueryParamsSchema.parse(params)
  }

  static override async extractData(): Promise<Record<string, unknown>[]> {
    throw new EmptyDataError('Chokepoint info data source not yet implemented. No reliable public API available.')
  }

  static override transformData(_query: unknown, data: Record<string, unknown>[]) {
    return data
  }
}

// --- Chokepoint Volume ---

export class StubChokepointVolumeFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>) {
    return ChokepointVolumeQueryParamsSchema.parse(params)
  }

  static override async extractData(): Promise<Record<string, unknown>[]> {
    throw new EmptyDataError('Chokepoint volume data source not yet implemented. No reliable public API available.')
  }

  static override transformData(_query: unknown, data: Record<string, unknown>[]) {
    return data
  }
}
