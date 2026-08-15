import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  parseEthCarryProspectiveObservationCaptureArgs,
  runEthCarryProspectiveObservationCapture,
} from './capture_eth_carry_prospective_observation.js'
import {
  buildEthCarryProspectiveEvidenceStatusReport,
  parseEthCarryProspectiveEvidenceStatusArgs,
  runEthCarryProspectiveEvidenceStatus,
} from './build_eth_carry_prospective_evidence_status.js'
import {
  parseEthCarryProspectiveObservationSettleArgs,
  runEthCarryProspectiveObservationSettle,
} from './settle_eth_carry_prospective_observations.js'
import { runEthCarryRouteCostLabelRepair } from './repair_eth_carry_prospective_route_cost_labels.js'
import type { EthCarryProspectiveObservationEvent } from './capture_eth_carry_prospective_observation.js'
import type { EthCarryProspectiveObservationOutcome } from './settle_eth_carry_prospective_observations.js'

describe('eth_carry_prospective_observations', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseEthCarryProspectiveObservationCaptureArgs([
      '--output',
      'null',
      '--dryRun',
      'false',
      '--maxObservationsPerRun',
      '3',
    ])).toMatchObject({
      featurePath: 'data/research/eth_carry_pit_features.latest.json',
      outputPath: null,
      ledgerPath: 'data/research/eth_carry_prospective_observations.jsonl',
      dryRun: false,
      maxObservationsPerRun: 3,
    })
    expect(parseEthCarryProspectiveObservationSettleArgs([
      '--output',
      'null',
      '--feePath',
      'fees.json',
      '--asOf',
      '2026-05-05T17:00:00.000Z',
    ])).toMatchObject({
      outputPath: null,
      feeSnapshotRefreshPath: 'fees.json',
      feeSnapshotPath: 'data/runtime/fee_snapshot.latest.json',
      asOfMs: Date.parse('2026-05-05T17:00:00.000Z'),
    })
    expect(parseEthCarryProspectiveEvidenceStatusArgs([
      '--output',
      'null',
      '--minClosedOutcomes',
      '10',
    ])).toMatchObject({
      outputPath: null,
      pitAuditPath: 'data/research/eth_carry_pit_audit.latest.json',
      minClosedOutcomes: 10,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:prospective-observation:capture']).toContain('capture_eth_carry_prospective_observation.ts')
    expect(scripts['research:eth-carry:prospective-observation:capture']).toContain('--dataDir data/market/live_5m')
    expect(scripts['research:eth-carry:prospective-observation:capture']).toContain('--barMinutes 5')
    expect(scripts['research:eth-carry:prospective-observation:capture']).toContain('--maxObservationsPerRun 6')
    expect(scripts['research:eth-carry:prospective-observation:settle']).toContain('settle_eth_carry_prospective_observations.ts')
    expect(scripts['research:eth-carry:prospective-observation:settle']).toContain('--dataDir data/market/live_5m')
    expect(scripts['research:eth-carry:prospective-observation:settle']).toContain('--barMinutes 5')
    expect(scripts['research:eth-carry:prospective-route-cost-label-repair']).toContain('repair_eth_carry_prospective_route_cost_labels.ts')
    expect(scripts['research:eth-carry:prospective-route-cost-label-repair']).toContain('--dryRun false')
    expect(scripts['research:eth-carry:prospective-evidence:status']).toContain('build_eth_carry_prospective_evidence_status.ts')
  })

  it('captures, settles, and summarizes a research-only ETH carry prospective label', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-prospective-'))
    const dataDir = join(root, 'market')
    const researchDir = join(root, 'research')
    await mkdir(dataDir, { recursive: true })
    await mkdir(researchDir, { recursive: true })
    await writeCsv(join(dataDir, 'ETH_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 2000],
      [Date.parse('2026-05-05T17:00:00.000Z'), '2026-05-05T17:00:00.000Z', 1980],
    ])
    await writeCsv(join(dataDir, 'BTC_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 100],
      [Date.parse('2026-05-05T17:00:00.000Z'), '2026-05-05T17:00:00.000Z', 102],
    ])
    const featurePath = join(researchDir, 'eth_carry_pit_features.latest.json')
    const ledgerPath = join(researchDir, 'eth_carry_prospective_observations.jsonl')
    const capturePath = join(researchDir, 'capture.latest.json')
    const settlePath = join(researchDir, 'settle.latest.json')
    const statusPath = join(researchDir, 'status.latest.json')
    const pitAuditPath = join(researchDir, 'eth_carry_pit_audit.latest.json')
    const feePath = join(researchDir, 'fee_snapshot_refresh.latest.json')
    await writeJson(featurePath, {
      schemaVersion: 1,
      carryFeatureRows: [{
        featureId: 'feature-1',
        exchange: 'binance',
        market: 'usdm',
        strategyFamily: 'funding_carry_rebuild',
        symbols: { leader: 'ETHUSDT', hedge: 'BTCUSDT' },
        decisionAvailableAt: '2026-05-05T08:07:34.000Z',
        decisionAvailableAtMs: Date.parse('2026-05-05T08:07:34.000Z'),
        pairSkewMs: 1000,
        fundingSpread: 0.00003,
        basisSpreadDiffPct: 0.1,
        ethFundingRate: 0.00004,
        btcFundingRate: 0.00001,
        ethBasisSpreadPct: 0.12,
        btcBasisSpreadPct: 0.02,
        ethNextFundingTime: '2026-05-05T16:00:00.000Z',
        btcNextFundingTime: '2026-05-05T16:00:00.000Z',
        requiredFields: {
          fundingRateCashflow: true,
          basisSpread: true,
          explicitAvailableAt: true,
        },
        sourceFeatures: {
          ethBasisFeatureId: 'eth-basis',
          btcBasisFeatureId: 'btc-basis',
        },
        blockers: [],
      }],
    })
    await writeJson(feePath, {
      status: 'runtime_verified',
      feeSnapshot: {
        makerFeeBps: 2,
        takerFeeBps: 5,
        sourceFetchedAt: '2026-05-05T08:00:00.000Z',
      },
      perSymbolFees: [
        { symbol: 'BTC/USDT:USDT', makerFeeBps: 2, takerFeeBps: 5 },
        { symbol: 'ETH/USDT:USDT', makerFeeBps: 2, takerFeeBps: 5 },
      ],
    })
    await writeJson(pitAuditPath, {
      status: 'pass',
      blockers: [],
      counts: {
        carryFeatureRows: 1,
        auditedRows: 1,
        passingRows: 1,
        failingRows: 0,
      },
    })

    const capture = await runEthCarryProspectiveObservationCapture({
      featurePath,
      dataDir,
      ledgerPath,
      outputPath: capturePath,
      barMinutes: 60,
      labelDelayHours: 8,
      maxRows: null,
      asOfMs: Date.parse('2026-05-05T10:00:00.000Z'),
      allowHistoricalDue: false,
      dryRun: false,
      json: false,
    })

    expect(capture).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'captured',
      counts: {
        observationsBuilt: 1,
        appendedObservations: 1,
      },
      observation: {
        decisionTime: '2026-05-05T09:00:00.000Z',
        labelDueTime: '2026-05-05T17:00:00.000Z',
        signal: {
          direction: 'short_eth_long_btc',
          long: {
            symbol: 'BTC-USDT',
            entryPrice: 100,
          },
          short: {
            symbol: 'ETH-USDT',
            entryPrice: 2000,
          },
        },
      },
    })

    const settle = await runEthCarryProspectiveObservationSettle({
      ledgerPath,
      dataDir,
      feeSnapshotRefreshPath: feePath,
      feeSnapshotPath: join(researchDir, 'fee_snapshot.latest.json'),
      outputPath: settlePath,
      barMinutes: 60,
      asOfMs: Date.parse('2026-05-05T18:00:00.000Z'),
      maxOutcomes: null,
      dryRun: false,
      json: false,
    })

    expect(settle).toMatchObject({
      status: 'settled',
      counts: {
        dueOpenEvents: 1,
        outcomesBuilt: 1,
        appendedOutcomes: 1,
      },
      appendResults: [{
        appended: true,
        reason: 'appended',
      }],
      outcomes: [{
        label: {
          grossCarryPairReturnPct: 3,
          carrySignalProfitableGross: true,
          fundingCashflowAccounted: true,
          fundingCashflowPct: 0.003,
          fundingCashflowEvents: 2,
          fundingCashflowStatus: 'accounted_from_pit_next_funding_time',
          routeCostAdjusted: true,
          routeCostPct: 0.2,
          routeCostAdjustedNetPct: 2.803,
          routeCostAdjustmentStatus: 'adjusted_with_runtime_verified_fee_snapshot',
        },
        blockers: expect.arrayContaining([
          'prospective_outcome_not_execution_evidence',
          'paper_live_execution_disabled',
        ]),
      }],
    })

    const status = await runEthCarryProspectiveEvidenceStatus({
      ledgerPath,
      outputPath: statusPath,
      pitAuditPath,
      asOfMs: Date.parse('2026-05-05T18:00:00.000Z'),
      minClosedOutcomes: 100,
      minNonOverlappingWindows: 3,
      requireRuntimeVerifiedFees: true,
      json: false,
    })

    expect(status).toMatchObject({
      status: 'has_closed_labels',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      counts: {
        openEvents: 1,
        closedEvents: 1,
        closedMatchedToOpen: 1,
      },
      metrics: {
        closedOutcomes: 1,
        meanGrossCarryPairReturnPct: 3,
        winRatePct: 100,
        routeCostAdjustedClosedOutcomes: 1,
        fundingCashflowAccountedClosedOutcomes: 1,
      },
      blockers: expect.arrayContaining([
        'research_only_not_execution_evidence',
        'paper_live_execution_disabled',
        'prospective_closed_outcomes_low:1<100',
        'prospective_closed_windows_low:1<3',
      ]),
    })
    expect(status.blockers).not.toContain('prospective_route_cost_adjusted_labels_missing')
    expect(status.blockers).not.toContain('prospective_funding_cashflow_labels_missing')
    expect(status.blockers).not.toContain('runtime_fee_not_verified')
    expect(status.blockers).not.toContain('not_pit_audit_validated')
    const writtenStatus = JSON.parse(await readFile(statusPath, 'utf-8'))
    expect(writtenStatus.paperTradingAllowed).toBe(false)
  })

  it('does not backfill already-due ETH carry observations during normal capture ticks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-due-skip-'))
    const dataDir = join(root, 'market')
    const researchDir = join(root, 'research')
    await mkdir(dataDir, { recursive: true })
    await mkdir(researchDir, { recursive: true })
    await writeCsv(join(dataDir, 'ETH_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T17:00:00.000Z'), '2026-05-05T17:00:00.000Z', 2000],
      [Date.parse('2026-05-06T01:00:00.000Z'), '2026-05-06T01:00:00.000Z', 1980],
      [Date.parse('2026-05-06T09:00:00.000Z'), '2026-05-06T09:00:00.000Z', 2010],
      [Date.parse('2026-05-06T17:00:00.000Z'), '2026-05-06T17:00:00.000Z', 2020],
    ])
    await writeCsv(join(dataDir, 'BTC_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T17:00:00.000Z'), '2026-05-05T17:00:00.000Z', 100],
      [Date.parse('2026-05-06T01:00:00.000Z'), '2026-05-06T01:00:00.000Z', 101],
      [Date.parse('2026-05-06T09:00:00.000Z'), '2026-05-06T09:00:00.000Z', 102],
      [Date.parse('2026-05-06T17:00:00.000Z'), '2026-05-06T17:00:00.000Z', 103],
    ])
    const featurePath = join(researchDir, 'eth_carry_pit_features.latest.json')
    const ledgerPath = join(researchDir, 'eth_carry_prospective_observations.jsonl')
    await writeJson(featurePath, {
      schemaVersion: 1,
      carryFeatureRows: [
        carryFeature({
          featureId: 'latest-feature',
          decisionAvailableAt: '2026-05-06T08:08:32.000Z',
          fundingSpread: -0.00003,
        }),
        carryFeature({
          featureId: 'old-feature',
          decisionAvailableAt: '2026-05-05T16:07:05.000Z',
          fundingSpread: 0.00003,
        }),
      ],
    })

    const first = await runEthCarryProspectiveObservationCapture({
      featurePath,
      dataDir,
      ledgerPath,
      outputPath: null,
      barMinutes: 60,
      labelDelayHours: 8,
      maxRows: null,
      asOfMs: Date.parse('2026-05-06T12:00:00.000Z'),
      allowHistoricalDue: false,
      dryRun: false,
      json: false,
    })
    expect(first).toMatchObject({
      status: 'captured',
      counts: {
        appendedObservations: 1,
      },
      observation: {
        sourceFeature: {
          featureId: 'latest-feature',
        },
        decisionTime: '2026-05-06T09:00:00.000Z',
        labelDueTime: '2026-05-06T17:00:00.000Z',
      },
    })

    const second = await runEthCarryProspectiveObservationCapture({
      featurePath,
      dataDir,
      ledgerPath,
      outputPath: null,
      barMinutes: 60,
      labelDelayHours: 8,
      maxRows: null,
      asOfMs: Date.parse('2026-05-06T12:00:00.000Z'),
      allowHistoricalDue: false,
      dryRun: false,
      json: false,
    })
    expect(second).toMatchObject({
      status: 'skipped_duplicate',
      counts: {
        observationsBuilt: 0,
        appendedObservations: 0,
        skippedAlreadyDueObservations: 1,
      },
      appendResult: {
        appended: false,
        reason: 'duplicate_observation_id',
      },
      blockers: [],
    })

    const historicalBackfill = await runEthCarryProspectiveObservationCapture({
      featurePath,
      dataDir,
      ledgerPath,
      outputPath: null,
      barMinutes: 60,
      labelDelayHours: 8,
      maxRows: null,
      asOfMs: Date.parse('2026-05-06T12:00:00.000Z'),
      allowHistoricalDue: true,
      dryRun: true,
      json: false,
    })
    expect(historicalBackfill).toMatchObject({
      status: 'captured',
      dryRun: true,
      appendResult: {
        appended: false,
        reason: 'dry_run',
      },
      observation: {
        sourceFeature: {
          featureId: 'old-feature',
        },
        decisionTime: '2026-05-05T17:00:00.000Z',
        labelDueTime: '2026-05-06T01:00:00.000Z',
      },
    })
  })

  it('can batch-capture multiple future-only ETH carry observations without historical backfill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-batch-capture-'))
    const dataDir = join(root, 'market')
    const researchDir = join(root, 'research')
    await mkdir(dataDir, { recursive: true })
    await mkdir(researchDir, { recursive: true })
    await writeCsv(join(dataDir, 'ETH_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T01:00:00.000Z'), '2026-05-05T01:00:00.000Z', 1980],
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 2000],
      [Date.parse('2026-05-05T10:00:00.000Z'), '2026-05-05T10:00:00.000Z', 2010],
      [Date.parse('2026-05-05T11:00:00.000Z'), '2026-05-05T11:00:00.000Z', 2020],
      [Date.parse('2026-05-05T12:00:00.000Z'), '2026-05-05T12:00:00.000Z', 2030],
    ])
    await writeCsv(join(dataDir, 'BTC_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T01:00:00.000Z'), '2026-05-05T01:00:00.000Z', 99],
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 100],
      [Date.parse('2026-05-05T10:00:00.000Z'), '2026-05-05T10:00:00.000Z', 101],
      [Date.parse('2026-05-05T11:00:00.000Z'), '2026-05-05T11:00:00.000Z', 102],
      [Date.parse('2026-05-05T12:00:00.000Z'), '2026-05-05T12:00:00.000Z', 103],
    ])
    const featurePath = join(researchDir, 'eth_carry_pit_features.latest.json')
    const ledgerPath = join(researchDir, 'eth_carry_prospective_observations.jsonl')
    await writeJson(featurePath, {
      schemaVersion: 1,
      carryFeatureRows: [
        carryFeature({
          featureId: 'future-feature-3',
          decisionAvailableAt: '2026-05-05T10:08:32.000Z',
          fundingSpread: -0.00003,
        }),
        carryFeature({
          featureId: 'future-feature-2',
          decisionAvailableAt: '2026-05-05T09:08:32.000Z',
          fundingSpread: 0.00003,
        }),
        carryFeature({
          featureId: 'future-feature-1',
          decisionAvailableAt: '2026-05-05T08:08:32.000Z',
          fundingSpread: -0.00002,
        }),
        carryFeature({
          featureId: 'already-due-feature',
          decisionAvailableAt: '2026-05-05T00:08:32.000Z',
          fundingSpread: 0.00002,
        }),
      ],
    })

    const capture = await runEthCarryProspectiveObservationCapture({
      featurePath,
      dataDir,
      ledgerPath,
      outputPath: null,
      barMinutes: 60,
      labelDelayHours: 8,
      maxRows: null,
      maxObservationsPerRun: 4,
      asOfMs: Date.parse('2026-05-05T12:00:00.000Z'),
      allowHistoricalDue: false,
      dryRun: false,
      json: false,
    })

    expect(capture).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'captured',
      counts: {
        observationsBuilt: 3,
        appendedObservations: 3,
        skippedAlreadyDueObservations: 1,
      },
      appendResults: [
        {
          appended: true,
          reason: 'appended',
        },
        {
          appended: true,
          reason: 'appended',
        },
        {
          appended: true,
          reason: 'appended',
        },
      ],
    })
    expect(capture.observations.map(observation => observation.sourceFeature.featureId)).toEqual([
      'future-feature-3',
      'future-feature-2',
      'future-feature-1',
    ])
    expect(capture.observations.map(observation => observation.labelDueTime)).toEqual([
      '2026-05-05T19:00:00.000Z',
      '2026-05-05T18:00:00.000Z',
      '2026-05-05T17:00:00.000Z',
    ])
    expect(capture.observations.every(observation => observation.labelDueBarTime > Date.parse('2026-05-05T12:00:00.000Z'))).toBe(true)
    expect((await readFile(ledgerPath, 'utf-8')).trim().split('\n')).toHaveLength(3)
  })

  it('uses a valid runtime fee snapshot fallback for research-only route-cost labels when fee refresh is blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-fee-fallback-'))
    const dataDir = join(root, 'market')
    const researchDir = join(root, 'research')
    await mkdir(dataDir, { recursive: true })
    await mkdir(researchDir, { recursive: true })
    await writeCsv(join(dataDir, 'ETH_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 2000],
      [Date.parse('2026-05-05T17:00:00.000Z'), '2026-05-05T17:00:00.000Z', 1980],
    ])
    await writeCsv(join(dataDir, 'BTC_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 100],
      [Date.parse('2026-05-05T17:00:00.000Z'), '2026-05-05T17:00:00.000Z', 102],
    ])
    const featurePath = join(researchDir, 'eth_carry_pit_features.latest.json')
    const ledgerPath = join(researchDir, 'eth_carry_prospective_observations.jsonl')
    const blockedRefreshPath = join(researchDir, 'fee_snapshot_refresh.latest.json')
    const feeSnapshotPath = join(researchDir, 'fee_snapshot.latest.json')
    await writeJson(featurePath, {
      schemaVersion: 1,
      carryFeatureRows: [carryFeature({
        featureId: 'feature-fee-fallback',
        decisionAvailableAt: '2026-05-05T08:07:34.000Z',
        fundingSpread: 0.00003,
      })],
    })
    await writeJson(blockedRefreshPath, {
      status: 'blocked',
      blockers: ['fee_snapshot_no_valid_fee_rows'],
      perSymbolFees: [],
    })
    await writeJson(feeSnapshotPath, {
      source: 'api',
      verifiedByRuntime: true,
      sourceFetchedAt: '2026-05-05T08:00:00.000Z',
      expiresAt: '2026-05-06T08:00:00.000Z',
      makerFeeBps: 2,
      takerFeeBps: 5,
    })

    await runEthCarryProspectiveObservationCapture({
      featurePath,
      dataDir,
      ledgerPath,
      outputPath: null,
      barMinutes: 60,
      labelDelayHours: 8,
      maxRows: null,
      asOfMs: Date.parse('2026-05-05T10:00:00.000Z'),
      allowHistoricalDue: false,
      dryRun: false,
      json: false,
    })

    const settle = await runEthCarryProspectiveObservationSettle({
      ledgerPath,
      dataDir,
      feeSnapshotRefreshPath: blockedRefreshPath,
      feeSnapshotPath,
      outputPath: null,
      barMinutes: 60,
      asOfMs: Date.parse('2026-05-05T18:00:00.000Z'),
      maxOutcomes: null,
      dryRun: false,
      json: false,
    })

    expect(settle).toMatchObject({
      status: 'settled',
      counts: {
        dueOpenEvents: 1,
        outcomesBuilt: 1,
        appendedOutcomes: 1,
      },
      outcomes: [{
        label: {
          routeCostAdjusted: true,
          routeCostPct: 0.2,
          routeCostAdjustmentStatus: 'adjusted_with_runtime_verified_fee_snapshot',
        },
        blockers: expect.not.arrayContaining(['route_cost_adjusted_label_missing']),
      }],
    })
  })

  it('does not route-cost adjust labels from a stale runtime fee snapshot fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-fee-stale-'))
    const dataDir = join(root, 'market')
    const researchDir = join(root, 'research')
    await mkdir(dataDir, { recursive: true })
    await mkdir(researchDir, { recursive: true })
    await writeCsv(join(dataDir, 'ETH_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 2000],
      [Date.parse('2026-05-05T17:00:00.000Z'), '2026-05-05T17:00:00.000Z', 1980],
    ])
    await writeCsv(join(dataDir, 'BTC_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 100],
      [Date.parse('2026-05-05T17:00:00.000Z'), '2026-05-05T17:00:00.000Z', 102],
    ])
    const featurePath = join(researchDir, 'eth_carry_pit_features.latest.json')
    const ledgerPath = join(researchDir, 'eth_carry_prospective_observations.jsonl')
    const blockedRefreshPath = join(researchDir, 'fee_snapshot_refresh.latest.json')
    const feeSnapshotPath = join(researchDir, 'fee_snapshot.latest.json')
    await writeJson(featurePath, {
      schemaVersion: 1,
      carryFeatureRows: [carryFeature({
        featureId: 'feature-fee-stale',
        decisionAvailableAt: '2026-05-05T08:07:34.000Z',
        fundingSpread: 0.00003,
      })],
    })
    await writeJson(blockedRefreshPath, {
      status: 'blocked',
      blockers: ['fee_snapshot_no_valid_fee_rows'],
      perSymbolFees: [],
    })
    await writeJson(feeSnapshotPath, {
      source: 'api',
      verifiedByRuntime: true,
      sourceFetchedAt: '2026-05-04T08:00:00.000Z',
      expiresAt: '2026-05-05T12:00:00.000Z',
      makerFeeBps: 2,
      takerFeeBps: 5,
    })

    await runEthCarryProspectiveObservationCapture({
      featurePath,
      dataDir,
      ledgerPath,
      outputPath: null,
      barMinutes: 60,
      labelDelayHours: 8,
      maxRows: null,
      asOfMs: Date.parse('2026-05-05T10:00:00.000Z'),
      allowHistoricalDue: false,
      dryRun: false,
      json: false,
    })

    const settle = await runEthCarryProspectiveObservationSettle({
      ledgerPath,
      dataDir,
      feeSnapshotRefreshPath: blockedRefreshPath,
      feeSnapshotPath,
      outputPath: null,
      barMinutes: 60,
      asOfMs: Date.parse('2026-05-05T18:00:00.000Z'),
      maxOutcomes: null,
      dryRun: false,
      json: false,
    })

    expect(settle).toMatchObject({
      status: 'settled',
      counts: {
        dueOpenEvents: 1,
        outcomesBuilt: 1,
        appendedOutcomes: 1,
      },
      outcomes: [{
        label: {
          routeCostAdjusted: false,
          routeCostPct: null,
          routeCostAdjustedNetPct: null,
          routeCostAdjustmentStatus: 'blocked_runtime_fee_not_verified',
        },
        blockers: expect.arrayContaining(['route_cost_adjusted_label_missing']),
      }],
    })
  })

  it('append-only restates missing route-cost labels and current status reads the latest closed outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-route-repair-'))
    const dataDir = join(root, 'market')
    const researchDir = join(root, 'research')
    await mkdir(dataDir, { recursive: true })
    await mkdir(researchDir, { recursive: true })
    await writeCsv(join(dataDir, 'ETH_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 2000],
      [Date.parse('2026-05-05T17:00:00.000Z'), '2026-05-05T17:00:00.000Z', 1980],
    ])
    await writeCsv(join(dataDir, 'BTC_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 100],
      [Date.parse('2026-05-05T17:00:00.000Z'), '2026-05-05T17:00:00.000Z', 102],
    ])
    const featurePath = join(researchDir, 'eth_carry_pit_features.latest.json')
    const ledgerPath = join(researchDir, 'eth_carry_prospective_observations.jsonl')
    const blockedRefreshPath = join(researchDir, 'fee_snapshot_refresh.latest.json')
    const staleFeeSnapshotPath = join(researchDir, 'fee_snapshot.stale.json')
    const validFeeSnapshotPath = join(researchDir, 'fee_snapshot.valid.json')
    const pitAuditPath = join(researchDir, 'eth_carry_pit_audit.latest.json')
    await writeJson(featurePath, {
      schemaVersion: 1,
      carryFeatureRows: [carryFeature({
        featureId: 'feature-route-repair',
        decisionAvailableAt: '2026-05-05T08:07:34.000Z',
        fundingSpread: 0.00003,
      })],
    })
    await writeJson(blockedRefreshPath, {
      status: 'blocked',
      blockers: ['fee_snapshot_no_valid_fee_rows'],
      perSymbolFees: [],
    })
    await writeJson(staleFeeSnapshotPath, {
      source: 'api',
      verifiedByRuntime: true,
      sourceFetchedAt: '2026-05-04T08:00:00.000Z',
      expiresAt: '2026-05-05T12:00:00.000Z',
      makerFeeBps: 2,
      takerFeeBps: 5,
    })
    await writeJson(validFeeSnapshotPath, {
      source: 'api',
      verifiedByRuntime: true,
      sourceFetchedAt: '2026-05-05T08:00:00.000Z',
      expiresAt: '2026-05-06T08:00:00.000Z',
      makerFeeBps: 2,
      takerFeeBps: 5,
    })
    await writeJson(pitAuditPath, {
      status: 'pass',
      blockers: [],
      counts: {
        carryFeatureRows: 1,
        auditedRows: 1,
        passingRows: 1,
        failingRows: 0,
      },
    })

    await runEthCarryProspectiveObservationCapture({
      featurePath,
      dataDir,
      ledgerPath,
      outputPath: null,
      barMinutes: 60,
      labelDelayHours: 8,
      maxRows: null,
      asOfMs: Date.parse('2026-05-05T10:00:00.000Z'),
      allowHistoricalDue: false,
      dryRun: false,
      json: false,
    })
    await runEthCarryProspectiveObservationSettle({
      ledgerPath,
      dataDir,
      feeSnapshotRefreshPath: blockedRefreshPath,
      feeSnapshotPath: staleFeeSnapshotPath,
      outputPath: null,
      barMinutes: 60,
      asOfMs: Date.parse('2026-05-05T18:00:00.000Z'),
      maxOutcomes: null,
      dryRun: false,
      json: false,
    })

    const before = await runEthCarryProspectiveEvidenceStatus({
      ledgerPath,
      outputPath: null,
      pitAuditPath,
      asOfMs: Date.parse('2026-05-05T18:00:00.000Z'),
      minClosedOutcomes: 1,
      minNonOverlappingWindows: 1,
      requireRuntimeVerifiedFees: true,
      json: false,
    })
    expect(before.metrics.routeCostAdjustedClosedOutcomes).toBe(0)
    expect(before.blockers).toContain('prospective_route_cost_adjusted_labels_missing')

    const repair = await runEthCarryRouteCostLabelRepair({
      ledgerPath,
      feeSnapshotPath: validFeeSnapshotPath,
      outputPath: null,
      asOfMs: Date.parse('2026-05-05T18:00:00.000Z'),
      dryRun: false,
      json: false,
    })
    expect(repair).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'repaired',
      counts: {
        closedOutcomesLoaded: 1,
        missingRouteCostClosedOutcomes: 1,
        restatementsBuilt: 1,
        restatementsAppended: 1,
      },
      restatements: [{
        label: {
          routeCostAdjusted: true,
          routeCostPct: 0.2,
          routeCostAdjustmentStatus: 'adjusted_with_runtime_verified_fee_snapshot',
        },
        restatement: {
          reason: 'route_cost_adjustment_restatement',
        },
      }],
    })
    expect((await readFile(ledgerPath, 'utf-8')).trim().split('\n')).toHaveLength(3)

    const after = await runEthCarryProspectiveEvidenceStatus({
      ledgerPath,
      outputPath: null,
      pitAuditPath,
      asOfMs: Date.parse('2026-05-05T18:00:00.000Z'),
      minClosedOutcomes: 1,
      minNonOverlappingWindows: 1,
      requireRuntimeVerifiedFees: true,
      json: false,
    })
    expect(after.counts.closedEvents).toBe(1)
    expect(after.metrics.routeCostAdjustedClosedOutcomes).toBe(1)
    expect(after.blockers).not.toContain('prospective_route_cost_adjusted_labels_missing')
    expect(after.blockers).not.toContain('runtime_fee_not_verified')
  })

  it('blocks settlement when due labels cannot find close candles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-missing-close-'))
    const dataDir = join(root, 'market')
    const researchDir = join(root, 'research')
    await mkdir(dataDir, { recursive: true })
    await mkdir(researchDir, { recursive: true })
    await writeCsv(join(dataDir, 'ETH_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 2000],
    ])
    await writeCsv(join(dataDir, 'BTC_USDT_USDT_1h.csv'), [
      [Date.parse('2026-05-05T09:00:00.000Z'), '2026-05-05T09:00:00.000Z', 100],
    ])
    const featurePath = join(researchDir, 'eth_carry_pit_features.latest.json')
    const ledgerPath = join(researchDir, 'eth_carry_prospective_observations.jsonl')
    await writeJson(featurePath, {
      schemaVersion: 1,
      carryFeatureRows: [carryFeature({
        featureId: 'feature-missing-close',
        decisionAvailableAt: '2026-05-05T08:07:34.000Z',
        fundingSpread: 0.00003,
      })],
    })

    await runEthCarryProspectiveObservationCapture({
      featurePath,
      dataDir,
      ledgerPath,
      outputPath: null,
      barMinutes: 60,
      labelDelayHours: 8,
      maxRows: null,
      asOfMs: Date.parse('2026-05-05T10:00:00.000Z'),
      allowHistoricalDue: false,
      dryRun: false,
      json: false,
    })

    const settle = await runEthCarryProspectiveObservationSettle({
      ledgerPath,
      dataDir,
      feeSnapshotRefreshPath: join(researchDir, 'missing-fees.json'),
      feeSnapshotPath: join(researchDir, 'missing-fee-snapshot.json'),
      outputPath: null,
      barMinutes: 60,
      asOfMs: Date.parse('2026-05-05T18:00:00.000Z'),
      maxOutcomes: null,
      dryRun: false,
      json: false,
    })

    expect(settle).toMatchObject({
      status: 'blocked',
      counts: {
        dueOpenEvents: 1,
        missingCloseCandles: 1,
        outcomesBuilt: 0,
        appendedOutcomes: 0,
      },
      appendResults: [{
        appended: false,
        reason: 'missing_close_candle',
      }],
      blockers: ['due_open_events_missing_close_candles:1'],
    })
  })

  it('reports blocked_no_ledger when no prospective ledger exists', () => {
    const report = buildEthCarryProspectiveEvidenceStatusReport({
      ledgerPath: '/tmp/missing.jsonl',
      pitAuditPath: '/tmp/pit_audit.json',
      pitAudit: null,
      ledgerExists: false,
      openEvents: [],
      closedEvents: [],
      asOfMs: Date.parse('2026-05-05T18:00:00.000Z'),
      thresholds: {
        minClosedOutcomes: 100,
        minNonOverlappingWindows: 3,
        requireRuntimeVerifiedFees: true,
      },
      generatedAt: '2026-05-05T18:00:00.000Z',
    })

    expect(report).toMatchObject({
      status: 'blocked_no_ledger',
      blockers: expect.arrayContaining([
        'prospective_observation_ledger_missing',
        'prospective_open_observations_missing',
      ]),
    })
  })
})

async function writeCsv(path: string, rows: Array<[number, string, number]>): Promise<void> {
  await writeFile(path, [
    'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
    ...rows.map(([timestamp, datetime, close]) =>
      `${timestamp},${datetime},${close},${close},${close},${close},1,TEST,1h,okx`),
  ].join('\n'))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function carryFeature(input: {
  featureId: string
  decisionAvailableAt: string
  fundingSpread: number
}): Record<string, unknown> {
  return {
    featureId: input.featureId,
    exchange: 'binance',
    market: 'usdm',
    strategyFamily: 'funding_carry_rebuild',
    symbols: { leader: 'ETHUSDT', hedge: 'BTCUSDT' },
    decisionAvailableAt: input.decisionAvailableAt,
    decisionAvailableAtMs: Date.parse(input.decisionAvailableAt),
    pairSkewMs: 0,
    fundingSpread: input.fundingSpread,
    basisSpreadDiffPct: 0.01,
    ethFundingRate: 0.00004,
    btcFundingRate: 0.00001,
    ethBasisSpreadPct: 0.12,
    btcBasisSpreadPct: 0.02,
    ethNextFundingTime: '2026-05-06T16:00:00.000Z',
    btcNextFundingTime: '2026-05-06T16:00:00.000Z',
    requiredFields: {
      fundingRateCashflow: true,
      basisSpread: true,
      explicitAvailableAt: true,
    },
    sourceFeatures: {
      ethBasisFeatureId: `${input.featureId}-eth-basis`,
      btcBasisFeatureId: `${input.featureId}-btc-basis`,
    },
    blockers: [],
  }
}

void ({} as EthCarryProspectiveObservationEvent)
void ({} as EthCarryProspectiveObservationOutcome)
