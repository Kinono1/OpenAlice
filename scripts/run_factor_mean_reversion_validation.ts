import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'

const execFileAsync = promisify(execFile)

interface AssetTarget {
  symbol: string
  csv: string
}

interface SignificanceDiagnostics {
  passed: boolean
  primaryFailure: 'pbo' | 'dsr' | 'pbo_and_dsr' | 'none'
  pbo: number
  pboThreshold: number
  dsrValue: number
  dsrMin: number
}

const DEFAULT_ASSETS: AssetTarget[] = [
  { symbol: 'BTC/USDT:USDT', csv: 'data/market/gate/BTC_USDT_USDT_1h.csv' },
  { symbol: 'ETH/USDT:USDT', csv: 'data/market/gate/ETH_USDT_USDT_1h.csv' },
  { symbol: 'SOL/USDT:USDT', csv: 'data/market/gate/SOL_USDT_USDT_1h.csv' },
]

const DEFAULT_PARAMS = {
  allowShort: true,
  factorEntryThreshold: 0.35,
  factorExitThreshold: 0.1,
  factorPositionPctOfEquity: 0.03,
  factorMaxHoldingBars: 24,
  factorStopLossPct: 0.0125,
  factorKillSwitchVolPct: 3.0,
  factorKillSwitchTrendStrengthPct: 0.8,
}

function diagnoseSignificance(significance: {
  passed: boolean
  pbo: number
  dsrValue: number
}): SignificanceDiagnostics {
  const pboThreshold = 0.2
  const dsrMin = 0
  const pboFailed = significance.pbo >= pboThreshold
  const dsrFailed = significance.dsrValue <= dsrMin
  return {
    passed: significance.passed,
    primaryFailure: pboFailed && dsrFailed
      ? 'pbo_and_dsr'
      : pboFailed
        ? 'pbo'
        : dsrFailed
          ? 'dsr'
          : 'none',
    pbo: significance.pbo,
    pboThreshold,
    dsrValue: significance.dsrValue,
    dsrMin,
  }
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString().replaceAll(':', '-')
  const outputDir = resolve(`data/research/standalone_factor_mean_reversion/${generatedAt}`)
  await mkdir(outputDir, { recursive: true })
  const researchPython = existsSync(resolve('.venv-research/bin/python'))
    ? resolve('.venv-research/bin/python')
    : 'python3'

  await execFileAsync(researchPython, [
    'scripts/export_gate_market_csv.py',
    '--symbols',
    'BTC_USDT_USDT',
    'ETH_USDT_USDT',
    'SOL_USDT_USDT',
    '--start',
    '2023-01-01',
    '--end',
    '2025-04-03',
  ], { cwd: process.cwd() })

  const perAsset: Array<Record<string, unknown>> = []
  for (const asset of DEFAULT_ASSETS) {
    const safeSymbol = asset.symbol.replace(/[/:]/g, '_')
    const validationOutput = resolve(outputDir, `${safeSymbol}.validation.json`)
    const releaseGateStatusPath = resolve(outputDir, `${safeSymbol}.release_gate_status.json`)

    try {
      await execFileAsync('node', [
        './node_modules/tsx/dist/cli.mjs',
        'scripts/run_validation_pipeline.ts',
        '--inputCsv', asset.csv,
        '--symbol', asset.symbol,
        '--strategy', 'factorMeanReversion',
        '--lookbackBars', '19608',
        '--output', validationOutput,
        '--paramsJson', JSON.stringify(DEFAULT_PARAMS),
        '--feeRate', '0.0006',
        '--slippageBps', '6',
        '--latencyBars', '1',
        '--fundingRatePer8h', '0',
        '--trainBars', String(24 * 365),
        '--testBars', String(24 * 90),
        '--stepBars', String(24 * 90),
        '--writeReleaseGateStatus', 'true',
        '--releaseGateStatusPath', releaseGateStatusPath,
      ], { cwd: process.cwd() })
    } catch (err) {
      // keep artifact collection even when release gate exits non-zero
    }

    const validation = JSON.parse(await readFile(validationOutput, 'utf-8'))
    const gate = JSON.parse(await readFile(releaseGateStatusPath, 'utf-8'))
    perAsset.push({
      symbol: asset.symbol,
      inputCsv: resolve(asset.csv),
      validationOutput,
      releaseGateStatusPath,
      selectedParams: validation.selectedParams,
      selectedMetrics: validation.selectedMetrics,
      baselineReport: validation.baselineReport,
      wfo: validation.wfo,
      significance: validation.significance,
      significanceDiagnostics: diagnoseSignificance(validation.significance),
      riskSimulation: validation.riskSimulation,
      releaseGate: validation.releaseGate,
      persistedGate: gate,
    })
  }

  const aggregate = {
    generatedAt: new Date().toISOString(),
    strategy: 'factorMeanReversion',
    params: DEFAULT_PARAMS,
    assets: perAsset,
    aggregate: {
      allowPaperTrading: perAsset.every((asset) => (asset.releaseGate as { allowPaperTrading: boolean }).allowPaperTrading),
      allowLiveTrading: perAsset.every((asset) => (asset.releaseGate as { allowLiveTrading: boolean }).allowLiveTrading),
      netReturnPctMean: mean(perAsset.map((asset) => (asset.selectedMetrics as { totalReturnPct: number }).totalReturnPct)),
      maxDrawdownPctWorst: Math.max(...perAsset.map((asset) => (asset.selectedMetrics as { maxDrawdownPct: number }).maxDrawdownPct)),
      tradeCountTotal: perAsset.reduce((sum, asset) => sum + ((asset.selectedMetrics as { tradeCount: number }).tradeCount), 0),
      baselineExpectancyAfterCostMean: {
        grossExpectancyPct: mean(perAsset.map((asset) => Number((asset.baselineReport as {
          expectancyAfterCost?: { grossExpectancyPct?: number }
        })?.expectancyAfterCost?.grossExpectancyPct ?? 0))),
        feeExpectancyDragPct: mean(perAsset.map((asset) => Number((asset.baselineReport as {
          expectancyAfterCost?: { feeExpectancyDragPct?: number }
        })?.expectancyAfterCost?.feeExpectancyDragPct ?? 0))),
        slippageExpectancyDragPct: mean(perAsset.map((asset) => Number((asset.baselineReport as {
          expectancyAfterCost?: { slippageExpectancyDragPct?: number }
        })?.expectancyAfterCost?.slippageExpectancyDragPct ?? 0))),
        fundingExpectancyDragPct: mean(perAsset.map((asset) => Number((asset.baselineReport as {
          expectancyAfterCost?: { fundingExpectancyDragPct?: number }
        })?.expectancyAfterCost?.fundingExpectancyDragPct ?? 0))),
        totalCostExpectancyDragPct: mean(perAsset.map((asset) => Number((asset.baselineReport as {
          expectancyAfterCost?: { totalCostExpectancyDragPct?: number }
        })?.expectancyAfterCost?.totalCostExpectancyDragPct ?? 0))),
        netExpectancyPct: mean(perAsset.map((asset) => Number((asset.baselineReport as {
          expectancyAfterCost?: { netExpectancyPct?: number }
        })?.expectancyAfterCost?.netExpectancyPct ?? 0))),
      },
      significanceFailureBreakdown: {
        pbo: perAsset.filter((asset) => (asset.significanceDiagnostics as SignificanceDiagnostics).primaryFailure === 'pbo').length,
        dsr: perAsset.filter((asset) => (asset.significanceDiagnostics as SignificanceDiagnostics).primaryFailure === 'dsr').length,
        pbo_and_dsr: perAsset.filter((asset) => (asset.significanceDiagnostics as SignificanceDiagnostics).primaryFailure === 'pbo_and_dsr').length,
        none: perAsset.filter((asset) => (asset.significanceDiagnostics as SignificanceDiagnostics).primaryFailure === 'none').length,
      },
    },
  }

  const summaryPath = resolve(outputDir, 'factor_mean_reversion_summary.json')
  await writeFile(summaryPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf-8')
  console.log(summaryPath)
}

function mean(values: number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
