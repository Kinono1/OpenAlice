import { describe, expect, it } from 'vitest'
import { parseArgs, sanitize } from './export_ccxt_derivatives_history.js'

describe('export_ccxt_derivatives_history', () => {
  it('defaults to dry-run public derivatives export planning', () => {
    expect(parseArgs([])).toMatchObject({
      exchange: 'binance',
      symbol: 'ETH/USDT:USDT',
      kind: 'both',
      timeframe: '1h',
      limit: 200,
      outputDir: 'data/research/derivatives_history',
      dryRun: true,
    })
  })

  it('requires explicit dryRun false before network export writes files', () => {
    expect(parseArgs(['--dryRun', 'false', '--kind', 'funding', '--limit', '17'])).toMatchObject({
      dryRun: false,
      kind: 'funding',
      limit: 17,
    })
  })

  it('sanitizes exchange symbols for output filenames', () => {
    expect(sanitize('ETH/USDT:USDT')).toBe('ETH_USDT_USDT')
  })
})
