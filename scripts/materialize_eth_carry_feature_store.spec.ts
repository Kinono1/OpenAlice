import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseEthCarryFeatureStoreMaterializeArgs,
  runEthCarryFeatureStoreMaterialize,
} from './materialize_eth_carry_feature_store.js'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('materialize_eth_carry_feature_store', () => {
  it('parses defaults and nullable report path', () => {
    expect(parseEthCarryFeatureStoreMaterializeArgs([
      '--input',
      '/tmp/in.json',
      '--output',
      '/tmp/out.jsonl',
      '--report',
      'null',
      '--json',
    ])).toEqual({
      inputPath: '/tmp/in.json',
      outputPath: '/tmp/out.jsonl',
      reportPath: null,
      json: true,
    })
  })

  it('materializes research-only ETH carry PIT rows into feature-store JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-feature-store-'))
    const inputPath = join(root, 'eth_carry_pit_features.latest.json')
    const outputPath = join(root, 'derived/features/eth_carry_pit_features.research_only.normalized.jsonl')
    const reportPath = join(root, 'runtime/eth_carry_feature_store_materialize.latest.json')
    const source = {
      schemaVersion: 1,
      generatedAt: '2026-05-07T05:00:00.000Z',
      status: 'ready_for_research',
      researchOnly: true,
      diagnosticOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      counts: { carryFeatureRows: 1 },
      carryFeatureRows: [{
        featureId: 'feature-1',
        exchange: 'okx',
        market: 'swap',
        strategyFamily: 'funding_carry_rebuild',
        symbols: { leader: 'ETHUSDT', hedge: 'BTCUSDT' },
        decisionAvailableAt: '2026-05-07T00:42:49.601Z',
        decisionAvailableAtMs: 1778114569601,
        pairSkewMs: 381,
        fundingSpread: 0.00010817606,
        basisSpreadDiffPct: 0.0123,
        ethFundingRate: 0.0000812039669279,
        btcFundingRate: -0.0000269720932491,
        ethBasisSpreadPct: -0.0431713,
        btcBasisSpreadPct: -0.0557624,
        sourceFeatures: {
          ethBasisFeatureId: 'eth-basis-1',
          btcBasisFeatureId: 'btc-basis-1',
        },
        requiredFields: {
          fundingRateCashflow: true,
          basisSpread: true,
          explicitAvailableAt: true,
        },
        blockers: [],
      }],
      blockers: [],
    }
    await mkdir(root, { recursive: true })
    await writeFile(inputPath, `${JSON.stringify(source, null, 2)}\n`, 'utf-8')

    const report = await runEthCarryFeatureStoreMaterialize({
      inputPath,
      outputPath,
      reportPath,
      json: false,
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'complete',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      rowsRead: 1,
      rowsWritten: 1,
      blockers: [],
    })
    const outputRaw = await readFile(outputPath, 'utf-8')
    const row = JSON.parse(outputRaw.trim())
    expect(row).toMatchObject({
      schemaVersion: 'openalice.feature_store.eth_carry_pit.v1',
      source: 'openalice_research_eth_carry_pit_features',
      featureStoreFamily: 'feature_backtest_input',
      strategyFamily: 'funding_carry_rebuild',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      eventTime: '2026-05-07T00:42:49.601Z',
      availableAt: '2026-05-07T00:42:49.601Z',
      exchange: 'okx',
      symbol: 'ETHUSDT/BTCUSDT',
      quality: {
        promotionGrade: false,
        requiredFieldsComplete: true,
        blockers: [
          'feature_store_research_only_not_execution_evidence',
          'requires_strategy_specific_pit_wfo_fdr_route_cost_prospective_paper_gates',
        ],
      },
      sourceArtifact: {
        path: inputPath,
        generatedAt: '2026-05-07T05:00:00.000Z',
        hash: sha256Hex(`${JSON.stringify(source, null, 2)}\n`),
      },
    })
    expect(JSON.parse(await readFile(reportPath, 'utf-8'))).toMatchObject({
      status: 'complete',
      rowsWritten: 1,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'eth_carry_feature_store_materialize_rows',
      artifactPath: outputPath,
      businessStatus: 'warn',
      evidenceTrust: 'quarantine',
      recordsIn: 1,
      recordsOut: 1,
      artifactHash: sha256Hex(outputRaw),
    })
  })
})
