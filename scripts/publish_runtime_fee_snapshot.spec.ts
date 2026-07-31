import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ccxt from 'ccxt'
import {
  buildRuntimeFeeSnapshotReport,
  createCcxtExchange,
  fetchRuntimeFeeRowsFromExchange,
  fetchRuntimeFeeRowsWithRuntimeFallback,
  loadMarketsWithRuntimeFallback,
  okxProductionHostCandidates,
  parseRuntimeFeeSnapshotArgs,
  runRuntimeFeeSnapshotPublish,
  type RuntimeFeeFetcher,
} from './publish_runtime_fee_snapshot.js'

describe('publish_runtime_fee_snapshot', () => {
  it('parses fail-closed runtime fee defaults', () => {
    expect(parseRuntimeFeeSnapshotArgs([
      '--exchange',
      'binance',
      '--symbols',
      'BTC/USDT:USDT,ETH/USDT:USDT',
      '--output',
      'null',
      '--statusPath',
      'null',
      '--proxyUrl',
      'http://127.0.0.1:7890',
      '--json',
      'true',
      '--dryRun',
      'true',
      '--sandbox',
      'true',
      '--demoTrading',
      'true',
    ])).toMatchObject({
      exchange: 'binance',
      marketType: 'swap',
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      symbolScope: 'cross_sectional_universe',
      outputPath: null,
      statusPath: null,
      proxyUrl: 'http://127.0.0.1:7890',
      sandbox: true,
      demoTrading: true,
      okxHosts: [],
      dryRun: true,
      json: true,
    })
  })

  it('builds a runtime-verified snapshot using the max fee across requested symbols', () => {
    const args = parseRuntimeFeeSnapshotArgs([
      '--exchange',
      'okx',
      '--symbols',
      'BTC/USDT:USDT,ETH/USDT:USDT',
      '--output',
      'null',
      '--statusPath',
      'null',
    ])
    const report = buildRuntimeFeeSnapshotReport({
      args,
      generatedAt: '2026-05-04T12:00:00.000Z',
      rows: [
        {
          symbol: 'BTC/USDT:USDT',
          makerFeeBps: 1,
          takerFeeBps: 4,
          sourceFetchedAt: '2026-05-04T12:00:00.000Z',
          rawSource: 'fetchTradingFee',
        },
        {
          symbol: 'ETH/USDT:USDT',
          makerFeeBps: 1.5,
          takerFeeBps: 5,
          sourceFetchedAt: '2026-05-04T12:00:00.000Z',
          rawSource: 'fetchTradingFee',
        },
      ],
    })

    expect(report).toMatchObject({
      status: 'runtime_verified',
      promotionAllowedByThisArtifact: false,
      paperTradingAllowedByThisArtifact: false,
      liveTradingAllowedByThisArtifact: false,
      sandbox: false,
      demoTrading: false,
      feeSnapshot: {
        venue: 'okx',
        symbol: 'cross_sectional_universe',
        source: 'api',
        verifiedByRuntime: true,
        makerFeeBps: 1.5,
        takerFeeBps: 5,
        sourceFetchedAt: '2026-05-04T12:00:00.000Z',
        expiresAt: '2026-05-05T12:00:00.000Z',
      },
      blockers: [],
    })
  })

  it('fails closed when any requested symbol is missing a usable fee row', () => {
    const args = parseRuntimeFeeSnapshotArgs([
      '--exchange',
      'okx',
      '--symbols',
      'BTC/USDT:USDT,ETH/USDT:USDT',
      '--output',
      'null',
      '--statusPath',
      'null',
    ])
    const report = buildRuntimeFeeSnapshotReport({
      args,
      generatedAt: '2026-05-04T12:00:00.000Z',
      rows: [
        {
          symbol: 'BTC/USDT:USDT',
          makerFeeBps: 1,
          takerFeeBps: 4,
          sourceFetchedAt: '2026-05-04T12:00:00.000Z',
          rawSource: 'fetchTradingFee',
        },
      ],
    })

    expect(report.status).toBe('blocked')
    expect(report.feeSnapshot).toBeNull()
    expect(report.blockers).toContain('fee_snapshot_missing_symbol_rows:ETH/USDT:USDT')
  })

  it('keeps invalid exchange credentials blocked without writing a verified snapshot', async () => {
    const args = parseRuntimeFeeSnapshotArgs([
      '--exchange',
      'binance',
      '--symbols',
      'BTC/USDT:USDT',
      '--output',
      'null',
      '--statusPath',
      'null',
    ])
    const fetcher: RuntimeFeeFetcher = async () => ({
      rows: [],
      errors: [{
        symbol: 'BTC/USDT:USDT',
        errorClass: 'auth',
        message: 'binance {"code":-2014,"msg":"API-key format invalid."}',
      }],
      blockers: ['fee_snapshot_fetch_failed:auth'],
    })

    const report = await runRuntimeFeeSnapshotPublish(args, fetcher)

    expect(report.status).toBe('blocked')
    expect(report.feeSnapshot).toBeNull()
    expect(report.snapshotWritten).toBe(false)
    expect(report.blockers).toEqual(expect.arrayContaining([
      'fee_snapshot_fetch_failed:auth',
      'fee_snapshot_missing_symbol_rows:BTC/USDT:USDT',
    ]))
  })

  it('refuses to read a group/other-accessible env file for private fee credentials', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oa-fee-env-perms-'))
    const envPath = join(tempDir, '.env')
    await writeFile(envPath, [
      'EXCHANGE_API_KEY=abc123456789abc123456789SECRETKEY',
      'EXCHANGE_API_SECRET=secret123456789secret123456789SECRET',
      'EXCHANGE_PASSWORD=passphrase123456789passphrase',
    ].join('\n'), 'utf-8')
    await chmod(envPath, 0o644)
    const args = parseRuntimeFeeSnapshotArgs([
      '--exchange',
      'okx',
      '--symbols',
      'BTC/USDT:USDT',
      '--envPath',
      envPath,
      '--output',
      'null',
      '--statusPath',
      'null',
    ])

    const report = await runRuntimeFeeSnapshotPublish(args)

    expect(report.status).toBe('blocked')
    expect(report.perSymbolFees).toEqual([])
    expect(report.errors[0]).toMatchObject({
      symbol: '*',
      errorClass: 'env_file_permission',
    })
    expect(report.errors[0]?.message).toContain('must not be group/other-accessible')
    expect(report.blockers).toContain('fee_snapshot_fetch_failed:env_file_permission')
    expect(JSON.stringify(report)).not.toContain('abc123456789abc123456789SECRETKEY')
  })

  it('normalizes ccxt fetchTradingFees and falls back to per-symbol fetchTradingFee', async () => {
    const exchange = {
      async loadMarkets() {},
      async fetchTradingFees() {
        return {
          'BTC/USDT:USDT': { maker: 0.0001, taker: 0.0004 },
        }
      },
      async fetchTradingFee(symbol: string) {
        if (symbol === 'ETH/USDT:USDT') return { maker: 0.00015, taker: 0.0005 }
        throw new Error(`unexpected symbol ${symbol}`)
      },
    }

    const result = await fetchRuntimeFeeRowsFromExchange(exchange, ['BTC/USDT:USDT', 'ETH/USDT:USDT'])

    expect(result.blockers).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.rows).toEqual([
      expect.objectContaining({ symbol: 'BTC/USDT:USDT', makerFeeBps: 1, takerFeeBps: 4 }),
      expect.objectContaining({ symbol: 'ETH/USDT:USDT', makerFeeBps: 1.5, takerFeeBps: 5 }),
    ])
  })

  it('does not block when per-symbol fallback covers every requested fee row', async () => {
    const exchange = {
      async loadMarkets() {},
      async fetchTradingFees() {
        throw new Error('okx fetchTradingFees() is not supported yet')
      },
      async fetchTradingFee(symbol: string) {
        return symbol === 'BTC/USDT:USDT'
          ? { maker: 0.0002, taker: 0.0005 }
          : { maker: 0.00015, taker: 0.00045 }
      },
    }

    const result = await fetchRuntimeFeeRowsFromExchange(exchange, ['BTC/USDT:USDT', 'ETH/USDT:USDT'])

    expect(result.errors).toEqual([
      expect.objectContaining({
        symbol: '*',
        errorClass: 'api_not_supported',
      }),
    ])
    expect(result.blockers).toEqual([])
    expect(result.rows).toEqual([
      expect.objectContaining({ symbol: 'BTC/USDT:USDT', makerFeeBps: 2, takerFeeBps: 5 }),
      expect.objectContaining({ symbol: 'ETH/USDT:USDT', makerFeeBps: 1.5, takerFeeBps: 4.5 }),
    ])
  })

  it('promotes per-symbol fee fetch failures into blockers', async () => {
    const exchange = {
      async loadMarkets() {},
      async fetchTradingFees() {
        throw new Error('okx fetchTradingFees() is not supported yet')
      },
      async fetchTradingFee() {
        throw new Error("okx {\"msg\":\"API key:abc123456789abc123456789SECRET doesn't exist\",\"code\":\"50119\"}")
      },
    }

    const result = await fetchRuntimeFeeRowsFromExchange(exchange, ['BTC/USDT:USDT'])

    expect(result.rows).toEqual([])
    expect(result.errors.map(error => error.errorClass)).toEqual(['api_not_supported', 'auth'])
    expect(result.errors[1]?.message).toContain('API key:[redacted]')
    expect(result.errors[1]?.message).not.toContain('abc123456789abc123456789SECRET')
    expect(result.blockers).toEqual(expect.arrayContaining([
      'fee_snapshot_no_valid_fee_rows',
      'fee_snapshot_fetch_failed:api_not_supported',
      'fee_snapshot_fetch_failed:auth',
    ]))
  })

  it('uses OKX host fallback when loading fee markets', async () => {
    const calls: Array<{ host: string | undefined; reload: boolean | undefined }> = []
    const exchange = {
      hostname: 'www.okx.com',
      async loadMarkets(reload?: boolean) {
        calls.push({ host: this.hostname, reload })
        if (this.hostname === 'www.okx.com') throw new Error('timeout')
        return {}
      },
    }
    const args = parseRuntimeFeeSnapshotArgs(['--exchange', 'okx'])

    await expect(loadMarketsWithRuntimeFallback(exchange, args)).resolves.toBe('aws.okx.com')
    expect(calls).toEqual([
      { host: 'www.okx.com', reload: true },
      { host: 'aws.okx.com', reload: true },
    ])
  })

  it('keeps custom OKX host order while appending known region hosts', () => {
    const args = parseRuntimeFeeSnapshotArgs([
      '--exchange',
      'okx',
      '--okxHosts',
      'https://us.okx.com, www.okx.com custom.okx.test',
    ])

    expect(okxProductionHostCandidates({ hostname: 'www.okx.com' }, args)).toEqual([
      'us.okx.com',
      'www.okx.com',
      'custom.okx.test',
      'aws.okx.com',
      'eea.okx.com',
    ])
  })

  it('retries OKX private fee calls across region hosts after 50119', async () => {
    const calls: Array<{ host: string | undefined; symbol?: string }> = []
    const exchange = {
      hostname: 'www.okx.com',
      async loadMarkets(reload?: boolean) {
        calls.push({ host: this.hostname, symbol: reload ? 'loadMarkets' : 'loadMarketsCached' })
      },
      async fetchTradingFee(symbol: string) {
        calls.push({ host: this.hostname, symbol })
        if (this.hostname !== 'eea.okx.com') {
          throw new Error('okx {"msg":"API key:abc123456789abc123456789SECRET doesn\\\'t exist","code":"50119"}')
        }
        return { maker: 0.0001, taker: 0.0004 }
      },
    }
    const args = parseRuntimeFeeSnapshotArgs([
      '--exchange',
      'okx',
      '--symbols',
      'BTC/USDT:USDT',
    ])

    const result = await fetchRuntimeFeeRowsWithRuntimeFallback(exchange, args)

    expect(result.rows).toEqual([
      expect.objectContaining({ symbol: 'BTC/USDT:USDT', makerFeeBps: 1, takerFeeBps: 4 }),
    ])
    expect(result.blockers).toEqual([])
    expect(calls).toEqual([
      { host: 'www.okx.com', symbol: 'loadMarkets' },
      { host: 'www.okx.com', symbol: 'BTC/USDT:USDT' },
      { host: 'aws.okx.com', symbol: 'loadMarkets' },
      { host: 'aws.okx.com', symbol: 'BTC/USDT:USDT' },
      { host: 'eea.okx.com', symbol: 'loadMarkets' },
      { host: 'eea.okx.com', symbol: 'BTC/USDT:USDT' },
    ])
  })

  it('does not override OKX hosts when sandbox or demo mode owns the ccxt URLs', async () => {
    const calls: Array<{ host: string | undefined; reload: boolean | undefined }> = []
    const exchange = {
      hostname: 'www.okx.com',
      async loadMarkets(reload?: boolean) {
        calls.push({ host: this.hostname, reload })
        return {}
      },
    }
    const args = parseRuntimeFeeSnapshotArgs(['--exchange', 'okx', '--demoTrading', 'true'])

    await expect(loadMarketsWithRuntimeFallback(exchange, args)).resolves.toBeNull()
    expect(calls).toEqual([{ host: 'www.okx.com', reload: true }])
  })

  it('maps OKX demoTrading to the simulated-trading sandbox header path before private fee calls', () => {
    const exchanges = ccxt as unknown as Record<string, unknown>
    const previousOkx = exchanges.okx
    const calls: Array<{ kind: string; value: boolean }> = []

    class FakeOkx {
      hostname = 'www.okx.com'
      options: Record<string, unknown>
      has: Record<string, unknown> = {}

      constructor(input: Record<string, unknown>) {
        this.options = input.options as Record<string, unknown>
      }

      setSandboxMode(enabled: boolean) {
        calls.push({ kind: 'sandbox', value: enabled })
      }

      enableDemoTrading(enabled: boolean) {
        calls.push({ kind: 'demoTrading', value: enabled })
      }

      async loadMarkets() {}
    }

    try {
      exchanges.okx = FakeOkx
      const args = parseRuntimeFeeSnapshotArgs([
        '--exchange',
        'okx',
        '--sandbox',
        'true',
        '--demoTrading',
        'true',
      ])

      const exchange = createCcxtExchange(args, {
        apiKey: 'key',
        secret: 'secret',
        password: 'pass',
      })

      expect(exchange.options).toMatchObject({
        defaultType: 'swap',
        fetchMarkets: { types: ['swap'] },
      })
      expect(calls).toEqual([
        { kind: 'sandbox', value: true },
      ])
    } finally {
      exchanges.okx = previousOkx
    }
  })

  it('uses generic enableDemoTrading for non-OKX exchanges', () => {
    const exchanges = ccxt as unknown as Record<string, unknown>
    const previousBybit = exchanges.bybit
    const calls: Array<{ kind: string; value: boolean }> = []

    class FakeBybit {
      hostname = 'api.bybit.com'
      options: Record<string, unknown>
      has: Record<string, unknown> = {}

      constructor(input: Record<string, unknown>) {
        this.options = input.options as Record<string, unknown>
      }

      setSandboxMode(enabled: boolean) {
        calls.push({ kind: 'sandbox', value: enabled })
      }

      enableDemoTrading(enabled: boolean) {
        calls.push({ kind: 'demoTrading', value: enabled })
      }

      async loadMarkets() {}
    }

    try {
      exchanges.bybit = FakeBybit
      const args = parseRuntimeFeeSnapshotArgs([
        '--exchange',
        'bybit',
        '--demoTrading',
        'true',
      ])

      createCcxtExchange(args, {
        apiKey: 'key',
        secret: 'secret',
        password: null,
      })

      expect(calls).toEqual([{ kind: 'demoTrading', value: true }])
    } finally {
      exchanges.bybit = previousBybit
    }
  })

  it('keeps OKX fee refresh scoped to swap markets instead of loading spot/future/option', async () => {
    const args = parseRuntimeFeeSnapshotArgs([
      '--exchange',
      'okx',
      '--marketType',
      'swap',
      '--symbols',
      'BTC/USDT:USDT',
      '--output',
      'null',
      '--statusPath',
      'null',
    ])
    const fetcher: RuntimeFeeFetcher = async (inputArgs) => {
      expect(inputArgs.marketType).toBe('swap')
      return {
        rows: [{
          symbol: 'BTC/USDT:USDT',
          makerFeeBps: 1,
          takerFeeBps: 4,
          sourceFetchedAt: '2026-05-04T12:00:00.000Z',
          rawSource: 'fetchTradingFee',
        }],
        errors: [],
        blockers: [],
      }
    }

    const report = await runRuntimeFeeSnapshotPublish(args, fetcher)

    expect(report.status).toBe('runtime_verified')
    expect(report.feeSnapshot).toMatchObject({
      instrumentType: 'crypto_perpetual',
      accountTier: 'runtime_api_max_fee:okx:swap:symbols=1',
    })
  })

  it('maps Binance perpetual fee refresh to ccxt linear markets through the runtime args path', async () => {
    const args = parseRuntimeFeeSnapshotArgs([
      '--exchange',
      'binance',
      '--marketType',
      'swap',
      '--symbols',
      'BTC/USDT:USDT',
      '--output',
      'null',
      '--statusPath',
      'null',
    ])
    const fetcher: RuntimeFeeFetcher = async (inputArgs) => {
      expect(inputArgs.exchange).toBe('binance')
      expect(inputArgs.marketType).toBe('swap')
      return {
        rows: [{
          symbol: 'BTC/USDT:USDT',
          makerFeeBps: 2,
          takerFeeBps: 6,
          sourceFetchedAt: '2026-05-04T12:00:00.000Z',
          rawSource: 'fetchTradingFee',
        }],
        errors: [],
        blockers: [],
      }
    }

    const report = await runRuntimeFeeSnapshotPublish(args, fetcher)

    expect(report.status).toBe('runtime_verified')
    expect(report.feeSnapshot).toMatchObject({
      venue: 'binance',
      accountTier: 'runtime_api_max_fee:binance:swap:symbols=1',
    })
  })

  it('writes a verified snapshot and separate refresh status artifact without enabling execution', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oa-fee-snapshot-'))
    const outputPath = join(tempDir, 'fee_snapshot.latest.json')
    const statusPath = join(tempDir, 'fee_snapshot_refresh.latest.json')
    const args = parseRuntimeFeeSnapshotArgs([
      '--exchange',
      'binance',
      '--symbols',
      'BTC/USDT:USDT',
      '--output',
      outputPath,
      '--statusPath',
      statusPath,
    ])
    const fetcher: RuntimeFeeFetcher = async () => ({
      rows: [{
        symbol: 'BTC/USDT:USDT',
        makerFeeBps: 2,
        takerFeeBps: 6,
        sourceFetchedAt: '2026-05-04T12:00:00.000Z',
        rawSource: 'fetchTradingFee',
      }],
      errors: [],
      blockers: [],
    })

    const report = await runRuntimeFeeSnapshotPublish(args, fetcher)
    const snapshot = JSON.parse(await readFile(outputPath, 'utf-8'))
    const status = JSON.parse(await readFile(statusPath, 'utf-8'))
    const snapshotManifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    const statusManifest = JSON.parse(await readFile(`${statusPath}.manifest.json`, 'utf-8'))

    expect(report.status).toBe('runtime_verified')
    expect(report.snapshotWritten).toBe(true)
    expect(report.statusWritten).toBe(true)
    expect(snapshot).toMatchObject({
      venue: 'binance',
      source: 'api',
      verifiedByRuntime: true,
      makerFeeBps: 2,
      takerFeeBps: 6,
    })
    expect(snapshot.promotionAllowedByThisArtifact).toBeUndefined()
    expect(status).toMatchObject({
      status: 'runtime_verified',
      snapshotWritten: true,
      statusWritten: true,
      paperTradingAllowedByThisArtifact: false,
      liveTradingAllowedByThisArtifact: false,
    })
    expect(snapshotManifest.artifactHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/))
    expect(statusManifest.artifactHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/))
  })
})
