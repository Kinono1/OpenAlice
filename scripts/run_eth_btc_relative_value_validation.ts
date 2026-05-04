import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PairMarketCandle } from './lib/pair_market_data.ts'
import {
  buildRelativeValueCandles,
  loadCsvCandles,
} from './lib/pair_market_data.ts'

const execFileAsync = promisify(execFile)

interface RelativeValueParams {
  allowShort: boolean
  factorEntryThreshold: number
  factorExitThreshold: number
  factorPositionPctOfEquity: number
  factorMaxHoldingBars: number
  factorStopLossPct: number
  factorKillSwitchVolPct: number
  factorKillSwitchTrendStrengthPct: number
}

interface RelativeValueRegimeGate {
  allowedEntryRegimes: Array<'HighVolMeanRevert' | 'LowVolCarry'>
  exitOnMismatch: boolean
}

interface CliArgs {
  dryRun: boolean
  lookbackBars: number
  trainBars: number
  testBars: number
  stepBars: number
  riskSimulationCount: number
  selfCheck: boolean
}

const LEADER = {
  symbol: 'ETH/USDT:USDT',
  csv: 'data/market/gate/ETH_USDT_USDT_1h.csv',
}

const HEDGE = {
  symbol: 'BTC/USDT:USDT',
  csv: 'data/market/gate/BTC_USDT_USDT_1h.csv',
}

const PAIR_SYMBOL = 'ETH/BTC_RV'

const BASE_PARAMS: RelativeValueParams = {
  allowShort: true,
  factorEntryThreshold: 0.28,
  factorExitThreshold: 0.07,
  factorPositionPctOfEquity: 0.02,
  factorMaxHoldingBars: 48,
  factorStopLossPct: 0.015,
  factorKillSwitchVolPct: 2.5,
  factorKillSwitchTrendStrengthPct: 0.9,
}

const BASE_REGIME_GATE: RelativeValueRegimeGate = {
  allowedEntryRegimes: ['HighVolMeanRevert', 'LowVolCarry'],
  exitOnMismatch: true,
}

function buildCandidates(): RelativeValueParams[] {
  return [
    { ...BASE_PARAMS },
    {
      ...BASE_PARAMS,
      factorEntryThreshold: 0.24,
      factorExitThreshold: 0.05,
      factorMaxHoldingBars: 36,
    },
    {
      ...BASE_PARAMS,
      factorEntryThreshold: 0.34,
      factorExitThreshold: 0.1,
      factorMaxHoldingBars: 60,
      factorPositionPctOfEquity: 0.015,
    },
  ]
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: 'eth_btc_relative_value',
      command: 'run_eth_btc_relative_value_validation',
      executionMode: {
        dryRun: true,
        loadsMarketData: false,
        writesResearchArtifacts: false,
        runsValidationPipeline: false,
        writesReleaseGateStatus: false,
        promotionEligible: false,
      },
      optIn: {
        runValidation: '--dryRun false',
      },
    }, null, 2))
    return
  }

  const leader = await loadCsvCandles(LEADER.csv, LEADER.symbol)
  const hedge = await loadCsvCandles(HEDGE.csv, HEDGE.symbol)
  const pairCandles = buildRelativeValueCandles({
    leader,
    hedge,
    symbol: PAIR_SYMBOL,
  })

  if (args.selfCheck) {
    console.log(
      JSON.stringify(
        {
          family: 'eth_btc_relative_value',
          executionStrategy: 'factorMeanReversion',
          leaderSymbol: LEADER.symbol,
          hedgeSymbol: HEDGE.symbol,
          syntheticSymbol: PAIR_SYMBOL,
          alignedBars: pairCandles.length,
          firstTimestamp: pairCandles[0]?.time ?? null,
          lastTimestamp: pairCandles[pairCandles.length - 1]?.time ?? null,
          params: BASE_PARAMS,
          candidates: buildCandidates(),
          regimeGate: BASE_REGIME_GATE,
        },
        null,
        2,
      ),
    )
    return
  }

  const generatedAt = new Date().toISOString().replaceAll(':', '-')
  const outputDir = resolve(`data/research/standalone_eth_btc_relative_value/${generatedAt}`)
  await mkdir(outputDir, { recursive: true })

  const pairCsvPath = resolve(outputDir, 'ETH_BTC_RV_1h.csv')
  await writeSyntheticCsv(pairCsvPath, pairCandles)

  const validationOutput = resolve(outputDir, 'eth_btc_relative_value.validation.json')
  const releaseGateStatusPath = resolve(outputDir, 'eth_btc_relative_value.release_gate_status.json')

  try {
    await execFileAsync('node', [
      './node_modules/tsx/dist/cli.mjs',
      'scripts/run_validation_pipeline.ts',
      '--inputCsv', pairCsvPath,
      '--symbol', PAIR_SYMBOL,
      '--strategy', 'factorMeanReversion',
      '--lookbackBars', String(args.lookbackBars),
      '--output', validationOutput,
      '--paramsJson', JSON.stringify(BASE_PARAMS),
      '--candidatesJson', JSON.stringify(buildCandidates()),
      '--regimeGateJson', JSON.stringify(BASE_REGIME_GATE),
      '--feeRate', '0.0006',
      '--slippageBps', '6',
      '--latencyBars', '1',
      '--fundingRatePer8h', '0',
      '--trainBars', String(args.trainBars),
      '--testBars', String(args.testBars),
      '--stepBars', String(args.stepBars),
      '--significancePartitions', '6',
      '--riskSimulationCount', String(args.riskSimulationCount),
      '--writeReleaseGateStatus', 'true',
      '--releaseGateStatusPath', releaseGateStatusPath,
    ], { cwd: process.cwd() })
  } catch {
    // Keep artifact collection even when release gate exits non-zero.
  }

  const validation = JSON.parse(await readFile(validationOutput, 'utf-8'))
  const gate = JSON.parse(await readFile(releaseGateStatusPath, 'utf-8'))
  const summaryPath = resolve(outputDir, 'eth_btc_relative_value_summary.json')

  await writeFile(summaryPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    family: 'eth_btc_relative_value',
    executionStrategy: 'factorMeanReversion',
    leaderSymbol: LEADER.symbol,
    hedgeSymbol: HEDGE.symbol,
    syntheticSymbol: PAIR_SYMBOL,
    pairCsvPath,
    alignedBars: pairCandles.length,
    params: BASE_PARAMS,
    candidates: buildCandidates(),
    regimeGate: BASE_REGIME_GATE,
    validationOutput,
    releaseGateStatusPath,
    selectedParams: validation.selectedParams,
    selectedMetrics: validation.selectedMetrics,
    baselineReport: validation.baselineReport,
    canonicalScoreboard: validation.canonicalScoreboard,
    wfo: validation.wfo,
    significance: validation.significance,
    riskSimulation: validation.riskSimulation,
    releaseGate: validation.releaseGate,
    persistedGate: gate,
  }, null, 2)}\n`, 'utf-8')

  console.log(summaryPath)
}

async function writeSyntheticCsv(
  path: string,
  candles: PairMarketCandle[],
): Promise<void> {
  const rows = [
    'timestamp,open,high,low,close,volume',
    ...candles.map((candle) =>
      [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].join(','),
    ),
  ]
  await writeFile(path, `${rows.join('\n')}\n`, 'utf-8')
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    dryRun: parseBoolArg(raw.get('dryRun'), true),
    lookbackBars: parseIntArg(raw.get('lookbackBars'), 6000, 'lookbackBars'),
    trainBars: parseIntArg(raw.get('trainBars'), 2400, 'trainBars'),
    testBars: parseIntArg(raw.get('testBars'), 720, 'testBars'),
    stepBars: parseIntArg(raw.get('stepBars'), 720, 'stepBars'),
    riskSimulationCount: parseIntArg(raw.get('riskSimulationCount'), 200, 'riskSimulationCount'),
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

function parseIntArg(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${raw}`)
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
