import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs } from './run_strategy_mvp_validation.ts'

function runStrategyMvpValidation(args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      './node_modules/.bin/tsx',
      ['scripts/run_strategy_mvp_validation.ts', ...args],
      {
        cwd: resolve('.'),
        stdio: 'ignore',
      },
    )

    child.on('close', (code) => {
      if (code == null) {
        reject(new Error('run_strategy_mvp_validation exited without a code'))
        return
      }
      resolvePromise(code)
    })
    child.on('error', reject)
  })
}

async function writeSyntheticMarketCsv(root: string): Promise<string> {
  const path = join(root, 'market.csv')
  const rows = ['timestamp,open,high,low,close,volume']
  let previousClose = 10_000
  for (let index = 0; index < 98; index += 1) {
    const timestamp = 1_700_000_000 + index * 3_600
    const drift = index * 8
    const cycle = Math.sin(index / 8) * 140
    const close = 10_000 + drift + cycle
    const open = previousClose
    const high = Math.max(open, close) + 30
    const low = Math.min(open, close) - 30
    const volume = 1_000 + (index % 24) * 25 + Math.abs(cycle)
    rows.push([
      timestamp,
      open.toFixed(4),
      high.toFixed(4),
      low.toFixed(4),
      close.toFixed(4),
      volume.toFixed(4),
    ].join(','))
    previousClose = close
  }
  await writeFile(path, `${rows.join('\n')}\n`, 'utf-8')
  return path
}

describe('run_strategy_mvp_validation CLI', () => {
  it('defaults to dry-run before writing validation, verdict, or release-gate artifacts', () => {
    expect(parseArgs([]).dryRun).toBe(true)
    expect(parseArgs(['--dryRun', 'false']).dryRun).toBe(false)
  })

  it('hard-blocks low-sample DSR while preserving SPA diagnostics and trial ledger evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-strategy-mvp-'))
    const inputCsv = await writeSyntheticMarketCsv(root)
    const candidatesPath = join(root, 'candidates.json')
    const outputPath = join(root, 'runs.json')
    const verdictPath = join(root, 'verdict.json')
    const releaseGateStatusPath = join(root, 'release_gate_status.json')

    await writeFile(candidatesPath, `${JSON.stringify({
      schemaVersion: 'strategy_candidates.test.v1',
      notes: [
        'runtime_mode=real_runtime',
        'source_lineage=openalice_native',
        'admission_intent=promotion',
        'promotion_eligible=true',
      ],
      dataset: {
        inputCsv,
        symbol: 'BTC/USD',
        lookbackBars: 90,
      },
      thresholds: {
        meanPboMax: 1,
        meanDsrProbabilityMin: 0.5,
        fdrQMax: 1,
      },
      wfo: {
        trainBars: 40,
        testBars: 20,
        stepBars: 20,
        degradationThreshold: 1,
      },
      significance: {
        partitions: 4,
        pboThreshold: 1,
        dsrMin: 0.5,
        fdrMethod: 'spa',
        spaBootstrapSamples: 50,
        spaBlockSize: 5,
        spaBlockSizeSet: [2, 5, 10],
        benchmarkStrategyIdBySymbol: {
          'BTC/USD': 'trend_control',
        },
      },
      riskSimulation: {
        method: 'moving_block_bootstrap',
        simulations: 100,
        horizonBars: 20,
        blockSize: 5,
        ruinDrawdownPct: 50,
        maxRuinProbability: 1,
        minProfitProbability: 0,
      },
      costModel: {
        feeRate: 0.0001,
        slippageBps: 1,
        latencyBars: 1,
        fundingRatePer8h: 0,
      },
      candidates: [
        {
          strategyId: 'trend_control',
          strategyName: 'Trend Control',
          strategy: 'trend',
          role: 'benchmark_control',
          sourceLineage: 'openalice_native',
          runtimeMode: 'real_runtime',
          admissionIntent: 'promotion',
          promotionEligible: true,
          params: {
            trendFastPeriod: 4,
            trendSlowPeriod: 12,
            trendConfirmBars: 1,
            allowShort: false,
          },
        },
        {
          strategyId: 'breakout_candidate',
          strategyName: 'Breakout Candidate',
          strategy: 'breakout',
          hypothesisFamily: 'volume_breakout',
          correlationBucket: 'volume_breakout',
          sourceLineage: 'openalice_native',
          runtimeMode: 'real_runtime',
          admissionIntent: 'promotion',
          promotionEligible: true,
          params: {
            breakoutPeriod: 8,
            breakoutExitPeriod: 4,
            allowShort: false,
          },
        },
      ],
    }, null, 2)}\n`, 'utf-8')

    const exitCode = await runStrategyMvpValidation([
      '--dryRun',
      'false',
      '--candidates',
      candidatesPath,
      '--output',
      outputPath,
      '--verdict-output',
      verdictPath,
      '--release-gate-status-path',
      releaseGateStatusPath,
    ])

    expect(exitCode).toBe(2)

    const report = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      portfolio: {
        result: string
        reasonCodes: string[]
      }
      symbols: Array<{
        aggregateMetrics: {
          fdrDiagnostics: {
            method: string
            bootstrapDirectionStable: boolean | null
            blockSizeSet: number[] | null
            blockSensitivityByCandidate: Array<{
              candidateIndex: number
              blockSensitivity: Array<{ blockSize: number }>
            }> | null
          }
        }
        candidates: Array<{
          strategyId: string
          status: string
          failureReasons: string[]
          significance: {
            dsrProbability: number | null
          }
          releaseGate: {
            checks: Array<{
              name: string
              status: string
              metrics: Record<string, unknown>
            }>
          }
        }>
      }>
    }
    const verdict = JSON.parse(await readFile(verdictPath, 'utf-8')) as {
      result: string
      reasonCodes: string[]
      symbols: Array<{
        candidates: Array<{
          strategyId: string
          status: string
          failureReasons: string[]
        }>
      }>
    }
    const releaseGateStatus = JSON.parse(await readFile(releaseGateStatusPath, 'utf-8')) as {
      result: string
      reasonCodes: string[]
    }

    expect(report.portfolio.result).toBe('NO_GO')
    expect(verdict.result).toBe('NO_GO')
    expect(releaseGateStatus.result).toBe('NO_GO')
    expect(report.portfolio.reasonCodes).toContain('HARD_NO_CANDIDATE_PASS')

    const diagnostics = report.symbols[0].aggregateMetrics.fdrDiagnostics
    expect(diagnostics.method).toBe('spa')
    expect(diagnostics.bootstrapDirectionStable).toEqual(expect.any(Boolean))
    expect(diagnostics.blockSizeSet).toEqual([2, 5, 10])
    expect(diagnostics.blockSensitivityByCandidate).toHaveLength(2)
    for (const row of diagnostics.blockSensitivityByCandidate ?? []) {
      expect(row.blockSensitivity.map(item => item.blockSize)).toEqual([2, 5, 10])
    }

    const candidates = report.symbols[0].candidates
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) {
      expect(candidate.status).toBe('fail')
      expect(candidate.significance.dsrProbability).toBeNull()
      expect(candidate.failureReasons).toContain('HARD_DSR_LOW_SAMPLE')
      const significanceCheck = candidate.releaseGate.checks.find(check => check.name === 'significance')
      expect(significanceCheck).toMatchObject({
        status: 'fail',
        metrics: {
          dsrStatus: 'low_sample',
          dsrDiagnosticQuality: 'low_sample',
          trialLedgerStatus: 'pass',
          trialLedgerRawM: 2,
          trialLedgerFailedTrialCount: 1,
          trialLedgerSurvivingTrialCount: 1,
          trialLedgerFdrMethodPrimary: 'BY_raw_m',
          fdrMethod: 'spa',
          spaBootstrapStatus: expect.stringMatching(/^(pass|fail)$/),
          spaBlockSizeSet: '2,5,10',
        },
      })
    }

    const verdictCandidates = verdict.symbols[0].candidates
    expect(verdictCandidates.map(candidate => candidate.failureReasons)).toEqual([
      expect.arrayContaining(['HARD_DSR_LOW_SAMPLE']),
      expect.arrayContaining(['HARD_DSR_LOW_SAMPLE']),
    ])
    expect(releaseGateStatus.reasonCodes).toEqual(verdict.reasonCodes)
  })
})
