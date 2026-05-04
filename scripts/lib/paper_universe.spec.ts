import { describe, expect, it } from 'vitest'
import {
  buildPaperUniverseAsset,
  defaultPaperUniverseAssets,
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
})
