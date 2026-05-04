import { describe, expect, it } from 'vitest'
import { parseArgs as parseCryptoTradeManifestArgs } from './materialize_cryptotrade_btc_manifest_v2.ts'
import { parseArgs as parseTradingAgentsManifestArgs } from './materialize_tradingagents_btc_manifest.ts'
import { parseArgs as parseTradingAgentsValidationManifestArgs } from './materialize_tradingagents_btc_validation_manifest.ts'
import { parseArgs as parseTradingAgentsProxyDecisionArgs } from './materialize_tradingagents_proxy_decision.ts'
import { parseArgs as parseTradingAgentsRequestArgs } from './materialize_tradingagents_request.ts'
import { parseArgs as parseTradingAgentsSidecarArgs } from './run_tradingagents_sidecar_for_btc_v2.ts'
import { parseArgs as parseOpenAliceCompletionArgs } from './run_openalice_completion.ts'

describe('TradingAgents and completion research entrypoint safety', () => {
  it('defaults artifact-producing entrypoints to dry-run without requiring input paths', () => {
    expect(parseCryptoTradeManifestArgs([]).dryRun).toBe(true)
    expect(parseTradingAgentsManifestArgs([]).dryRun).toBe(true)
    expect(parseTradingAgentsValidationManifestArgs([]).dryRun).toBe(true)
    expect(parseTradingAgentsRequestArgs([]).dryRun).toBe(true)
    expect(parseTradingAgentsProxyDecisionArgs([]).dryRun).toBe(true)
    expect(parseTradingAgentsSidecarArgs([]).dryRun).toBe(true)
    expect(parseOpenAliceCompletionArgs([]).dryRun).toBe(true)
  })

  it('requires explicit opt-in before writing manifests, sidecar artifacts, or release-gate state', () => {
    const manifestArgs = [
      '--dryRun',
      'false',
      '--input-json',
      'tmp/input.json',
      '--base-manifest',
      'tmp/base.json',
      '--output',
      'tmp/manifest.json',
      '--provenance-output',
      'tmp/provenance.json',
      '--note-output',
      'tmp/note.md',
    ]
    expect(parseCryptoTradeManifestArgs(manifestArgs).dryRun).toBe(false)
    expect(parseTradingAgentsManifestArgs(['--dryRun=false', ...manifestArgs.slice(2)]).dryRun).toBe(false)
    expect(parseTradingAgentsValidationManifestArgs(manifestArgs).dryRun).toBe(false)
    expect(parseTradingAgentsRequestArgs([
      '--dryRun=false',
      '--input-csv',
      'tmp/input.csv',
      '--output',
      'tmp/request.json',
    ]).dryRun).toBe(false)
    expect(parseTradingAgentsProxyDecisionArgs([
      '--dryRun',
      'false',
      '--request',
      'tmp/request.json',
      '--output',
      'tmp/decision.json',
    ]).dryRun).toBe(false)
    expect(parseTradingAgentsSidecarArgs([
      '--dryRun=false',
      '--request',
      'tmp/request.json',
      '--output',
      'tmp/sidecar.json',
    ]).dryRun).toBe(false)
    expect(parseOpenAliceCompletionArgs(['--dryRun', 'false']).dryRun).toBe(false)
  })

  it('still validates required paths after opt-in', () => {
    expect(() => parseTradingAgentsRequestArgs(['--dryRun', 'false'])).toThrow(/--input-csv is required/)
    expect(() => parseTradingAgentsProxyDecisionArgs(['--dryRun', 'false'])).toThrow(/--request is required/)
    expect(() => parseTradingAgentsSidecarArgs(['--dryRun', 'false'])).toThrow(/--request is required/)
    expect(() => parseCryptoTradeManifestArgs(['--dryRun', 'false'])).toThrow(/--input-json is required/)
  })
})
