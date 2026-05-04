import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEvidenceManifest } from '../src/runtime/evidence_manifest.js'
import {
  buildMicrostructureStoplossClusterReviewReport,
  parseMicrostructureStoplossClusterReviewArgs,
  renderMicrostructureStoplossClusterReviewMarkdown,
  runMicrostructureStoplossClusterReview,
} from './build_microstructure_stoploss_cluster_review.js'
import { buildMicrostructureStoplossReplayReport } from './run_microstructure_stoploss_replay.js'
import type { MicrostructureStoplossReplayReport } from './run_microstructure_stoploss_replay.js'
import type { NormalizedPaperTrade } from './analyze_paper_pnl.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'microstructure-stoploss-cluster-review-'))
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('build_microstructure_stoploss_cluster_review', () => {
  it('parses CLI args with defensive defaults', () => {
    expect(parseMicrostructureStoplossClusterReviewArgs([])).toEqual({
      inputPath: 'data/runtime/microstructure_stoploss_replay.latest.json',
      outputPath: 'data/runtime/microstructure_stoploss_cluster_review.latest.json',
      maxClusters: 25,
      minClosedTrades: 20,
      minStopLossTrades: 5,
      minStopLossLossSharePct: 40,
      json: false,
    })
    expect(parseMicrostructureStoplossClusterReviewArgs([
      '--input',
      'tmp/replay.json',
      '--outputPath',
      'null',
      '--maxClusters',
      '7',
      '--minClosedTrades',
      '10',
      '--minStopLossTrades',
      '3',
      '--minStopLossLossSharePct',
      '55',
      '--json',
      'true',
    ])).toEqual({
      inputPath: 'tmp/replay.json',
      outputPath: null,
      maxClusters: 7,
      minClosedTrades: 10,
      minStopLossTrades: 3,
      minStopLossLossSharePct: 55,
      json: true,
    })
  })

  it('builds a diagnostic-only kill-candidate review from replay clusters', () => {
    const replay = replayFixture()
    const raw = `${JSON.stringify(replay, null, 2)}\n`
    const report = buildMicrostructureStoplossClusterReviewReport({
      sourceReport: replay,
      sourceReportPath: '/repo/data/runtime/replay.latest.json',
      sourceReportRaw: raw,
      sourceManifest: buildEvidenceManifest({
        job: 'microstructure_stoploss_replay',
        artifactPath: '/repo/data/runtime/replay.latest.json',
        startedAt: '2026-05-02T00:00:00.000Z',
        finishedAt: '2026-05-02T00:00:01.000Z',
        exitCode: 0,
        gitSnapshot: {
          commit: 'abc',
          dirty: false,
          dirtyFilesCount: 0,
          dirtyHash: 'clean',
        },
        artifactHash: sha256Hex(raw),
      }),
      sourceManifestPath: '/repo/data/runtime/replay.latest.json.manifest.json',
      maxClusters: 10,
      generatedAt: '2026-05-02T00:00:02.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-02T00:00:02.000Z',
      diagnosticOnly: true,
      promotionEligible: false,
      policyMutationAllowed: false,
      sourceArtifactHash: sha256Hex(raw),
      sourceManifest: {
        present: true,
        artifactHash: sha256Hex(raw),
        hashMatchesSourceReport: true,
        evidenceTrust: 'pass',
        dqStatus: 'pass',
      },
      coverage: {
        sourceClusters: replay.clusterDiagnostics.length,
        killCandidates: expect.any(Number),
        shadowDownweightCandidates: expect.any(Number),
      },
    })
    expect(report.notes.join(' ')).toContain('must not mutate strategy')

    const doge = report.clusters.find(item => item.dimension === 'symbol' && item.key === 'DOGE-USDT')
    expect(doge).toMatchObject({
      diagnosticUse: 'closed_row_cluster_review',
      promotionEligible: false,
      policyMutationAllowed: false,
      recommendedReviewAction: 'shadow_downweight_candidate',
      killCandidate: true,
      closedTrades: 21,
      stopLossTrades: 6,
      baselinePF: expect.any(Number),
      stopLossLossSharePct: expect.any(Number),
    })
    expect(doge?.baselineTotalPnlPct).toBeCloseTo(-11.1, 6)
    expect(doge?.cap25DeltaPct).toBeCloseTo(8.325, 6)
    expect(doge?.cap10DeltaPct).toBeCloseTo(9.99, 6)
    expect(doge?.stressStopLossDeltaPct).toBeCloseTo(-6, 6)
    expect(doge?.killReason).toEqual([
      'closed_trades>=20',
      'stop_loss_trades>=5',
      'baseline_total_pnl_pct<0',
      'baseline_pf<1',
      'stop_loss_loss_share_pct>=40',
    ])

    const thin = report.clusters.find(item => item.dimension === 'symbol' && item.key === 'THIN-USDT')
    expect(thin).toMatchObject({
      recommendedReviewAction: 'insufficient_sample',
      killCandidate: false,
      reviewReason: expect.arrayContaining(['closed_trades<20']),
    })
    expect(report.clusters[0]).toMatchObject({
      killCandidate: true,
      stopLossTrades: expect.any(Number),
    })
  })

  it('keeps source manifest mismatch visible instead of upgrading trust', () => {
    const replay = replayFixture()
    const raw = `${JSON.stringify(replay, null, 2)}\n`
    const report = buildMicrostructureStoplossClusterReviewReport({
      sourceReport: replay,
      sourceReportPath: '/repo/data/runtime/replay.latest.json',
      sourceReportRaw: raw,
      sourceManifest: buildEvidenceManifest({
        job: 'microstructure_stoploss_replay',
        artifactPath: '/repo/data/runtime/replay.latest.json',
        startedAt: '2026-05-02T00:00:00.000Z',
        finishedAt: '2026-05-02T00:00:01.000Z',
        exitCode: 0,
        gitSnapshot: {
          commit: 'abc',
          dirty: false,
          dirtyFilesCount: 0,
          dirtyHash: 'clean',
        },
        artifactHash: 'not-the-source-hash',
      }),
      maxClusters: 2,
    })

    expect(report.sourceManifest).toMatchObject({
      present: true,
      artifactHash: 'not-the-source-hash',
      hashMatchesSourceReport: false,
    })
    expect(report.notes.join(' ')).toContain('hashMatchesSourceReport=false')
  })

  it('writes latest review artifact and sidecar manifest with matching hash', async () => {
    const root = await tempRoot()
    const replayPath = join(root, 'replay.latest.json')
    const outputPath = join(root, 'cluster_review.latest.json')
    const replay = replayFixture()
    const replayRaw = `${JSON.stringify(replay, null, 2)}\n`
    await writeFile(replayPath, replayRaw, 'utf-8')
    const replayManifest = buildEvidenceManifest({
      job: 'microstructure_stoploss_replay',
      artifactPath: replayPath,
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:01.000Z',
      exitCode: 0,
      artifactHash: sha256Hex(replayRaw),
    })
    await writeFile(`${replayPath}.manifest.json`, `${JSON.stringify(replayManifest, null, 2)}\n`, 'utf-8')

    const report = await runMicrostructureStoplossClusterReview({
      inputPath: replayPath,
      outputPath,
      maxClusters: 5,
      minClosedTrades: 20,
      minStopLossTrades: 5,
      minStopLossLossSharePct: 40,
      json: true,
    })

    expect(report.coverage.reviewedClusters).toBeGreaterThan(0)
    const persistedRaw = await readFile(outputPath, 'utf-8')
    const persisted = JSON.parse(persistedRaw)
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(persisted).toMatchObject({
      diagnosticOnly: true,
      promotionEligible: false,
      policyMutationAllowed: false,
      sourceManifest: {
        hashMatchesSourceReport: true,
      },
    })
    expect(manifest).toMatchObject({
      job: 'microstructure_stoploss_cluster_review',
      artifactPath: outputPath,
      recordsIn: replay.clusterDiagnostics.length,
      recordsOut: report.coverage.reviewedClusters,
      businessStatus: 'warn',
      errorClass: 'microstructure_stoploss_kill_candidates',
    })
    expect(manifest.artifactHash).toBe(sha256Hex(persistedRaw))
  })

  it('renders a compact markdown review table', () => {
    const replay = replayFixture()
    const report = buildMicrostructureStoplossClusterReviewReport({
      sourceReport: replay,
      sourceReportPath: '/repo/replay.json',
      maxClusters: 10,
      generatedAt: '2026-05-02T00:00:02.000Z',
    })

    const markdown = renderMicrostructureStoplossClusterReviewMarkdown(report)

    expect(markdown).toContain('# Microstructure Stop-Loss Cluster Review')
    expect(markdown).toContain('Diagnostic only: `true`')
    expect(markdown).toContain('Policy mutation allowed: `false`')
    expect(markdown).toContain('shadow_downweight_candidate')
    expect(markdown).toContain('DOGE-USDT')
  })
})

function replayFixture(): MicrostructureStoplossReplayReport {
  return buildMicrostructureStoplossReplayReport({
    paperDir: '/repo/data/paper_trading',
    outputPath: '/repo/data/runtime/replay.latest.json',
    closedTradesLoaded: 39,
    generatedAt: '2026-05-02T00:00:00.000Z',
    trades: [
      ...Array.from({ length: 6 }, (_, index) => makeTrade({
        tradeId: `doge-sl-${index}`,
        symbol: 'DOGE-USDT',
        closeReason: 'stop_loss',
        pnlPct: -2,
      })),
      ...Array.from({ length: 15 }, (_, index) => makeTrade({
        tradeId: `doge-win-${index}`,
        symbol: 'DOGE-USDT',
        closeReason: index < 4 ? 'take_profit' : 'holding_expired',
        pnlPct: index < 4 ? 0.5 : -0.1,
      })),
      ...Array.from({ length: 8 }, (_, index) => makeTrade({
        tradeId: `thin-sl-${index}`,
        symbol: 'THIN-USDT',
        closeReason: 'stop_loss',
        pnlPct: -1,
      })),
      ...Array.from({ length: 10 }, (_, index) => makeTrade({
        tradeId: `btc-win-${index}`,
        symbol: 'BTC-USDT',
        closeReason: 'take_profit',
        pnlPct: 0.3,
      })),
    ],
  })
}

function makeTrade(overrides: Partial<NormalizedPaperTrade>): NormalizedPaperTrade {
  return {
    tradeId: overrides.tradeId ?? 'trade',
    source: 'test',
    lane: overrides.lane ?? 'microstructure_100x',
    accountId: 'liquidation_probe_100x',
    accountLabel: 'Liquidation probe 100x',
    symbol: overrides.symbol ?? 'DOGE-USDT',
    side: overrides.side ?? 'long',
    leverage: overrides.leverage ?? 100,
    openTs: overrides.openTs ?? '2026-05-01T00:00:00.000Z',
    closeTs: overrides.closeTs ?? '2026-05-01T00:01:00.000Z',
    openPrice: overrides.openPrice ?? 1,
    closePrice: overrides.closePrice ?? 0.99,
    pnlPct: overrides.pnlPct ?? 0,
    pnlUsd: overrides.pnlUsd ?? null,
    closeReason: overrides.closeReason ?? 'holding_expired',
    rawReason: overrides.rawReason ?? overrides.closeReason ?? null,
    holdingSeconds: overrides.holdingSeconds ?? 60,
    closeHourUtc: overrides.closeHourUtc ?? 0,
    priceSource: overrides.priceSource ?? '1s',
    priceStale: overrides.priceStale ?? false,
    volumeRatioAtOpen: overrides.volumeRatioAtOpen ?? null,
    breakQualityAtOpen: overrides.breakQualityAtOpen ?? null,
    liquidityStatusAtOpen: overrides.liquidityStatusAtOpen ?? null,
    spreadStatusAtOpen: overrides.spreadStatusAtOpen ?? null,
    spreadBpsAtOpen: overrides.spreadBpsAtOpen ?? null,
    contextGenerationAtOpen: overrides.contextGenerationAtOpen ?? 1,
    flashConfidenceLowAtOpen: overrides.flashConfidenceLowAtOpen ?? null,
    ruleScoreAtOpen: overrides.ruleScoreAtOpen ?? null,
    proEpochAtOpen: overrides.proEpochAtOpen ?? null,
    marketIntelTriggerAtOpen: overrides.marketIntelTriggerAtOpen ?? null,
    contextCoverageBucket: overrides.contextCoverageBucket ?? 'ok',
    liquidated: overrides.liquidated ?? false,
  }
}
