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

export function defaultPaperUniverseAssets(): PaperUniverseAsset[] {
  return DEFAULT_BASES.map(base => buildPaperUniverseAsset(base))
}

export function defaultSecondLevelUniverseAssets(): PaperUniverseAsset[] {
  return SECOND_LEVEL_BASES.map(base => buildPaperUniverseAsset(base, '1s'))
}

export function defaultPaperUniverseSymbols(): string[] {
  return defaultPaperUniverseAssets().map(asset => asset.paperSymbol)
}

export function defaultSecondLevelUniverseSymbols(): string[] {
  return defaultSecondLevelUniverseAssets().map(asset => asset.paperSymbol)
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
