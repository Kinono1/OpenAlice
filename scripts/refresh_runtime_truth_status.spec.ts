import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseRuntimeTruthStatusRefreshArgs,
  runRuntimeTruthStatusRefresh,
} from './refresh_runtime_truth_status.js'

describe('refresh_runtime_truth_status', () => {
  it('parses fail-closed defaults and infers symbols from the portfolio target', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oa-runtime-truth-refresh-parse-'))
    const targetPath = join(tempDir, 'paper_portfolio_target.json')
    await writeFile(targetPath, JSON.stringify({
      version: 1,
      generatedAt: '2026-05-03T00:00:00.000Z',
      basisEquityUsd: 1000,
      targetGrossExposure: 0,
      targetNetExposure: 0,
      maxTurnoverPct: 1,
      positions: [
        { symbol: 'BTC/USDT:USDT', targetWeight: 0, targetNotionalUsd: 0 },
        { symbol: 'ETH/USDT:USDT', targetWeight: 0, targetNotionalUsd: 0 },
      ],
    }))

    const args = await parseRuntimeTruthStatusRefreshArgs([
      '--portfolioTargetPath',
      targetPath,
      '--output',
      'null',
      '--json',
    ])

    expect(args).toMatchObject({
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      requirePromotionV2: true,
      validatePromotionV2Artifacts: true,
      outputPath: null,
      json: true,
    })
  })

  it('writes runtime status snapshots with manifests while keeping execution blocked', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oa-runtime-truth-refresh-'))
    const validationRunsPath = join(tempDir, 'strategy_validation_runs.json')
    const verdictPath = join(tempDir, 'experiment_verdict.v2.json')
    const releaseGateStatusPath = join(tempDir, 'release_gate_status.json')
    const registryPath = join(tempDir, 'paper_champion_registry.json')
    const portfolioTargetPath = join(tempDir, 'paper_portfolio_target.json')
    const runtimePublishStatePath = join(tempDir, 'runtime_publish_state.json')
    const outputPath = join(tempDir, 'runtime_truth_status_refresh.latest.json')

    await writeFile(validationRunsPath, JSON.stringify({
      champion: { strategyId: 'S1' },
      candidates: [
        {
          strategyId: 'S1',
          strategy: 'trend',
          promotionEligible: true,
          admissionIntent: 'promotion',
          runtimeMode: 'real_runtime',
          sourceLineage: 'openalice_native',
        },
      ],
    }))
    await writeFile(verdictPath, JSON.stringify({
      schemaVersion: 'experiment_verdict.v2',
      result: 'NO_GO',
    }))
    await writeFile(releaseGateStatusPath, JSON.stringify({
      version: 1,
      generatedAt: '2026-05-03T00:00:00.000Z',
      allowPaperTrading: false,
      allowLiveTrading: false,
      failedChecks: ['wfo'],
      warningChecks: [],
    }))
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      generatedAt: '2026-05-03T00:00:00.000Z',
      entries: [
        { strategyId: 'S1', strategyFamily: 'trend', symbols: ['BTC/USDT:USDT'] },
      ],
    }))
    await writeFile(portfolioTargetPath, JSON.stringify({
      version: 1,
      generatedAt: '2026-05-03T00:00:00.000Z',
      basisEquityUsd: 1000,
      targetGrossExposure: 0,
      targetNetExposure: 0,
      maxTurnoverPct: 1,
      positions: [
        { symbol: 'BTC/USDT:USDT', targetWeight: 0, targetNotionalUsd: 0 },
      ],
    }))

    const result = await runRuntimeTruthStatusRefresh({
      symbols: ['BTC/USDT:USDT'],
      validationRunsPath,
      verdictPath,
      releaseGateStatusPath,
      registryPath,
      portfolioTargetPath,
      runtimePublishStatePath,
      snapshotBaseDir: tempDir,
      promotionReadinessV2Path: join(tempDir, 'missing_strategy_promotion.latest.json'),
      outputPath,
      requirePromotionV2: true,
      validatePromotionV2Artifacts: true,
      json: true,
    })

    expect(result.mode).toBe('status_refresh_only')
    expect(result.paperExecutionAllowedByScript).toBe(false)
    expect(result.tradingSideEffectsAllowed).toBe(false)
    expect(result.paperAllow).toBe(false)
    expect(result.executionKind).toBe('blocked')
    expect(result.promotionV2.loadStatus).toBe('missing')
    expect(result.blockers).toEqual(expect.arrayContaining([
      'promotion_v2_readiness_missing',
      'paper_executor_disabled',
    ]))

    const paperGate = JSON.parse(
      await readFile(join(tempDir, 'paper_gate_status.json'), 'utf-8'),
    ) as { finalAllowPaperTrading: boolean; paperExecutorEnabled: boolean }
    expect(paperGate.finalAllowPaperTrading).toBe(false)
    expect(paperGate.paperExecutorEnabled).toBe(false)

    for (const file of [
      'paper_gate_status.json',
      'paper_executor_status.latest.json',
      'phase_readiness.latest.json',
      'runtime_truth_status_refresh.latest.json',
    ]) {
      const manifest = JSON.parse(
        await readFile(join(tempDir, `${file}.manifest.json`), 'utf-8'),
      ) as { job: string; artifactHash: string | null }
      expect(manifest.artifactHash).toEqual(expect.any(String))
    }
  })
})
