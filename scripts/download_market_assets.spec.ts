import { describe, expect, it } from 'vitest'
import {
  buildDownloadLiveAssetsPlan,
  parseDownloadLiveAssetsArgs,
} from './download_live_assets.js'
import {
  buildDownloadMultiAssetsPlan,
  parseDownloadMultiAssetsArgs,
} from './download_multi_assets.js'

describe('download market asset scripts', () => {
  it('defaults deep live asset downloader to dry-run mode', () => {
    const args = parseDownloadLiveAssetsArgs([])
    const plan = buildDownloadLiveAssetsPlan(args)

    expect(args.dryRun).toBe(true)
    expect(plan.mode).toBe('dry_run')
    expect(plan.assets.length).toBeGreaterThan(0)
  })

  it('requires an explicit flag before multi-asset downloader writes files', () => {
    expect(parseDownloadMultiAssetsArgs([])).toMatchObject({
      dryRun: true,
    })
    expect(parseDownloadMultiAssetsArgs(['--dryRun', 'false', '--outDir', '/tmp/assets'])).toMatchObject({
      dryRun: false,
      outDir: '/tmp/assets',
    })
  })

  it('emits a deterministic public market data download plan', () => {
    const plan = buildDownloadMultiAssetsPlan(parseDownloadMultiAssetsArgs(['--outDir', '/tmp/assets']))

    expect(plan).toMatchObject({
      mode: 'dry_run',
      outDir: '/tmp/assets',
      exchange: 'binance_futures',
      timeframe: '1h',
      limit: 1000,
    })
    expect(plan.symbols).toContain('SOL/USDT:USDT')
  })
})
