export interface PaperUniverseAsset {
  base: string
  paperSymbol: string
  okxInstId: string
  binanceSymbol: string
  storageSymbol: string
  file: string
}

export type PaperUniverseTimeframe = '1h' | '5m' | '1s'

const DEFAULT_BASES = [
  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
  'DOGE',
  'ADA',
  'AVAX',
  'LINK',
  'DOT',
  'LTC',
  'BCH',
  'UNI',
  'AAVE',
  'ARB',
  'OP',
  'APT',
  'SUI',
  'TON',
  'NEAR',
  'ATOM',
  'FIL',
  'INJ',
  'ETC',
  'TRX',
  'POL',
  'WLD',
  'PEPE',
  'SHIB',
  'ORDI',
  'TIA',
  'SEI',
  'JUP',
  'WIF',
]

const DEFAULT_MARKET_DATA_BASES = [
  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
]

const SECOND_LEVEL_BASES = [
  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
  'DOGE',
  'ADA',
  'LINK',
  'AVAX',
  'LTC',
]

const DEFAULT_MARKET_DATA_SECOND_LEVEL_BASES = [
  'BTC',
  'ETH',
  'SOL',
]

export function defaultPaperUniverseAssets(): PaperUniverseAsset[] {
  return DEFAULT_BASES.map(base => buildPaperUniverseAsset(base))
}

export function defaultSecondLevelUniverseAssets(): PaperUniverseAsset[] {
  return SECOND_LEVEL_BASES.map(base => buildPaperUniverseAsset(base, '1s'))
}

export function defaultMarketDataUniverseAssets(timeframe: PaperUniverseTimeframe = '1h'): PaperUniverseAsset[] {
  return resolveUniverseBases(
    'OPENALICE_MARKET_DATA_BASES',
    DEFAULT_MARKET_DATA_BASES,
    DEFAULT_BASES,
  ).map(base => buildPaperUniverseAsset(base, timeframe))
}

export function defaultSecondLevelMarketDataUniverseAssets(): PaperUniverseAsset[] {
  return resolveUniverseBases(
    'OPENALICE_MARKET_DATA_1S_BASES',
    DEFAULT_MARKET_DATA_SECOND_LEVEL_BASES,
    SECOND_LEVEL_BASES,
  ).map(base => buildPaperUniverseAsset(base, '1s'))
}

export function defaultPaperUniverseSymbols(): string[] {
  return defaultPaperUniverseAssets().map(asset => asset.paperSymbol)
}

export function defaultSecondLevelUniverseSymbols(): string[] {
  return defaultSecondLevelUniverseAssets().map(asset => asset.paperSymbol)
}

export function defaultMarketDataUniverseSymbols(): string[] {
  return defaultMarketDataUniverseAssets().map(asset => asset.paperSymbol)
}

export function defaultSecondLevelMarketDataUniverseSymbols(): string[] {
  return defaultSecondLevelMarketDataUniverseAssets().map(asset => asset.paperSymbol)
}

export function buildPaperUniverseAsset(base: string, timeframe: PaperUniverseTimeframe = '1h'): PaperUniverseAsset {
  const normalizedBase = base.trim().toUpperCase()
  const paperSymbol = `${normalizedBase}-USDT`
  const storageSymbol = `${normalizedBase}_USDT_USDT`
  return {
    base: normalizedBase,
    paperSymbol,
    okxInstId: `${normalizedBase}-USDT-SWAP`,
    binanceSymbol: `${normalizedBase}USDT`,
    storageSymbol,
    file: paperStorageFile(normalizedBase, timeframe),
  }
}

export function paperStorageFile(base: string, timeframe: PaperUniverseTimeframe = '1h'): string {
  const normalizedBase = base.trim().toUpperCase()
  const storageSymbol = `${normalizedBase}_USDT_USDT`
  return `${storageSymbol}_${timeframe}.csv`
}

export function paperSymbolToCsvFile(symbol: string, timeframe: PaperUniverseTimeframe = '1h'): string {
  return buildPaperUniverseAsset(symbol.replace(/[-_/].*$/, ''), timeframe).file
}

function resolveUniverseBases(
  envKey: string,
  fallback: readonly string[],
  fullUniverse: readonly string[],
): string[] {
  const raw = process.env[envKey]?.trim()
  if (!raw) return [...fallback]
  if (raw.toLowerCase() === 'default') return [...fallback]
  if (raw.toLowerCase() === 'full') return [...fullUniverse]

  const parsed = raw
    .split(/[,\s]+/)
    .map(normalizeUniverseBase)
    .filter((base): base is string => base != null)
  return parsed.length > 0 ? [...new Set(parsed)] : [...fallback]
}

function normalizeUniverseBase(raw: string): string | null {
  let normalized = raw.trim().toUpperCase()
  if (!normalized) return null
  normalized = normalized
    .replace(/-USDT-SWAP$/, '')
    .replace(/[-_/]USDT[-_/]USDT$/, '')
    .replace(/[-_/]USDT$/, '')
    .replace(/USDT$/, '')
  return /^[A-Z0-9]+$/.test(normalized) ? normalized : null
}
