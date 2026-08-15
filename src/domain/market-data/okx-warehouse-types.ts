export type OkxInstrumentType = 'SPOT' | 'SWAP' | 'FUTURES' | 'OPTION'

export type OkxMarketDataset =
  | 'instrument'
  | 'ticker'
  | 'candle'
  | 'funding'
  | 'mark_index'
  | 'open_interest'
  | 'long_short'
  | 'trade'
  | 'orderbook_snapshot'
  | 'orderbook_delta'
  | 'liquidation'

export interface OkxInstrumentRecord {
  schemaVersion: 'okx_instrument.v1'
  exchange: 'okx'
  instrumentId: string
  instrumentType: OkxInstrumentType
  instrumentFamily: string | null
  underlying: string | null
  baseCurrency: string | null
  quoteCurrency: string | null
  settleCurrency: string | null
  contractValue: string | null
  contractMultiplier: string | null
  tickSize: string
  lotSize: string
  minimumOrderSize: string
  listingTime: string | null
  expiryTime: string | null
  optionType: 'C' | 'P' | null
  strikePrice: string | null
  state: string
  marginEligibility: boolean | null
  eventTime: string
  availableAt: string
  payloadHash: string
}

export interface OkxMarketEvent<T = unknown> {
  schemaVersion: 'okx_market_event.v1'
  exchange: 'okx'
  dataset: OkxMarketDataset
  instrumentType: OkxInstrumentType
  instrumentId: string
  instrumentFamily: string | null
  symbol: string
  channel: string
  sourceTransport: 'rest' | 'websocket' | 'derived'
  sourceEndpoint: string
  eventTime: string
  availableAt: string
  ingestedAt: string
  confirmed: boolean | null
  sequenceId: string | null
  checksum: string | null
  collectionRunId: string
  universeManifestId: string | null
  dedupKey: string
  payloadHash: string
  payload: T
}

export interface OkxRawSegmentManifest {
  schemaVersion: 'okx_raw_segment_manifest.v1'
  exchange: 'okx'
  segmentId: string
  relativePath: string
  dataset: OkxMarketDataset
  instrumentType: OkxInstrumentType
  bar?: string | null
  instrumentId?: string | null
  date: string
  hour: string
  collectionRunId: string
  sealed: true
  sealedAt: string
  rowCount: number
  duplicateRows: number
  conflictingDuplicateRows: number
  minEventTime: string | null
  maxEventTime: string | null
  sha256: string
  bytes: number
  parquetPath: string | null
  parquetSha256: string | null
  parquetRows: number | null
  archivedBatchId: string | null
  archivedAt?: string | null
  localDeletedAt?: string | null
  localDeletionManifestPath?: string | null
}

export interface OkxDepthUniverseManifest {
  schemaVersion: 'okx_depth_universe.v1'
  manifestId: string
  generatedAt: string
  effectiveAt: string
  fixedDeepInstruments: string[]
  dynamicInstruments: string[]
  previousDynamicInstruments: string[]
  added: string[]
  removed: string[]
  maxDailyChanges: number
  challengerImprovementPct: number
  mode: 'continuous_books' | 'bounded_capture_window' | 'blocked_storage_budget'
  rankings: Array<{
    instrumentId: string
    quoteTurnover24h: number
    spreadBps: number
    turnoverPercentile: number
    inverseSpreadPercentile: number
    score: number
  }>
}
