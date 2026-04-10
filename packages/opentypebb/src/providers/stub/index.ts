/**
 * Stub Provider Module.
 * Contains placeholder fetchers for endpoints that don't yet have a reliable public data source.
 * These register the models in the registry so routes can be created, but always throw EmptyDataError.
 */

import { Provider } from '../../core/provider/abstract/provider.js'

import {
  StubPortInfoFetcher,
  StubPortVolumeFetcher,
  StubChokepointInfoFetcher,
  StubChokepointVolumeFetcher,
} from './models/shipping-stubs.js'

export const stubProvider = new Provider({
  name: 'stub',
  website: '',
  description: 'Placeholder provider for endpoints awaiting a public data source.',
  fetcherDict: {
    PortInfo: StubPortInfoFetcher,
    PortVolume: StubPortVolumeFetcher,
    ChokepointInfo: StubChokepointInfoFetcher,
    ChokepointVolume: StubChokepointVolumeFetcher,
  },
  reprName: 'Stub',
})
