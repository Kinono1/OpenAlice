import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

interface ShockFadeParams {
  allowShort: boolean
  factorEntryThreshold: number
  factorExitThreshold: number
  factorPositionPctOfEquity: number
  factorMaxHoldingBars: number
  factorStopLossPct: number
  factorKillSwitchVolPct: number
  factorKillSwitchTrendStrengthPct: number
  shockMinVolumeRatio: number
  shockMinAbsReturnPct: number
}

interface ShockFadeRegimeGate {
  allowedEntryRegimes: Array<'HighVolMeanRevert' | 'LowVolCarry'>
  exitOnMismatch: boolean
}

interface CliArgs {
  dryRun: boolean
  includeSol: boolean
  selfCheck: boolean
}

const BTC_AND_ETH_ASSETS: AssetTarget[] = [
  { symbol: 'BTC/USDT:USDT', csv: 'data/market/gate/BTC_USDT_USDT_1h.csv' },
  { symbol: 'ETH/USDT:USDT', csv: 'data/market/gate/ETH_USDT_USDT_1h.csv' },
]

const SOL_ASSET: AssetTarget = {
  symbol: 'SOL/USDT:USDT',
  csv: 'data/market/gate/SOL_USDT_USDT_1h.csv',
}

const BASE_SHOCK_FADE_PARAMS: ShockFadeParams = {
  allowShort: true,
  factorEntryThreshold: 0.48,
  factorExitThreshold: 0.08,
  factorPositionPctOfEquity: 0.015,
  factorMaxHoldingBars: 30,
  factorStopLossPct: 0.012,
  factorKillSwitchVolPct: 2.8,
  factorKillSwitchTrendStrengthPct: 0.6,
  shockMinVolumeRatio: 1.8,
  shockMinAbsReturnPct: 1.8,
}

const BASE_SHOCK_FADE_REGIME_GATE: ShockFadeRegimeGate = {
  allowedEntryRegimes: ['HighVolMeanRevert', 'LowVolCarry'],
  exitOnMismatch: true,
}

function buildShockFadeCandidates(symbol: string): ShockFadeParams[] {
  const base = buildShockFadeParams(symbol)
  return [
    { ...base },
    {
      ...base,
      factorEntryThreshold: Math.max(0.4, base.factorEntryThreshold - 0.06),
      factorExitThreshold: Math.max(0.05, base.factorExitThreshold - 0.02),
      factorMaxHoldingBars: Math.max(18, base.factorMaxHoldingBars - 6),
      shockMinVolumeRatio: Math.max(1.5, base.shockMinVolumeRatio - 0.15),
      shockMinAbsReturnPct: Math.max(1.4, base.shockMinAbsReturnPct - 0.2),
    },
    {
      ...base,
      factorEntryThreshold: Math.min(0.7, base.factorEntryThreshold + 0.08),
      factorExitThreshold: Math.min(0.14, base.factorExitThreshold + 0.03),
      factorMaxHoldingBars: base.factorMaxHoldingBars + 6,
      shockMinVolumeRatio: Math.min(2.4, base.shockMinVolumeRatio + 0.2),
      shockMinAbsReturnPct: Math.min(3.0, base.shockMinAbsReturnPct + 0.3),
    },
  ]
}

function buildShockFadeParams(symbol: string): ShockFadeParams {
  if (symbol.startsWith('SOL/')) {
    return {
      ...BASE_SHOCK_FADE_PARAMS,
      factorEntryThreshold: 0.55,
      factorExitThreshold: 0.1,
      factorPositionPctOfEquity: 0.01,
      factorMaxHoldingBars: 24,
      factorStopLossPct: 0.01,
      factorKillSwitchTrendStrengthPct: 0.55,
      shockMinVolumeRatio: 2.0,
      shockMinAbsReturnPct: 2.1,
    }
  }

  return { ...BASE_SHOCK_FADE_PARAMS }
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

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: 'factor_shock_fade',
      command: 'run_factor_shock_fade_validation',
      executionMode: {
        dryRun: true,
        exportsMarketCsv: false,
        writesResearchArtifacts: false,
        runsValidationPipeline: false,
        writesReleaseGateStatus: false,
        promotionEligible: false,
      },
      requested: {
        includeSol: args.includeSol,
        selfCheck: args.selfCheck,
      },
      optIn: {
        runValidation: '--dryRun false',
      },
    }, null, 2))
    return
  }

  if (args.selfCheck) {
    console.log(
      JSON.stringify(
        {
          strategy: 'shockFade',
          includeSol: args.includeSol,
          assets: resolveAssets(args.includeSol).map((asset) => ({
            symbol: asset.symbol,
            params: buildShockFadeParams(asset.symbol),
            candidates: buildShockFadeCandidates(asset.symbol),
            regimeGate: BASE_SHOCK_FADE_REGIME_GATE,
          })),
        },
        null,
        2,
      ),
    )
    return
  }

  const generatedAt = new Date().toISOString().replaceAll(':', '-')
  const outputDir = resolve(`data/research/standalone_shock_fade/${generatedAt}`)
  await mkdir(outputDir, { recursive: true })
  const researchPython = existsSync(resolve('.venv-research/bin/python'))
    ? resolve('.venv-research/bin/python')
    : 'python3'
  const assets = resolveAssets(args.includeSol)

  await execFileAsync(researchPython, [
    'scripts/export_gate_market_csv.py',
    '--symbols',
    ...assets.map((asset) => asset.symbol.replaceAll('/', '_').replaceAll(':', '_')),
    '--start',
    '2023-01-01',
    '--end',
    '2025-04-03',
  ], { cwd: process.cwd() })

  const perAsset: Array<Record<string, unknown>> = []
  for (const asset of assets) {
    const safeSymbol = asset.symbol.replace(/[/:]/g, '_')
    const validationOutput = resolve(outputDir, `${safeSymbol}.validation.json`)
    const releaseGateStatusPath = resolve(outputDir, `${safeSymbol}.release_gate_status.json`)
    const params = buildShockFadeParams(asset.symbol)
    const candidates = buildShockFadeCandidates(asset.symbol)

    try {
      await execFileAsync('node', [
        './node_modules/tsx/dist/cli.mjs',
        'scripts/run_validation_pipeline.ts',
        '--inputCsv', asset.csv,
        '--symbol', asset.symbol,
        '--strategy', 'shockFade',
        '--lookbackBars', '19608',
        '--output', validationOutput,
        '--paramsJson', JSON.stringify(params),
        '--candidatesJson', JSON.stringify(candidates),
        '--regimeGateJson', JSON.stringify(BASE_SHOCK_FADE_REGIME_GATE),
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
    } catch (error) {
      // keep artifact collection even when release gate exits non-zero
    }

    const validation = JSON.parse(await readFile(validationOutput, 'utf-8'))
    const gate = JSON.parse(await readFile(releaseGateStatusPath, 'utf-8'))
    perAsset.push({
      symbol: asset.symbol,
      inputCsv: resolve(asset.csv),
      validationOutput,
      releaseGateStatusPath,
      params,
      candidates,
      regimeGate: BASE_SHOCK_FADE_REGIME_GATE,
      selectedParams: validation.selectedParams,
      selectedMetrics: validation.selectedMetrics,
      baselineReport: validation.baselineReport,
      canonicalScoreboard: validation.canonicalScoreboard,
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
    strategy: 'shockFade',
    params: BASE_SHOCK_FADE_PARAMS,
    regimeGate: BASE_SHOCK_FADE_REGIME_GATE,
    includeSol: args.includeSol,
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

  const summaryPath = resolve(outputDir, 'shock_fade_summary.json')
  await writeFile(summaryPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf-8')
  console.log(summaryPath)
}

function resolveAssets(includeSol: boolean): AssetTarget[] {
  return includeSol ? [...BTC_AND_ETH_ASSETS, SOL_ASSET] : [...BTC_AND_ETH_ASSETS]
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    dryRun: parseBoolArg(raw.get('dryRun'), true),
    includeSol: parseBoolArg(raw.get('includeSol'), false),
    selfCheck: parseBoolArg(raw.get('selfCheck'), false),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const withoutPrefix = token.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const key = withoutPrefix
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
  }
  return out
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${raw}`)
}

function mean(values: number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

export {
  main,
  parseArgs,
}
