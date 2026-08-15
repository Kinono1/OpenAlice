import { describe, expect, it } from 'vitest'
import {
  buildPaperUniverseAsset,
  defaultMarketDataUniverseAssets,
  defaultMarketDataUniverseSymbols,
  defaultPaperUniverseAssets,
  defaultSecondLevelMarketDataUniverseAssets,
  defaultSecondLevelMarketDataUniverseSymbols,
  defaultSecondLevelUniverseAssets,
  defaultSecondLevelUniverseSymbols,
  defaultPaperUniverseSymbols,
  paperStorageFile,
  paperSymbolToCsvFile,
} from './paper_universe.js'

describe('paper_universe', () => {
  it('defines a paper-only OKX USDT swap universe large enough for cross-sectional tests', () => {
    const assets = defaultPaperUniverseAssets()

    expect(assets.length).toBeGreaterThanOrEqual(20)
    expect(assets.length).toBeLessThanOrEqual(50)
    expect(defaultPaperUniverseSymbols().slice(0, 6)).toEqual([
      'BTC-USDT',
      'ETH-USDT',
      'SOL-USDT',
      'BNB-USDT',
      'XRP-USDT',
      'DOGE-USDT',
    ])
    expect(defaultPaperUniverseSymbols()).toContain('WIF-USDT')
    expect(defaultPaperUniverseSymbols()).not.toContain('MATIC-USDT')
    expect(assets.every(asset => asset.file.endsWith('_1h.csv'))).toBe(true)
    expect(assets.map(asset => asset.file)).not.toContain('BTC_USDT_USDT_0.csv')
  })

  it('uses one canonical mapping for exchange ids and local csv files', () => {
    expect(buildPaperUniverseAsset('btc')).toEqual({
      base: 'BTC',
      paperSymbol: 'BTC-USDT',
      okxInstId: 'BTC-USDT-SWAP',
      binanceSymbol: 'BTCUSDT',
      storageSymbol: 'BTC_USDT_USDT',
      file: 'BTC_USDT_USDT_1h.csv',
    })
    expect(paperSymbolToCsvFile('BTC-USDT')).toBe('BTC_USDT_USDT_1h.csv')
    expect(paperSymbolToCsvFile('BTC-USDT', '5m')).toBe('BTC_USDT_USDT_5m.csv')
    expect(paperSymbolToCsvFile('BTC-USDT', '1s')).toBe('BTC_USDT_USDT_1s.csv')
    expect(paperStorageFile('eth', '1s')).toBe('ETH_USDT_USDT_1s.csv')
  })

  it('defines a bounded second-level subset for high-leverage diagnostics', () => {
    const secondLevelAssets = defaultSecondLevelUniverseAssets()

    expect(secondLevelAssets.length).toBeGreaterThanOrEqual(6)
    expect(secondLevelAssets.length).toBeLessThanOrEqual(12)
    expect(defaultSecondLevelUniverseSymbols()).toEqual([
      'BTC-USDT',
      'ETH-USDT',
      'SOL-USDT',
      'BNB-USDT',
      'XRP-USDT',
      'DOGE-USDT',
      'ADA-USDT',
      'LINK-USDT',
      'AVAX-USDT',
      'LTC-USDT',
    ])
    expect(secondLevelAssets[0]).toMatchObject({
      base: 'BTC',
      okxInstId: 'BTC-USDT-SWAP',
      file: 'BTC_USDT_USDT_1s.csv',
    })
  })

  it('defaults cron market data collection to a liquid main-coin subset', () => {
    expect(defaultMarketDataUniverseSymbols()).toEqual([
      'BTC-USDT',
      'ETH-USDT',
      'SOL-USDT',
      'BNB-USDT',
      'XRP-USDT',
    ])
    expect(defaultMarketDataUniverseAssets('5m').map(asset => asset.file)).toEqual([
      'BTC_USDT_USDT_5m.csv',
      'ETH_USDT_USDT_5m.csv',
      'SOL_USDT_USDT_5m.csv',
      'BNB_USDT_USDT_5m.csv',
      'XRP_USDT_USDT_5m.csv',
    ])
    expect(defaultSecondLevelMarketDataUniverseSymbols()).toEqual([
      'BTC-USDT',
      'ETH-USDT',
      'SOL-USDT',
    ])
    expect(defaultSecondLevelMarketDataUniverseAssets()[0].file).toBe('BTC_USDT_USDT_1s.csv')
  })

  it('allows explicit runtime market data universe overrides without changing research defaults', () => {
    const originalBases = process.env.OPENALICE_MARKET_DATA_BASES
    const originalSecondLevelBases = process.env.OPENALICE_MARKET_DATA_1S_BASES
    try {
      process.env.OPENALICE_MARKET_DATA_BASES = 'btc-usdt, ethusdt SOL-USDT-SWAP'
      process.env.OPENALICE_MARKET_DATA_1S_BASES = 'eth, btc'

      expect(defaultMarketDataUniverseSymbols()).toEqual([
        'BTC-USDT',
        'ETH-USDT',
        'SOL-USDT',
      ])
      expect(defaultSecondLevelMarketDataUniverseSymbols()).toEqual([
        'ETH-USDT',
        'BTC-USDT',
      ])
      expect(defaultPaperUniverseSymbols()).toContain('WIF-USDT')
      expect(defaultSecondLevelUniverseSymbols()).toContain('LTC-USDT')
    } finally {
      restoreEnv('OPENALICE_MARKET_DATA_BASES', originalBases)
      restoreEnv('OPENALICE_MARKET_DATA_1S_BASES', originalSecondLevelBases)
    }
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
