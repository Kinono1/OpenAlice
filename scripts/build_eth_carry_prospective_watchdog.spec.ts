import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarryProspectiveWatchdogReport,
  parseEthCarryProspectiveWatchdogArgs,
} from './build_eth_carry_prospective_watchdog.js'

describe('build_eth_carry_prospective_watchdog', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseEthCarryProspectiveWatchdogArgs([
      '--output',
      'none',
      '--asOf',
      '2026-05-07T01:00:00.000Z',
      '--barMinutes',
      '5',
      '--minClosedOutcomes',
      '25',
    ])).toMatchObject({
      outputPath: null,
      okxSnapshotPath: 'data/runtime/okx_carry_snapshot_collect.latest.json',
      okxSnapshotRowsPath: 'data/normalized/derivatives/okx_swap_eth_carry_live.normalized.jsonl',
      pitFeaturePath: 'data/research/eth_carry_pit_features.latest.json',
      pitAuditPath: 'data/research/eth_carry_pit_audit.latest.json',
      capturePath: 'data/research/eth_carry_prospective_observation_capture.latest.json',
      settlePath: 'data/research/eth_carry_prospective_observation_settle.latest.json',
      prospectivePath: 'data/research/eth_carry_prospective_evidence_status.latest.json',
      dataGapPath: 'data/research/eth_carry_data_gap_status.latest.json',
      ledgerPath: 'data/research/eth_carry_prospective_observations.jsonl',
      dataDir: 'data/market/live_5m',
      barMinutes: 5,
      minClosedOutcomes: 25,
      asOfMs: Date.parse('2026-05-07T01:00:00.000Z'),
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:prospective-watchdog']).toContain('build_eth_carry_prospective_watchdog.ts')
    expect(scripts['status:research-evidence']).toContain('build_eth_carry_prospective_watchdog.ts')
  })

  it('waits for the future label when one open observation is pending and nothing is due', () => {
    const report = buildReport({
      asOf: '2026-05-07T01:00:00.000Z',
      ledgerEvents: [
        openEvent({
          id: 'open-1',
          decisionTime: '2026-05-07T00:45:00.000Z',
          labelDueTime: '2026-05-07T08:45:00.000Z',
        }),
        closedEvent({ id: 'closed-1' }),
        closedEvent({ id: 'closed-2' }),
        closedEvent({ id: 'closed-3' }),
      ],
      candleWatermarkMs: Date.parse('2026-05-07T01:00:00.000Z'),
    })

    expect(report).toMatchObject({
      status: 'watch_waiting_for_label',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      ledger: {
        pendingOpenEvents: 1,
        dueOpenEventsWithoutClose: 0,
        nextLabelDueTime: '2026-05-07T08:45:00.000Z',
      },
      readiness: {
        okxFresh: true,
        pitReady: true,
        pitAuditPass: true,
        hasPendingOpen: true,
        hasDueUnsettled: false,
        candleDataCanSettleNextDue: false,
      },
      artifacts: {
        prospectiveEvidence: {
          closedOutcomes: 3,
        },
      },
    })
    expect(report.blockers).toEqual([])
    expect(report.evidenceBlockers).toContain('prospective_closed_outcomes_low:3<100')
    expect(report.recommendedCommands).toEqual([
      'corepack pnpm research:eth-carry:prospective-evidence:status',
      'corepack pnpm research:eth-carry:prospective-watchdog',
    ])
    expect(report.nextActions).toContain('Continue future-only capture/settle until closed outcomes reach 100; current=3/100.')
  })

  it('requires settlement when an open observation is due and 5m candles can settle it', () => {
    const report = buildReport({
      asOf: '2026-05-07T09:00:00.000Z',
      ledgerEvents: [
        openEvent({
          id: 'due-1',
          decisionTime: '2026-05-07T00:45:00.000Z',
          labelDueTime: '2026-05-07T08:45:00.000Z',
        }),
      ],
      candleWatermarkMs: Date.parse('2026-05-07T08:45:00.000Z'),
    })

    expect(report).toMatchObject({
      status: 'action_required',
      ledger: {
        pendingOpenEvents: 0,
        dueOpenEventsWithoutClose: 1,
      },
      readiness: {
        hasPendingOpen: false,
        hasDueUnsettled: true,
        candleDataCanSettleNextDue: true,
      },
    })
    expect(report.blockers).toEqual([])
    expect(report.recommendedCommands).toEqual(expect.arrayContaining([
      'corepack pnpm research:eth-carry:prospective-observation:settle',
      'corepack pnpm research:eth-carry:prospective-observation:capture',
      'corepack pnpm research:eth-carry:prospective-evidence:status',
      'corepack pnpm research:eth-carry:prospective-watchdog',
    ]))
    expect(report.nextActions).toContain('Handle settle_due_open_events:1.')
  })

  it('fails closed if any input artifact accidentally authorizes execution', () => {
    const report = buildReport({
      asOf: '2026-05-07T01:00:00.000Z',
      prospectiveOverride: {
        promotionEligible: true,
        paperTradingAllowed: true,
        liveTradingAllowed: true,
        executionAllowed: true,
      },
      ledgerEvents: [
        openEvent({
          id: 'open-1',
          decisionTime: '2026-05-07T00:45:00.000Z',
          labelDueTime: '2026-05-07T08:45:00.000Z',
        }),
      ],
      candleWatermarkMs: Date.parse('2026-05-07T01:00:00.000Z'),
    })

    expect(report.status).toBe('blocked')
    expect(report.blockers).toContain('prospective_evidence_must_not_authorize_execution')
    expect(report.promotionEligible).toBe(false)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.executionAllowed).toBe(false)
    expect(report.nextActions).toContain('Fix watchdog blockers before relying on ETH carry prospective cadence.')
  })

  it('treats recent BTC and ETH OKX snapshot cache rows as fresh when latest report is partial', () => {
    const report = buildReport({
      asOf: '2026-05-08T01:40:00.000Z',
      okxSnapshotOverride: {
        generatedAt: '2026-05-08T01:39:00.000Z',
        status: 'partial',
        counts: {
          rowsBuilt: 1,
          rowsAppended: 1,
          duplicateRows: 0,
          errors: 1,
        },
        blockers: ['okx_carry_snapshot_rows_missing:1<2', 'okx_carry_snapshot_errors:1'],
        errors: [{ symbol: 'BTCUSDT', errorClass: 'tls' }],
      },
      okxSnapshotRows: [
        okxSnapshotCacheRow({ symbol: 'BTCUSDT', availableAt: '2026-05-08T01:16:03.830Z' }),
        okxSnapshotCacheRow({ symbol: 'ETHUSDT', availableAt: '2026-05-08T01:27:14.146Z' }),
      ],
      ledgerEvents: [
        openEvent({
          id: 'open-1',
          decisionTime: '2026-05-08T01:35:00.000Z',
          labelDueTime: '2026-05-08T09:35:00.000Z',
        }),
      ],
      candleWatermarkMs: Date.parse('2026-05-08T01:35:00.000Z'),
    })

    expect(report.readiness.okxFresh).toBe(true)
    expect(report.status).toBe('watch_waiting_for_label')
    expect(report.blockers).not.toContain('okx_carry_snapshot_not_fresh')
    expect(report.artifacts.okxSnapshot).toMatchObject({
      status: 'complete',
      rowsBuilt: 2,
      errorCount: 0,
      reportRowsBuilt: 1,
      reportErrorCount: 1,
      reportBlockers: ['okx_carry_snapshot_rows_missing:1<2', 'okx_carry_snapshot_errors:1'],
      cacheRows: 2,
      cacheSymbols: ['BTCUSDT', 'ETHUSDT'],
      cacheLatestAvailableAt: '2026-05-08T01:27:14.146Z',
      cacheFallbackUsed: true,
    })
  })

  it('keeps okxFresh false when OKX cache is stale or missing one symbol', () => {
    const report = buildReport({
      asOf: '2026-05-08T01:40:00.000Z',
      okxSnapshotOverride: {
        generatedAt: '2026-05-08T01:39:00.000Z',
        status: 'partial',
        counts: {
          rowsBuilt: 1,
          rowsAppended: 1,
          duplicateRows: 0,
          errors: 1,
        },
        blockers: ['okx_carry_snapshot_rows_missing:1<2'],
      },
      okxSnapshotRows: [
        okxSnapshotCacheRow({ symbol: 'ETHUSDT', availableAt: '2026-05-08T01:27:14.146Z' }),
        okxSnapshotCacheRow({ symbol: 'BTCUSDT', availableAt: '2026-05-07T12:00:00.000Z' }),
      ],
      ledgerEvents: [
        openEvent({
          id: 'open-1',
          decisionTime: '2026-05-08T01:35:00.000Z',
          labelDueTime: '2026-05-08T09:35:00.000Z',
        }),
      ],
      candleWatermarkMs: Date.parse('2026-05-08T01:35:00.000Z'),
    })

    expect(report.readiness.okxFresh).toBe(false)
    expect(report.status).toBe('blocked')
    expect(report.blockers).toContain('okx_carry_snapshot_not_fresh')
    expect(report.artifacts.okxSnapshot).toMatchObject({
      status: 'partial',
      rowsBuilt: 1,
      errorCount: 1,
      cacheRows: 1,
      cacheSymbols: ['ETHUSDT'],
      cacheFallbackUsed: false,
    })
  })
})

function buildReport(input: {
  asOf: string
  ledgerEvents: Array<Record<string, unknown>>
  candleWatermarkMs: number
  okxSnapshotOverride?: Record<string, unknown>
  okxSnapshotRows?: Array<Record<string, unknown>>
  prospectiveOverride?: Record<string, unknown>
}) {
  const asOfMs = Date.parse(input.asOf)
  const args = parseEthCarryProspectiveWatchdogArgs([
    '--output',
    'none',
    '--asOf',
    input.asOf,
  ])
  return buildEthCarryProspectiveWatchdogReport({
    generatedAt: input.asOf,
    asOfMs,
    args,
    okxSnapshot: {
      generatedAt: input.asOf,
      status: 'complete',
      blockers: [],
      counts: {
        rowsBuilt: 2,
        rowsAppended: 2,
        duplicateRows: 0,
        errors: 0,
      },
      errors: [],
      ...input.okxSnapshotOverride,
    },
    okxSnapshotRows: input.okxSnapshotRows ?? [],
    pitFeatures: {
      generatedAt: input.asOf,
      status: 'ready_for_research',
      blockers: [],
      counts: {
        carryFeatureRows: 55056,
      },
      carryFeatureRows: [{
        decisionAvailableAtMs: Date.parse('2026-05-07T00:42:49.601Z'),
      }],
    },
    pitAudit: {
      generatedAt: input.asOf,
      status: 'pass',
      blockers: [],
      counts: {
        passingRows: 55056,
        failingRows: 0,
      },
    },
    capture: {
      generatedAt: input.asOf,
      status: 'captured',
      blockers: [],
      counts: {
        observationsBuilt: 1,
        appendedObservations: 1,
        skippedAlreadyDueObservations: 0,
      },
    },
    settle: {
      generatedAt: input.asOf,
      status: 'skipped_no_due',
      blockers: [],
      counts: {
        dueOpenEvents: 0,
        outcomesBuilt: 0,
        appendedOutcomes: 0,
        missingCloseCandles: 0,
      },
    },
    prospective: {
      generatedAt: input.asOf,
      status: 'has_closed_labels',
      blockers: [
        'research_only_not_execution_evidence',
        'paper_live_execution_disabled',
        'prospective_closed_outcomes_low:3<100',
      ],
      counts: {
        pendingOpenEvents: 1,
        dueOpenEventsWithoutClose: 0,
      },
      metrics: {
        closedOutcomes: 3,
      },
      latestOpen: {
        labelDueTime: '2026-05-07T08:45:00.000Z',
      },
      ...input.prospectiveOverride,
    },
    dataGap: {
      generatedAt: input.asOf,
      status: 'blocked_insufficient_research_data',
      blockers: ['prospective_closed_outcomes_low:3<100'],
      counts: {
        carryFeatureRows: 55056,
        prospectiveClosedOutcomes: 3,
        prospectiveClosedOutcomeShortfall: 97,
        collectorErrorCount: 0,
        okxCarrySnapshotRowsBuilt: 2,
      },
    },
    ledgerEvents: input.ledgerEvents,
    candleWatermark: {
      dataDir: '/tmp/openalice-watchdog-5m',
      ethLatest: new Date(input.candleWatermarkMs).toISOString(),
      btcLatest: new Date(input.candleWatermarkMs).toISOString(),
      minLatest: new Date(input.candleWatermarkMs).toISOString(),
      minLatestMs: input.candleWatermarkMs,
    },
  })
}

function openEvent(input: {
  id: string
  decisionTime: string
  labelDueTime: string
}): Record<string, unknown> {
  return {
    eventType: 'eth_carry_prospective_decision_open',
    observationId: input.id,
    decisionTime: input.decisionTime,
    decisionBarTime: Date.parse(input.decisionTime),
    labelDueTime: input.labelDueTime,
    labelDueBarTime: Date.parse(input.labelDueTime),
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
  }
}

function closedEvent(input: { id: string }): Record<string, unknown> {
  return {
    eventType: 'eth_carry_prospective_decision_closed',
    observationId: input.id,
    decisionTime: '2026-05-06T01:00:00.000Z',
    decisionBarTime: Date.parse('2026-05-06T01:00:00.000Z'),
    labelDueTime: '2026-05-06T09:00:00.000Z',
    labelDueBarTime: Date.parse('2026-05-06T09:00:00.000Z'),
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
  }
}

function okxSnapshotCacheRow(input: { symbol: 'BTCUSDT' | 'ETHUSDT'; availableAt: string }): Record<string, unknown> {
  return {
    schemaVersion: 'openalice.external_derivatives.normalized.v1',
    eventTime: input.availableAt,
    eventTimeMs: Date.parse(input.availableAt),
    exchange: 'okx',
    market: 'swap',
    symbol: input.symbol,
    endpointId: 'okxCarrySnapshot',
    sourceEndpoint: '/api/v5/public/okx-carry-snapshot',
    sourceTimestamp: input.availableAt,
    sourceTimestampMs: Date.parse(input.availableAt),
    sourceTimestampBasis: 'exchange_snapshot_max_ts',
    fetchedAt: input.availableAt,
    observedAt: input.availableAt,
    availableAt: input.availableAt,
    ingestedAt: input.availableAt,
    jobId: `job-${input.symbol}`,
    generatedAt: input.availableAt,
    lineageStatus: 'explicit_row_lineage',
    dedupKey: `okx|swap|okxCarrySnapshot|${input.symbol}|${Date.parse(input.availableAt)}`,
    rawPayloadHash: `hash-${input.symbol}`,
    collectionRunId: `job-${input.symbol}`,
    reportPath: '/repo/data/runtime/okx_carry_snapshot_collect.latest.json',
    manifestPath: '/repo/okx_rows.jsonl.manifest.json',
    normalizedPayloadHash: `normalized-${input.symbol}`,
    fields: {
      markPrice: input.symbol === 'BTCUSDT' ? 79618.5 : 2283.66,
      indexPrice: input.symbol === 'BTCUSDT' ? 79650.6 : 2284,
      fundingRate: input.symbol === 'BTCUSDT' ? 0.000029 : 0.0001,
      nextFundingTime: Date.parse('2026-05-08T08:00:00.000Z'),
    },
  }
}
