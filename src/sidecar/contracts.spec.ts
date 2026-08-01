import { describe, expect, it } from 'vitest'
import fixture from './fixtures/openalice_sidecar_contract_v1.json'
import {
  buildOpenAliceSidecarRequestV1,
  buildSidecarResultBundleV1,
  openAliceSidecarRequestV1Schema,
  sha256Canonical,
  stableStringify,
  validateSidecarExchangeV1,
  type OpenAliceSidecarRequestV1,
  type SidecarResultBundleV1,
} from './contracts.js'

const OPENALICE_COMMIT = '1'.repeat(40)
const SIDECAR_COMMIT = '2'.repeat(40)
const NOW = new Date('2026-07-31T08:00:00.000Z')

function request(
  overrides: Partial<OpenAliceSidecarRequestV1> = {},
): OpenAliceSidecarRequestV1 {
  const built = buildOpenAliceSidecarRequestV1({
    schemaVersion: 'openalice_sidecar_request.v1',
    runId: 'run-contract-1',
    source: 'tradingagents',
    issuedAt: '2026-07-31T07:59:00.000Z',
    expiresAt: '2026-07-31T08:04:00.000Z',
    allowedAssets: ['BTC/USD', 'ETH/USD'],
    inputArtifacts: [{ artifactId: 'market-window', sha256: 'a'.repeat(64) }],
    openAliceCommit: OPENALICE_COMMIT,
    sidecarCommit: SIDECAR_COMMIT,
    mode: 'research_only',
    payload: {
      symbol: 'BTC/USD',
      marketContext: { candles: [] },
    },
  })
  return { ...built, ...overrides }
}

function bundle(
  req = request(),
  overrides: Partial<Parameters<typeof buildSidecarResultBundleV1>[0]> = {},
): SidecarResultBundleV1 {
  return buildSidecarResultBundleV1({
    request: req,
    status: 'ok',
    generatedAt: '2026-07-31T08:00:00.000Z',
    signals: [{
      signalId: 'signal-1',
      asset: 'BTC/USD',
      asOf: '2026-07-31T07:59:30.000Z',
      ttlMs: 300_000,
      targetPositionPct: 0.25,
      confidence: 0.7,
      thesis: 'Research-only directional view.',
    }],
    runtime: {
      name: 'TradingAgents',
      version: '0.2.0',
      language: 'python-3.13',
      modelVersions: ['offline-fixture'],
    },
    failure: null,
    ...overrides,
  })
}

function validate(
  req: unknown,
  output: SidecarResultBundleV1,
) {
  return validateSidecarExchangeV1({
    request: req,
    result: output.result,
    manifest: output.manifest,
    options: {
      now: NOW,
      allowedAssets: ['BTC/USD', 'ETH/USD'],
      allowedOpenAliceCommits: [OPENALICE_COMMIT],
      allowedSidecarCommits: { tradingagents: [SIDECAR_COMMIT] },
    },
  })
}

describe('OpenAlice sidecar contract v1', () => {
  it('matches the shared Python/TypeScript canonical fixture byte-for-byte', () => {
    expect(stableStringify(fixture.canonical.value)).toBe(fixture.canonical.json)
    expect(sha256Canonical(fixture.canonical.value)).toBe(fixture.canonical.sha256)

    for (const source of ['tradingagents', 'alphaswarm'] as const) {
      const exchange = fixture.exchanges[source]
      const parsedRequest = openAliceSidecarRequestV1Schema.parse(exchange.request)
      const { requestSha256: _requestSha256, ...requestCore } = parsedRequest

      expect(buildOpenAliceSidecarRequestV1(requestCore)).toEqual(parsedRequest)
      expect(validateSidecarExchangeV1({
        request: parsedRequest,
        result: exchange.bundle.result,
        manifest: exchange.bundle.manifest,
        options: {
          now: NOW,
          allowedAssets: ['BTC/USD', 'ETH/USD'],
          allowedOpenAliceCommits: [parsedRequest.openAliceCommit],
          allowedSidecarCommits: {
            [source]: [parsedRequest.sidecarCommit],
          },
        },
      })).toMatchObject({
        accepted: true,
        disposition: 'accepted_research_only',
        circuitOpen: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        liveExecutionArmed: false,
      })
    }
  })

  it('accepts a hash- and commit-bound result as research-only', () => {
    const req = request()
    const decision = validate(req, bundle(req))

    expect(decision).toMatchObject({
      accepted: true,
      disposition: 'accepted_research_only',
      circuitOpen: false,
      reason: 'valid_research_only_result',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      liveExecutionArmed: false,
    })
  })

  it('rejects expired, tampered, and unknown-commit exchanges with an open circuit', () => {
    const req = request()
    const valid = bundle(req)

    const expired = validateSidecarExchangeV1({
      request: req,
      result: valid.result,
      manifest: valid.manifest,
      options: {
        now: new Date('2026-07-31T08:05:00.000Z'),
        allowedAssets: ['BTC/USD', 'ETH/USD'],
        allowedOpenAliceCommits: [OPENALICE_COMMIT],
        allowedSidecarCommits: { tradingagents: [SIDECAR_COMMIT] },
      },
    })
    expect(expired).toMatchObject({ reason: 'request_expired', circuitOpen: true })

    const tamperedManifest = {
      ...valid.manifest,
      artifacts: [{ artifactId: 'changed', sha256: 'f'.repeat(64), mediaType: 'application/json' }],
    }
    expect(validateSidecarExchangeV1({
      request: req,
      result: valid.result,
      manifest: tamperedManifest,
      options: {
        now: NOW,
        allowedAssets: ['BTC/USD', 'ETH/USD'],
        allowedOpenAliceCommits: [OPENALICE_COMMIT],
        allowedSidecarCommits: { tradingagents: [SIDECAR_COMMIT] },
      },
    })).toMatchObject({ reason: 'manifest_hash_mismatch', circuitOpen: true })

    expect(validateSidecarExchangeV1({
      request: req,
      result: valid.result,
      manifest: valid.manifest,
      options: {
        now: NOW,
        allowedAssets: ['BTC/USD', 'ETH/USD'],
        allowedOpenAliceCommits: ['3'.repeat(40)],
        allowedSidecarCommits: { tradingagents: [SIDECAR_COMMIT] },
      },
    })).toMatchObject({ reason: 'commit_not_allowlisted', circuitOpen: true })
  })

  it.each([
    ['timeout', 'timeout', 'sidecar_timeout'],
    ['failed', 'crash', 'sidecar_crash'],
  ] as const)('rejects %s results and opens the circuit', (status, category, reason) => {
    const req = request()
    const output = bundle(req, {
      status,
      signals: [],
      failure: { category, message: `${category} fixture` },
    })

    expect(validate(req, output)).toMatchObject({
      accepted: false,
      disposition: 'rejected_circuit_open',
      circuitOpen: true,
      reason,
    })
  })

  it('degrades an empty signal without granting or fabricating execution authority', () => {
    const req = request()
    const output = bundle(req, {
      status: 'empty',
      signals: [],
      failure: null,
    })

    expect(validate(req, output)).toMatchObject({
      accepted: false,
      disposition: 'degraded_research_only',
      circuitOpen: false,
      reason: 'empty_signal',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      liveExecutionArmed: false,
    })
  })

  it('rejects output that smuggles an execution authorization field', () => {
    const req = request()
    const output = bundle(req)
    for (const metadata of [
      { nested: { liveExecutionArmed: true } },
      { approvalStatus: 'signed' },
      { canPromote: true },
      { orderAllowed: false },
    ]) {
      const injected = structuredClone(output.result) as any
      injected.signals[0].metadata = metadata

      expect(validateSidecarExchangeV1({
        request: req,
        result: injected,
        manifest: output.manifest,
        options: {
          now: NOW,
          allowedAssets: ['BTC/USD', 'ETH/USD'],
          allowedOpenAliceCommits: [OPENALICE_COMMIT],
          allowedSidecarCommits: { tradingagents: [SIDECAR_COMMIT] },
        },
      })).toMatchObject({
        reason: 'execution_authorization_forbidden',
        circuitOpen: true,
      })
    }
  })

  it('rejects an unknown schema version and a non-whitelisted asset', () => {
    const req = request()
    const output = bundle(req)
    expect(validateSidecarExchangeV1({
      request: { ...req, schemaVersion: 'openalice_sidecar_request.v2' },
      result: output.result,
      manifest: output.manifest,
      options: {
        now: NOW,
        allowedAssets: ['BTC/USD', 'ETH/USD'],
        allowedOpenAliceCommits: [OPENALICE_COMMIT],
        allowedSidecarCommits: { tradingagents: [SIDECAR_COMMIT] },
      },
    })).toMatchObject({ reason: 'unknown_schema_version', circuitOpen: true })

    expect(validateSidecarExchangeV1({
      request: req,
      result: output.result,
      manifest: output.manifest,
      options: {
        now: NOW,
        allowedAssets: ['ETH/USD'],
        allowedOpenAliceCommits: [OPENALICE_COMMIT],
        allowedSidecarCommits: { tradingagents: [SIDECAR_COMMIT] },
      },
    })).toMatchObject({ reason: 'asset_not_allowlisted', circuitOpen: true })
  })
})
