import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STALE_REPORT_MS,
  buildExternalDerivativesDedupKey,
  collectExternalDerivativesData,
  parseExternalDerivativesCollectArgs,
  type FetchLike,
} from './collect_external_derivatives_data.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'external-derivatives-'))
}

function fakeFetch(payloadByUrl: Map<string, unknown>): FetchLike {
  return async (url: string) => {
    const payload = payloadByUrl.get(url)
    if (payload === undefined) {
      return {
        ok: false,
        status: 404,
        text: async () => 'missing fixture',
      }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    }
  }
}

function fakeTextFetch(bodyByUrl: Map<string, string>): FetchLike {
  return async (url: string) => {
    const body = bodyByUrl.get(url)
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        text: async () => 'missing fixture',
      }
    }
    return {
      ok: true,
      status: 200,
      text: async () => body,
    }
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('collect_external_derivatives_data', () => {
  it('parses CLI args and expands all endpoints', () => {
    expect(parseExternalDerivativesCollectArgs([
      '--symbols',
      'ethusdt,btcusdt',
      '--endpoint',
      'all',
      '--period',
      '15m',
      '--fetchTimeoutMs',
      '12000',
      '--maxRetries',
      '1',
      '--dryRun',
      'true',
    ])).toMatchObject({
      symbols: ['ETHUSDT', 'BTCUSDT'],
      endpoints: ['fundingRate', 'premiumIndex', 'openInterest', 'openInterestHist', 'longShort'],
      period: '15m',
      baseUrl: 'https://fapi.binance.com',
      runLedgerPath: 'data/runtime/external_derivatives_data_collect.runs.jsonl',
      collectorLockStaleMs: 6 * 60 * 60 * 1000,
      staleReportMs: 10 * 60 * 60 * 1000,
      fetchTimeoutMs: 12_000,
      maxRetries: 1,
      dryRun: true,
    })
  })

  it('uses a 10h default stale report window for the 8h collector cadence', () => {
    expect(DEFAULT_STALE_REPORT_MS).toBe(10 * 60 * 60 * 1000)
    expect(parseExternalDerivativesCollectArgs([
      '--symbols',
      'ethusdt',
      '--endpoint',
      'fundingRate',
      '--dryRun',
      'true',
    ])).toMatchObject({
      staleReportMs: 10 * 60 * 60 * 1000,
    })
  })

  it('parses collector lock stale TTL from CLI', () => {
    expect(parseExternalDerivativesCollectArgs([
      '--symbols',
      'ethusdt',
      '--endpoint',
      'fundingRate',
      '--collectorLockStaleMs',
      '7200000',
      '--dryRun',
      'true',
    ])).toMatchObject({
      collectorLockStaleMs: 7_200_000,
    })
  })

  it('parses base URL and proxy overrides for locked-down network environments', () => {
    expect(parseExternalDerivativesCollectArgs([
      '--symbols',
      'ethusdt',
      '--endpoint',
      'fundingRate',
      '--baseUrl',
      'https://binance-proxy.internal/',
      '--proxyUrl',
      'http://127.0.0.1:7892',
      '--fetchTimeoutMs',
      '8000',
      '--maxRetries',
      '0',
      '--dryRun',
      'true',
    ])).toMatchObject({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      baseUrl: 'https://binance-proxy.internal',
      proxyUrl: 'http://127.0.0.1:7892',
      proxySource: 'cli',
      fetchTimeoutMs: 8_000,
      maxRetries: 0,
      dryRun: true,
    })
  })

  it('builds endpoint-specific dedup keys including OI history period', () => {
    expect(buildExternalDerivativesDedupKey({
      endpoint: 'fundingRate',
      symbol: 'ETHUSDT',
      sourceTimestampMs: 1,
    })).toBe('binance|usdm|fundingRate|ETHUSDT|1')
    expect(buildExternalDerivativesDedupKey({
      endpoint: 'premiumIndex',
      symbol: 'ETHUSDT',
      sourceTimestampMs: 1,
    })).toBe('binance|usdm|premiumIndex|ETHUSDT|1')
    expect(buildExternalDerivativesDedupKey({
      endpoint: 'premiumIndex',
      symbol: 'ETHUSDT',
      sourceTimestampMs: 1,
      fetchBucketMs: 300_000,
    })).toBe('binance|usdm|premiumIndex|ETHUSDT|300000')
    expect(buildExternalDerivativesDedupKey({
      endpoint: 'openInterestHist',
      symbol: 'ETHUSDT',
      period: '5m',
      sourceTimestampMs: 1,
    })).toBe('binance|usdm|openInterestHist|ETHUSDT|5m|1')
    expect(buildExternalDerivativesDedupKey({
      endpoint: 'openInterestHist',
      symbol: 'ETHUSDT',
      period: '15m',
      sourceTimestampMs: 1,
    })).toBe('binance|usdm|openInterestHist|ETHUSDT|15m|1')
    expect(buildExternalDerivativesDedupKey({
      endpoint: 'longShort',
      symbol: 'ETHUSDT',
      period: '5m',
      sourceTimestampMs: 1,
    })).toBe('binance|usdm|globalLongShortAccountRatio|ETHUSDT|5m|1')
  })

  it('appends rows once and skips duplicate dedup keys on repeated runs', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const fixtures = new Map<string, unknown>([
      ['https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3', [{
        symbol: 'ETHUSDT',
        fundingTime: 1_800_000_000_000,
        fundingRate: '0.0001',
        markPrice: '3200',
      }]],
      ['https://fapi.binance.com/fapi/v1/openInterest?symbol=ETHUSDT', {
        symbol: 'ETHUSDT',
        openInterest: '123.45',
        time: 1_800_000_000_001,
      }],
    ])

    const args = {
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate', 'openInterest'] as const,
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }
    const first = await collectExternalDerivativesData(args, fakeFetch(fixtures))
    const second = await collectExternalDerivativesData(args, fakeFetch(fixtures))

    expect(first).toMatchObject({
      runId: expect.stringMatching(/^external_derivatives_data_collect_/),
      sideEffectPolicy: 'read_only_external_fetch_append_only_local_storage',
      collectorLockStatus: 'acquired',
      reportPath: join(root, 'external_derivatives_data_collect.latest.json'),
      baseUrl: 'https://fapi.binance.com',
      proxyConfigured: false,
      fetchTimeoutMs: 1_000,
      maxRetries: 1,
      fetchedRows: 2,
      appendedRows: 2,
      skippedDuplicateRows: 0,
      previousReportAgeMs: null,
      previousReportStale: false,
      previousReportRunId: null,
      errorSummary: {},
      errors: [],
    })
    expect(first.endpointDiagnostics).toHaveLength(2)
    expect(first.endpointDiagnostics[0]).toMatchObject({
      symbol: 'ETHUSDT',
      endpoint: 'fundingRate',
      sourceEndpoint: '/fapi/v1/fundingRate',
      attempts: 1,
      status: 'ok',
      fetchedRows: 1,
      error: null,
      url: 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3',
    })
    expect(first.evidenceManifest).toMatchObject({
      manifestPath: join(root, 'external_derivatives_data_collect.latest.json.manifest.json'),
      evidenceTrust: expect.stringMatching(/^(pass|quarantine)$/),
      dqStatus: expect.stringMatching(/^(pass|quarantine)$/),
      businessStatus: 'pass',
      exitCode: 0,
      artifactHashBasis: 'manifest_sidecar_hashes_report',
      artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      git: expect.objectContaining({
        dirty: expect.any(Boolean),
        dirtyFilesCount: expect.any(Number),
      }),
    })
    expect(second).toMatchObject({
      fetchedRows: 2,
      appendedRows: 0,
      skippedDuplicateRows: 2,
      previousReportAgeMs: expect.any(Number),
      previousReportStale: false,
      previousReportRunId: first.runId,
      errors: [],
    })

    const rows = (await readFile(outputPath, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      schemaVersion: 'external_derivatives_event.v1',
      exchange: 'binance',
      market: 'usdm',
      symbol: 'ETHUSDT',
      sourceEndpoint: '/fapi/v1/fundingRate',
      sourceTimestamp: '2027-01-15T08:00:00.000Z',
      dedupKey: 'binance|usdm|fundingRate|ETHUSDT|1800000000000',
    })
    expect(rows[0].fetchTimestamp).toMatch(/Z$/)
    expect(rows[0].ingestedAt).toMatch(/Z$/)
    expect(rows[0].sourceTimestampBasis).toBe('exchange_event')
    expect(rows[0].fetchLatencyMs).toEqual(expect.any(Number))
    expect(rows[0].decodeLatencyMs).toEqual(expect.any(Number))
    expect(rows[0].processingLatencyMs).toEqual(expect.any(Number))
    expect(rows[0].processingLatencyBasis).toBe('fetch_start_to_row_built')
    expect(rows[0].appendLatencyMs).toEqual(expect.any(Number))
    expect(rows[0].appendLatencyBasis).toBe('payload_received_to_jsonl_append')
    expect(rows[0].ingestionLatencyMs).toEqual(rows[0].appendLatencyMs)
    expect(rows[0].ingestionLatencyBasis).toBe('payload_received_to_jsonl_append')
    expect(rows[0].collectionRunId).toBe(first.runId)
    expect(rows[0].reportPath).toBe(join(root, 'external_derivatives_data_collect.latest.json'))
    expect(rows[0].manifestPath).toBe(join(root, 'external_derivatives_data_collect.latest.json.manifest.json'))
    expect(rows[0].evidenceTrust).toMatch(/^(pass|quarantine)$/)
    expect(rows[0].dqStatus).toMatch(/^(pass|quarantine)$/)
    expect(rows[0].businessStatus).toBe('pass')
    expect(rows[0].gitDirty).toEqual(expect.any(Boolean))
    expect(rows[0].gitDirtyFilesCount).toEqual(expect.any(Number))
    expect(rows[0].rawPayloadHash).toMatch(/^[a-f0-9]{64}$/)
    expect(rows[0].payloadHashBasis).toBe('canonical_json_payload')
    expect(rows[0].rawBodyHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('collects Binance premiumIndex mark-price snapshots for PIT-safe mark-match history', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const fixtures = new Map<string, unknown>([
      ['https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ETHUSDT', {
        symbol: 'ETHUSDT',
        markPrice: '3200.125',
        indexPrice: '3199.900',
        estimatedSettlePrice: '3201.000',
        lastFundingRate: '0.0001',
        interestRate: '0.0001',
        nextFundingTime: 1_800_028_800_000,
        time: 1_800_000_000_123,
      }],
    ])

    const first = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['premiumIndex'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }, fakeFetch(fixtures))
    const second = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['premiumIndex'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }, fakeFetch(fixtures))

    expect(first).toMatchObject({
      fetchedRows: 1,
      appendedRows: 1,
      errors: [],
    })
    expect(first.endpointDiagnostics[0]).toMatchObject({
      endpoint: 'premiumIndex',
      sourceEndpoint: '/fapi/v1/premiumIndex',
      url: 'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ETHUSDT',
      status: 'ok',
      fetchedRows: 1,
    })
    expect(second).toMatchObject({
      fetchedRows: 1,
      appendedRows: 0,
      skippedDuplicateRows: 1,
    })
    const [row] = (await readFile(outputPath, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(row).toMatchObject({
      schemaVersion: 'external_derivatives_event.v1',
      exchange: 'binance',
      market: 'usdm',
      symbol: 'ETHUSDT',
      sourceEndpoint: '/fapi/v1/premiumIndex',
      sourceTimestamp: '2027-01-15T08:00:00.123Z',
      sourceTimestampBasis: 'exchange_event',
      dedupKey: 'binance|usdm|premiumIndex|ETHUSDT|1800000000123',
      payload: {
        symbol: 'ETHUSDT',
        markPrice: '3200.125',
        indexPrice: '3199.900',
      },
    })
  })

  it('separates canonical payload hash from raw HTTP body hash', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const url = 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3'
    const compactBody = '[{"symbol":"ETHUSDT","fundingTime":1800000000000,"fundingRate":"0.0001","markPrice":"3200"}]'
    const prettyBody = `[
      {
        "markPrice": "3200",
        "fundingRate": "0.0001",
        "fundingTime": 1800000000000,
        "symbol": "ETHUSDT"
      }
    ]`

    const args = {
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'] as const,
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }

    await collectExternalDerivativesData(args, fakeTextFetch(new Map([[url, compactBody]])))
    const firstRows = (await readFile(outputPath, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))

    const second = await collectExternalDerivativesData(args, fakeTextFetch(new Map([[url, prettyBody]])))

    expect(firstRows[0]).toMatchObject({
      payloadHashBasis: 'canonical_json_payload',
      rawBodyHash: sha256Hex(compactBody),
    })
    expect(firstRows[0].rawPayloadHash).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toMatchObject({
      appendedRows: 0,
      skippedDuplicateRows: 1,
      conflictingDuplicateRows: 0,
    })
    expect(firstRows[0].rawBodyHash).not.toBe(sha256Hex(prettyBody))
  })

  it('uses an overridden Binance base URL when building endpoint URLs', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const fixtures = new Map<string, unknown>([
      ['https://binance-proxy.internal/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3', [{
        symbol: 'ETHUSDT',
        fundingTime: 1_800_000_000_000,
        fundingRate: '0.0001',
        markPrice: '3200',
      }]],
    ])

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      baseUrl: 'https://binance-proxy.internal/',
      fetchTimeoutMs: 1_000,
      maxRetries: 0,
      dryRun: true,
      json: true,
    }, fakeFetch(fixtures))

    expect(report).toMatchObject({
      baseUrl: 'https://binance-proxy.internal',
      runLedgerPath: null,
      fetchedRows: 1,
      wouldAppendRows: 1,
      errors: [],
    })
    expect(report.endpointDiagnostics[0]).toMatchObject({
      url: 'https://binance-proxy.internal/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3',
      attempts: 1,
      status: 'ok',
    })
  })

  it('accepts real Binance openInterest snapshots without exchange time by using a fetch bucket', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const fixtures = new Map<string, unknown>([
      ['https://fapi.binance.com/fapi/v1/openInterest?symbol=ETHUSDT', {
        symbol: 'ETHUSDT',
        openInterest: '123.45',
      }],
    ])

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['openInterest'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }, fakeFetch(fixtures))

    expect(report).toMatchObject({
      fetchedRows: 1,
      appendedRows: 1,
      persistedRows: 1,
      wouldAppendRows: 1,
      errors: [],
    })
    const [row] = (await readFile(outputPath, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(row).toMatchObject({
      sourceEndpoint: '/fapi/v1/openInterest',
      sourceTimestampBasis: 'fetch_bucket',
    })
    expect(row.sourceTimestamp).toMatch(/Z$/)
    expect(row.dedupKey).toMatch(/^binance\|usdm\|openInterest\|ETHUSDT\|\d+$/)
  })

  it('keeps dry-run local persistence at zero while reporting would-append rows', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const fixtures = new Map<string, unknown>([
      ['https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3', [{
        symbol: 'ETHUSDT',
        fundingTime: 1_800_000_000_000,
        fundingRate: '0.0001',
        markPrice: '3200',
      }]],
    ])

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      dryRun: true,
      json: true,
    }, fakeFetch(fixtures))

    expect(report).toMatchObject({
      fetchedRows: 1,
      appendedRows: 0,
      persistedRows: 0,
      wouldAppendRows: 1,
      skippedDuplicateRows: 0,
      conflictAuditPath: null,
    })
    expect(report.endpointDiagnostics[0]).toMatchObject({
      endpoint: 'fundingRate',
      attempts: 1,
      status: 'ok',
      fetchedRows: 1,
    })
    expect(await pathExists(outputPath)).toBe(false)
    expect(await pathExists(join(root, 'external_derivatives_data_collect.latest.json'))).toBe(false)
    expect(await pathExists(join(root, 'external_derivatives_data_collect.runs.jsonl'))).toBe(false)
  })

  it('writes latest reports beside non-default output paths instead of production runtime', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const fixtures = new Map<string, unknown>([
      ['https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3', [{
        symbol: 'ETHUSDT',
        fundingTime: 1_800_000_000_000,
        fundingRate: '0.0001',
        markPrice: '3200',
      }]],
    ])

    await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }, fakeFetch(fixtures))

    expect(await pathExists(join(root, 'external_derivatives_data_collect.latest.json'))).toBe(true)
    expect(await pathExists(join(root, 'external_derivatives_data_collect.runs.jsonl'))).toBe(true)
    const ledgerRows = (await readFile(join(root, 'external_derivatives_data_collect.runs.jsonl'), 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]).toMatchObject({
      schemaVersion: 'external_derivatives_data_collect_run.v1',
      outputPath,
      reportPath: join(root, 'external_derivatives_data_collect.latest.json'),
      dryRun: false,
      sideEffectPolicy: 'read_only_external_fetch_append_only_local_storage',
      fetchedRows: 1,
      appendedRows: 1,
      manifestPath: join(root, 'external_derivatives_data_collect.latest.json.manifest.json'),
      evidenceTrust: expect.stringMatching(/^(pass|quarantine)$/),
      dqStatus: expect.stringMatching(/^(pass|quarantine)$/),
      businessStatus: 'pass',
      artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      gitDirty: expect.any(Boolean),
      gitDirtyFilesCount: expect.any(Number),
      errorCount: 0,
      endpointDiagnostics: [expect.objectContaining({
        endpoint: 'fundingRate',
        sourceEndpoint: '/fapi/v1/fundingRate',
        url: 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3',
        attempts: 1,
        status: 'ok',
        processingLatencyBasis: 'fetch_start_to_row_built',
      })],
    })
    const latest = JSON.parse(await readFile(join(root, 'external_derivatives_data_collect.latest.json'), 'utf-8'))
    expect(latest.evidenceManifest).toMatchObject({
      manifestPath: join(root, 'external_derivatives_data_collect.latest.json.manifest.json'),
      evidenceTrust: ledgerRows[0].evidenceTrust,
      dqStatus: ledgerRows[0].dqStatus,
      businessStatus: 'pass',
      artifactHashBasis: 'hash_available_in_manifest_sidecar',
      artifactHash: null,
    })
    const latestRaw = await readFile(join(root, 'external_derivatives_data_collect.latest.json'), 'utf-8')
    const latestManifest = JSON.parse(await readFile(
      join(root, 'external_derivatives_data_collect.latest.json.manifest.json'),
      'utf-8',
    ))
    expect(ledgerRows[0].artifactHash).toMatch(/^[a-f0-9]{64}$/)
    expect(latestManifest.artifactHash).toBe(sha256Hex(latestRaw))
    expect(ledgerRows[0].artifactHash).toBe(latestManifest.artifactHash)
  })

  it('is statically read-only and contains no order execution verbs', async () => {
    const source = await readFile('scripts/collect_external_derivatives_data.ts', 'utf-8')
    expect(source).toContain('EXTERNAL_DERIVATIVES_COLLECTOR_SIDE_EFFECT_POLICY')
    expect(source).toContain('read_only_external_fetch_append_only_local_storage')
    expect(source).not.toMatch(/\b(placeOrder|createOrder|submitOrder|executeTrade|dispatchOrder|enableCryptoDispatcher)\b/)
  })

  it('tracks external fetch latency separately from decode latency', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const delayedFetch: FetchLike = async () => {
      await new Promise(resolve => setTimeout(resolve, 15))
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{
          symbol: 'ETHUSDT',
          fundingTime: 1_800_000_000_000,
          fundingRate: '0.0001',
          markPrice: '3200',
        }]),
      }
    }

    await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }, delayedFetch)

    const [row] = (await readFile(outputPath, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(row.fetchLatencyMs).toBeGreaterThanOrEqual(10)
    expect(row.processingLatencyMs).toEqual(expect.any(Number))
    expect(row.processingLatencyMs).toBeGreaterThanOrEqual(0)
    expect(row.processingLatencyBasis).toBe('fetch_start_to_row_built')
    expect(row.appendLatencyMs).toEqual(expect.any(Number))
    expect(row.appendLatencyMs).toBeGreaterThanOrEqual(0)
    expect(row.appendLatencyBasis).toBe('payload_received_to_jsonl_append')
    expect(row.ingestionLatencyMs).toEqual(row.appendLatencyMs)
    expect(row.ingestionLatencyBasis).toBe('payload_received_to_jsonl_append')
    expect(row.decodeLatencyMs).toEqual(expect.any(Number))
  })

  it('audits duplicate dedup keys when the incoming payload hash changes', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const url = 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3'
    const firstFixtures = new Map<string, unknown>([
      [url, [{
        symbol: 'ETHUSDT',
        fundingTime: 1_800_000_000_000,
        fundingRate: '0.0001',
        markPrice: '3200',
      }]],
    ])
    const changedFixtures = new Map<string, unknown>([
      [url, [{
        symbol: 'ETHUSDT',
        fundingTime: 1_800_000_000_000,
        fundingRate: '0.0002',
        markPrice: '3201',
      }]],
    ])

    const args = {
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'] as const,
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }
    await collectExternalDerivativesData(args, fakeFetch(firstFixtures))
    const second = await collectExternalDerivativesData(args, fakeFetch(changedFixtures))

    expect(second).toMatchObject({
      appendedRows: 0,
      skippedDuplicateRows: 1,
      conflictingDuplicateRows: 1,
    })
    expect(second.conflictAuditPath).toMatch(/external_derivatives_dedup_conflicts\.jsonl$/)
    const auditRows = (await readFile(second.conflictAuditPath!, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(auditRows.at(-1)).toMatchObject({
      schemaVersion: 'external_derivatives_dedup_conflict.v1',
      dedupKey: 'binance|usdm|fundingRate|ETHUSDT|1800000000000',
      action: 'skipped_incoming_row_preserved_existing_append_only_record',
    })
    expect(auditRows.at(-1).existingRawPayloadHash).not.toBe(auditRows.at(-1).incomingRawPayloadHash)
    expect(second.evidenceManifest).toMatchObject({
      businessStatus: 'warn',
      exitCode: 0,
    })
    const manifest = JSON.parse(await readFile(`${second.reportPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      businessStatus: 'warn',
      errorClass: 'dedup_key_payload_hash_conflict',
    })
  })

  it('reports endpoint fetch timeouts as errors instead of hanging the collector', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const hangingFetch: FetchLike = async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return {
        ok: true,
        status: 200,
        text: async () => '[]',
      }
    }

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 5,
      maxRetries: 0,
      dryRun: true,
      json: true,
    }, hangingFetch)

    expect(report).toMatchObject({
      fetchedRows: 0,
      appendedRows: 0,
      persistedRows: 0,
      wouldAppendRows: 0,
    })
    expect(report.errors).toEqual([
      {
        symbol: 'ETHUSDT',
        endpoint: 'fundingRate',
        error: 'fetch timeout after 5ms',
        errorClass: 'timeout',
      },
    ])
    expect(report.errorSummary).toEqual({ timeout: 1 })
    expect(report.endpointDiagnostics).toHaveLength(1)
    expect(report.endpointDiagnostics[0]).toMatchObject({
      symbol: 'ETHUSDT',
      endpoint: 'fundingRate',
      sourceEndpoint: '/fapi/v1/fundingRate',
      attempts: 1,
      status: 'error',
      fetchedRows: 0,
      error: 'fetch timeout after 5ms',
      errorClass: 'timeout',
      url: 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3',
    })
    expect(report.endpointDiagnostics[0].processingLatencyMs).toBeGreaterThanOrEqual(5)
    expect(report.endpointDiagnostics[0].processingLatencyBasis).toBe('fetch_start_to_row_built')
  })

  it('retries transient endpoint failures and reports final attempt count', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    let calls = 0
    const flakyFetch: FetchLike = async () => {
      calls += 1
      if (calls === 1) throw new Error('temporary network error')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{
          symbol: 'ETHUSDT',
          fundingTime: 1_800_000_000_000,
          fundingRate: '0.0001',
          markPrice: '3200',
        }]),
      }
    }

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      maxRetries: 1,
      dryRun: true,
      json: true,
    }, flakyFetch)

    expect(calls).toBe(2)
    expect(report.errors).toEqual([])
    expect(report.endpointDiagnostics[0]).toMatchObject({
      endpoint: 'fundingRate',
      attempts: 2,
      status: 'ok',
      fetchedRows: 1,
      attemptErrors: [{
        attempt: 1,
        error: 'temporary network error',
        errorClass: 'network_or_unknown',
      }],
    })
  })

  it('redacts credentials and token-like query parameters in attempt diagnostics', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const leakingFetch: FetchLike = async () => {
      throw new Error('proxy http://user:pass@127.0.0.1:7892 failed for https://example.test/path?apiKey=abc123&signature=deadbeef&symbol=ETHUSDT')
    }

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      maxRetries: 0,
      dryRun: true,
      json: true,
    }, leakingFetch)

    expect(report.errors[0].error).toContain('http://***:***@127.0.0.1:7892')
    expect(report.errors[0].error).toContain('apiKey=***')
    expect(report.errors[0].error).toContain('signature=***')
    expect(report.errors[0].error).not.toContain('user:pass')
    expect(report.errors[0].error).not.toContain('abc123')
    expect(report.errors[0].error).not.toContain('deadbeef')
    expect(report.endpointDiagnostics[0].attemptErrors).toEqual([{
      attempt: 1,
      error: report.errors[0].error,
      errorClass: 'proxy',
    }])
  })

  it('classifies HTTP failures for operator triage', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const httpFailure: FetchLike = async () => ({
      ok: false,
      status: 500,
      text: async () => 'upstream failure',
    })

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      maxRetries: 0,
      dryRun: true,
      json: true,
    }, httpFailure)

    expect(report.errors).toEqual([
      expect.objectContaining({
        symbol: 'ETHUSDT',
        endpoint: 'fundingRate',
        errorClass: 'http',
      }),
    ])
    expect(report.errorSummary).toEqual({ http: 1 })
    expect(report.endpointDiagnostics[0]).toMatchObject({
      status: 'error',
      errorClass: 'http',
    })
  })

  it('rejects mismatched payload symbols before writing contaminated rows', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const fixtures = new Map<string, unknown>([
      ['https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3', [{
        symbol: 'BTCUSDT',
        fundingTime: 1_800_000_000_000,
        fundingRate: '0.0001',
        markPrice: '3200',
      }]],
    ])

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      fetchTimeoutMs: 1_000,
      maxRetries: 0,
      dryRun: false,
      json: true,
    }, fakeFetch(fixtures))

    expect(report).toMatchObject({
      fetchedRows: 0,
      appendedRows: 0,
      persistedRows: 0,
      errorSummary: { payload_schema: 1 },
    })
    expect(report.errors).toEqual([
      expect.objectContaining({
        symbol: 'ETHUSDT',
        endpoint: 'fundingRate',
        errorClass: 'payload_schema',
      }),
    ])
    expect(await pathExists(outputPath)).toBe(false)
  })

  it('reports previous run age and stale state from the latest report', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const reportPath = join(root, 'latest.json')
    await writeFile(reportPath, JSON.stringify({
      runId: 'previous-run',
      generatedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf-8')
    const fixtures = new Map<string, unknown>([
      ['https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=3', [{
        symbol: 'ETHUSDT',
        fundingTime: 1_800_000_000_000,
        fundingRate: '0.0001',
        markPrice: '3200',
      }]],
    ])

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      reportPath,
      fetchTimeoutMs: 1_000,
      staleReportMs: 1,
      dryRun: false,
      json: true,
    }, fakeFetch(fixtures))

    expect(report.previousReportRunId).toBe('previous-run')
    expect(report.previousReportAgeMs).toEqual(expect.any(Number))
    expect(report.previousReportStale).toBe(true)
  })

  it('writes a lock-held latest report when the previous report is stale', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const reportPath = join(root, 'latest.json')
    const runLedgerPath = join(root, 'runs.jsonl')
    const lockDir = join(root, 'collector.lock')
    await mkdir(lockDir)
    await writeFile(reportPath, JSON.stringify({
      runId: 'old-run',
      generatedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf-8')

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      reportPath,
      runLedgerPath,
      collectorLockDir: lockDir,
      staleReportMs: 1,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }, fakeFetch(new Map()))

    expect(report).toMatchObject({
      collectorLockStatus: 'skipped_lock_held',
      previousReportRunId: 'old-run',
      previousReportStale: true,
      errorSummary: { collector_lock: 1 },
    })
    const latest = JSON.parse(await readFile(reportPath, 'utf-8'))
    expect(latest).toMatchObject({
      runId: report.runId,
      collectorLockStatus: 'skipped_lock_held',
    })
    expect(await pathExists(`${reportPath}.manifest.json`)).toBe(true)
    const ledgerRows = (await readFile(runLedgerPath, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(ledgerRows.at(-1)).toMatchObject({
      runId: report.runId,
      reportPath,
      collectorLockStatus: 'skipped_lock_held',
      errorCount: 1,
    })
  })

  it('does not overwrite a fresh latest report when the collector lock is held', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const reportPath = join(root, 'latest.json')
    const runLedgerPath = join(root, 'runs.jsonl')
    const lockDir = join(root, 'collector.lock')
    await mkdir(lockDir)
    await writeFile(reportPath, JSON.stringify({
      runId: 'fresh-run',
      generatedAt: new Date().toISOString(),
      collectorLockStatus: 'acquired',
    }), 'utf-8')

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      reportPath,
      runLedgerPath,
      collectorLockDir: lockDir,
      staleReportMs: 60_000,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }, fakeFetch(new Map()))

    expect(report).toMatchObject({
      collectorLockStatus: 'skipped_lock_held',
      previousReportRunId: 'fresh-run',
      previousReportStale: false,
    })
    const latest = JSON.parse(await readFile(reportPath, 'utf-8'))
    expect(latest).toMatchObject({
      runId: 'fresh-run',
      collectorLockStatus: 'acquired',
    })
    const ledgerRows = (await readFile(runLedgerPath, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(ledgerRows.at(-1)).toMatchObject({
      runId: report.runId,
      reportPath,
      collectorLockStatus: 'skipped_lock_held',
      previousReportRunId: 'fresh-run',
    })
  })

  it('does not delete an old collector lock while the owning pid is alive', async () => {
    const root = await tempRoot()
    const outputPath = join(root, 'events.jsonl')
    const reportPath = join(root, 'latest.json')
    const runLedgerPath = join(root, 'runs.jsonl')
    const lockDir = join(root, 'collector.lock')
    await mkdir(lockDir)
    await writeFile(join(lockDir, 'info.json'), JSON.stringify({
      pid: process.pid,
      ts: Date.now() - 60_000,
      hostname: 'test',
      purpose: 'external_derivatives_data_collect',
    }), 'utf-8')
    await writeFile(reportPath, JSON.stringify({
      runId: 'fresh-run',
      generatedAt: new Date().toISOString(),
      collectorLockStatus: 'acquired',
    }), 'utf-8')

    const report = await collectExternalDerivativesData({
      symbols: ['ETHUSDT'],
      endpoints: ['fundingRate'],
      period: '5m',
      outputPath,
      reportPath,
      runLedgerPath,
      collectorLockDir: lockDir,
      collectorLockStaleMs: 1,
      staleReportMs: 60_000,
      fetchTimeoutMs: 1_000,
      dryRun: false,
      json: true,
    }, fakeFetch(new Map()))

    expect(report).toMatchObject({
      collectorLockStatus: 'skipped_lock_held',
      previousReportRunId: 'fresh-run',
      previousReportStale: false,
    })
    expect(JSON.parse(await readFile(join(lockDir, 'info.json'), 'utf-8'))).toMatchObject({
      pid: process.pid,
      purpose: 'external_derivatives_data_collect',
    })
  })
})
