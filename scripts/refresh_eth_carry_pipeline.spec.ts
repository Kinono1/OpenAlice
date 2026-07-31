import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPipelinePlan,
  extractLastNonEmptyLine,
  parseArgs,
  refreshEthCarryPipeline,
} from './refresh_eth_carry_pipeline.ts'

describe('refresh_eth_carry_pipeline', () => {
  it('defaults to dry-run planning without runtime publish', () => {
    expect(parseArgs([])).toMatchObject({
      ethFundingPath: 'data/research/derivatives_history/okx_ETH_USDT_USDT_funding_history.json',
      btcFundingPath: 'data/research/derivatives_history/okx_BTC_USDT_USDT_funding_history.json',
      dryRun: true,
      publishRuntimeTargets: false,
    })
    expect(parseArgs(['--dryRun', 'false', '--publishRuntimeTargets', 'true'])).toMatchObject({
      dryRun: false,
      publishRuntimeTargets: true,
    })
  })

  it('builds the expected control, shadow, bundle, status, and runtime-publish plan', () => {
    const plan = buildPipelinePlan({
      ethFundingPath: '/tmp/eth.json',
      btcFundingPath: '/tmp/btc.json',
      lookbackBars: 6000,
      trainBars: 3600,
      testBars: 1200,
      stepBars: 480,
      riskSimulationCount: 200,
      paperTargetBasisEquityUsd: 10000,
      bundleName: 'eth_carry_runtime_publish',
      snapshotBaseDir: 'data/runtime/eth_carry_status',
      publishRuntimeTargets: true,
      dryRun: false,
    })

    expect(plan.validation.script).toBe('scripts/run_eth_carry_validation.ts')
    expect(plan.shortBiasValidation.script).toBe('scripts/run_eth_carry_short_bias_validation.ts')
    expect(plan.validation.args).toEqual(plan.shortBiasValidation.args)
    expect(plan.pairShadowValidation.script).toBe('scripts/run_eth_carry_short_bias_pair_shadow_validation.ts')
    expect(plan.pairShadowValidation.args).toEqual([
      '--ethFundingPath',
      '/tmp/eth.json',
      '--btcFundingPath',
      '/tmp/btc.json',
      '--lookbackBars',
      '6000',
      '--trainBars',
      '3600',
      '--testBars',
      '1200',
      '--stepBars',
      '480',
      '--riskSimulationCount',
      '200',
    ])
    expect(plan.bundle.script).toBe('scripts/publish_eth_carry_runtime_bundle.ts')
    expect(plan.bundle.args).toEqual([
      '--bundleName',
      'eth_carry_runtime_publish',
      '--publishRuntimeTargets',
      'false',
    ])
    expect(plan.status.script).toBe('scripts/refresh_eth_carry_runtime_status.ts')
    expect(plan.status.args).toEqual([
      '--snapshotBaseDir',
      'data/runtime/eth_carry_status',
      '--basisEquityUsd',
      '10000',
      '--applyNewsOverlayToDefaultTarget',
      'false',
    ])
    expect(plan.publishRuntime).toEqual({
      script: 'scripts/publish_eth_carry_runtime_bundle.ts',
      args: ['--bundleName', 'eth_carry_runtime_publish', '--publishRuntimeTargets', 'true'],
    })
  })

  it('extracts the last non-empty line from script stdout', () => {
    expect(extractLastNonEmptyLine('\nfoo\n/bar/baz.json\n')).toBe('/bar/baz.json')
  })

  it('feeds bundle-generated artifact paths into the status refresh step before runtime publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eth-carry-pipeline-'))
    const calls: Array<{ script: string; args: string[] }> = []
    const controlArtifactDir = join(root, 'control')
    const shadowArtifactDir = join(root, 'shadow')
    const pairShadowArtifactDir = join(root, 'pair-shadow')
    const controlSummaryPath = join(controlArtifactDir, 'eth_carry_summary.json')
    const shadowSummaryPath = join(shadowArtifactDir, 'eth_carry_short_bias_summary.json')
    const pairShadowSummaryPath = join(pairShadowArtifactDir, 'eth_carry_short_bias_pair_shadow_summary.json')
    const bundleDir = join(root, 'bundle')
    const statusSummaryPath = join(root, 'status/eth_carry_runtime_status.json')
    const shadowComparisonPath = join(root, 'status/eth_carry_shadow_comparison.json')

    await mkdir(controlArtifactDir, { recursive: true })
    await mkdir(shadowArtifactDir, { recursive: true })
    await mkdir(pairShadowArtifactDir, { recursive: true })
    await mkdir(bundleDir, { recursive: true })
    await mkdir(join(root, 'status'), { recursive: true })

    const mockRunner = async (script: string, scriptArgs: string[]): Promise<string> => {
      calls.push({ script, args: scriptArgs })

      if (script === 'scripts/run_eth_carry_validation.ts') {
        await writeFile(
          controlSummaryPath,
          `${JSON.stringify({
            selectedParams: { id: 'carry_24h_z13' },
            selectedMetrics: {
              tradeCount: 369,
              netExpectancyPct: 0.0005,
            },
            trades: [
              { netReturnPct: 0.02, exitTime: 1710000000000 - 90 * 24 * 60 * 60 * 1000 },
              { netReturnPct: -0.03, exitTime: 1710000000000 - 10 * 24 * 60 * 60 * 1000 },
              { netReturnPct: 0.01, exitTime: 1710000000000 - 1 * 24 * 60 * 60 * 1000 },
            ],
            releaseGate: {
              allowPaperTrading: true,
            },
            significance: {
              passed: false,
              pboResult: { pbo: 0.12 },
            },
          }, null, 2)}\n`,
          'utf-8',
        )
        return controlSummaryPath
      }

      if (script === 'scripts/run_eth_carry_short_bias_validation.ts') {
        await writeFile(
          shadowSummaryPath,
          `${JSON.stringify({
            selectedParams: { id: 'carry_short_bias_soft' },
            selectedMetrics: {
              tradeCount: 420,
              netExpectancyPct: 0.018,
            },
            trades: [
              { netReturnPct: 0.05, exitTime: 1710000000000 - 90 * 24 * 60 * 60 * 1000 },
              { netReturnPct: 0.03, exitTime: 1710000000000 - 10 * 24 * 60 * 60 * 1000 },
              { netReturnPct: 0.02, exitTime: 1710000000000 - 1 * 24 * 60 * 60 * 1000 },
            ],
            releaseGate: {
              allowPaperTrading: true,
            },
            significance: {
              passed: true,
              pboResult: { pbo: 0.04 },
            },
            topCandidates: [
              {
                recent90dTradeCount: 12,
                errorRate: 0.18,
                recent90dErrorRate: 0.14,
                netExpectancyPct: 0.018,
                tradeCount: 420,
                pbo: 0.04,
                dsrValue: 0.91,
                wfoPassed: true,
                failedWindows: 0,
                paper: true,
              },
            ],
          }, null, 2)}\n`,
          'utf-8',
        )
        return shadowSummaryPath
      }

      if (script === 'scripts/run_eth_carry_short_bias_pair_shadow_validation.ts') {
        await writeFile(
          pairShadowSummaryPath,
          `${JSON.stringify({
            selectedParams: { id: 'carry_short_bias_fast_confirm' },
            selectedMetrics: {
              tradeCount: 25,
              netExpectancyPct: 0.02098,
            },
            releaseGate: {
              allowPaperTrading: true,
              allowLiveTrading: true,
            },
          }, null, 2)}\n`,
          'utf-8',
        )
        return pairShadowSummaryPath
      }

      if (script === 'scripts/publish_eth_carry_runtime_bundle.ts') {
        const outputDir = scriptArgs.includes('--outputDir')
          ? scriptArgs[scriptArgs.indexOf('--outputDir') + 1]
          : bundleDir
        await mkdir(outputDir, { recursive: true })
        await writeFile(
          join(outputDir, 'strategy_validation_runs.json'),
          `${JSON.stringify({ source: 'bundle-validation-runs' }, null, 2)}\n`,
          'utf-8',
        )
        await writeFile(
          join(outputDir, 'experiment_verdict.v2.json'),
          `${JSON.stringify({ source: 'bundle-verdict' }, null, 2)}\n`,
          'utf-8',
        )
        await writeFile(
          join(outputDir, 'release_gate_status.json'),
          `${JSON.stringify({ source: 'bundle-release-gate' }, null, 2)}\n`,
          'utf-8',
        )
        await writeFile(
          join(outputDir, 'paper_champion_registry.json'),
          `${JSON.stringify({ source: 'bundle-registry' }, null, 2)}\n`,
          'utf-8',
        )
        await writeFile(
          join(outputDir, 'paper_portfolio_target.json'),
          `${JSON.stringify({
            version: 1,
            generatedAt: '2026-04-15T00:00:00.000Z',
            basisEquityUsd: 10_000,
            targetGrossExposure: 0,
            targetNetExposure: 0,
            maxTurnoverPct: 1,
            positions: [],
          }, null, 2)}\n`,
          'utf-8',
        )
        return outputDir
      }

      if (script === 'scripts/refresh_eth_carry_runtime_status.ts') {
        const validationRunsPath = scriptArgs[scriptArgs.indexOf('--validationRunsPath') + 1]
        const verdictPath = scriptArgs[scriptArgs.indexOf('--verdictPath') + 1]
        const releaseGateStatusPath = scriptArgs[scriptArgs.indexOf('--releaseGateStatusPath') + 1]
        const registryPath = scriptArgs[scriptArgs.indexOf('--registryPath') + 1]
        const portfolioTargetPath = scriptArgs[scriptArgs.indexOf('--portfolioTargetPath') + 1]
        await writeFile(
          statusSummaryPath,
          `${JSON.stringify({
            generatedAt: '2026-04-15T00:00:00.000Z',
            inputPaths: {
              validationRunsPath,
              verdictPath,
              releaseGateStatusPath,
              registryPath,
              canonicalPortfolioTargetPath: portfolioTargetPath,
            },
            currentState: 'flat_because_no_signal',
          }, null, 2)}\n`,
          'utf-8',
        )
        return statusSummaryPath
      }

      return bundleDir
    }

    const cliArgs = {
      ethFundingPath: '/tmp/eth.json',
      btcFundingPath: '/tmp/btc.json',
      lookbackBars: 6000,
      trainBars: 3600,
      testBars: 1200,
      stepBars: 480,
      riskSimulationCount: 200,
      paperTargetBasisEquityUsd: 10000,
      bundleName: 'eth_carry_runtime_publish',
      snapshotBaseDir: `${root}/status`,
      publishRuntimeTargets: true,
      dryRun: false,
    }

    const pipelineResult = await refreshEthCarryPipeline(
      cliArgs,
      buildPipelinePlan(cliArgs),
      mockRunner,
    )

    expect(calls.map((call) => call.script)).toEqual([
      'scripts/run_eth_carry_validation.ts',
      'scripts/run_eth_carry_short_bias_validation.ts',
      'scripts/run_eth_carry_short_bias_pair_shadow_validation.ts',
      'scripts/publish_eth_carry_runtime_bundle.ts',
      'scripts/refresh_eth_carry_runtime_status.ts',
      'scripts/publish_eth_carry_runtime_bundle.ts',
    ])

    const statusCall = calls[4]
    expect(statusCall?.args).toEqual([
      '--snapshotBaseDir',
      `${root}/status`,
      '--basisEquityUsd',
      '10000',
      '--applyNewsOverlayToDefaultTarget',
      'false',
      '--validationRunsPath',
      `${bundleDir}/strategy_validation_runs.json`,
      '--verdictPath',
      `${bundleDir}/experiment_verdict.v2.json`,
      '--releaseGateStatusPath',
      `${bundleDir}/release_gate_status.json`,
      '--registryPath',
      `${bundleDir}/paper_champion_registry.json`,
      '--portfolioTargetPath',
      `${bundleDir}/paper_portfolio_target.json`,
      '--controlArtifactDir',
      controlArtifactDir,
      '--shadowArtifactDir',
      shadowArtifactDir,
      '--pairShadowArtifactDir',
      pairShadowArtifactDir,
      '--shadowComparisonPath',
      shadowComparisonPath,
    ])

    const statusPayload = JSON.parse(await readFile(statusSummaryPath, 'utf-8')) as {
      inputPaths: Record<string, string>
      currentState: string
    }
    expect(statusPayload.currentState).toBe('flat_because_no_signal')
    expect(statusPayload.inputPaths).toMatchObject({
      validationRunsPath: `${bundleDir}/strategy_validation_runs.json`,
      verdictPath: `${bundleDir}/experiment_verdict.v2.json`,
      releaseGateStatusPath: `${bundleDir}/release_gate_status.json`,
      registryPath: `${bundleDir}/paper_champion_registry.json`,
      canonicalPortfolioTargetPath: `${bundleDir}/paper_portfolio_target.json`,
    })

    expect(pipelineResult.bundleDir).toBe(bundleDir)
    expect(pipelineResult.statusSummaryPath).toBe(statusSummaryPath)
    expect(pipelineResult.publishedArtifactDir).toBe(shadowArtifactDir)
  })
})
