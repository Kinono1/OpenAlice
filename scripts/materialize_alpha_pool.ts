import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  readStrategyConfig,
  type StrategyConfig,
} from '../src/core/config.js'
import {
  DEFAULT_ALPHA_POOL_PATH,
  evaluateAlphaFactorAdmission,
  summarizeAlphaPoolArtifact,
  type AlphaPoolArtifact,
  type AlphaPoolEntry,
} from '../src/domain/strategy/alpha-pool.js'

type FactorKey = keyof StrategyConfig['factors']
type FactorRole = 'alpha' | 'conditioning_filter' | 'diagnostic'

interface FactorAdmissionTemplate {
  key: FactorKey
  alphaId: string
  expression: string
  hypothesis: string
  featureNames: string[]
  role: FactorRole
  runtimeAccepted: boolean
  noveltyScore: number
  hypothesisAlignmentScore: number
  complexityScore: number
  symbolicLength: number
  parameterCount: number
}

interface CliArgs {
  output: string
  symbol: string
  includeDisabled: boolean
  selfCheck: boolean
}

const HANDCRAFTED_FACTOR_TEMPLATES: FactorAdmissionTemplate[] = [
  {
    key: 'fundingRate',
    alphaId: 'runtime_factor_funding_rate_v2',
    expression:
      'contrarian_winsorized_percentile_rank(funding_rate_8h_history) * not(pegged_funding_regime)',
    hypothesis:
      'funding rate extremes predict perp spot relative value except pegged trend regimes',
    featureNames: ['funding_rate_8h', 'funding_percentile_rank', 'pegged_funding_regime'],
    role: 'alpha',
    runtimeAccepted: true,
    noveltyScore: 0.82,
    hypothesisAlignmentScore: 0.9,
    complexityScore: 0.28,
    symbolicLength: 9,
    parameterCount: 0,
  },
  {
    key: 'basis',
    alphaId: 'runtime_factor_basis_v2',
    expression:
      'contrarian_winsorized_percentile_rank(perp_basis_or_future_basis) * not(pegged_basis_regime)',
    hypothesis:
      'basis extremes predict carry or convergence pressure except persistent pegged squeeze regimes',
    featureNames: ['basis_pct', 'basis_percentile_rank', 'pegged_basis_regime'],
    role: 'alpha',
    runtimeAccepted: true,
    noveltyScore: 0.78,
    hypothesisAlignmentScore: 0.88,
    complexityScore: 0.3,
    symbolicLength: 9,
    parameterCount: 0,
  },
  {
    key: 'volumeSurge',
    alphaId: 'runtime_factor_volume_surge_v1',
    expression: 'signed_volume_surge(current_volume / average_volume, price_return)',
    hypothesis:
      'directional volume expansion confirms information flow when price return and volume move together',
    featureNames: ['volume_surge', 'price_return'],
    role: 'alpha',
    runtimeAccepted: true,
    noveltyScore: 0.7,
    hypothesisAlignmentScore: 0.84,
    complexityScore: 0.22,
    symbolicLength: 7,
    parameterCount: 0,
  },
  {
    key: 'momentumComposite',
    alphaId: 'runtime_factor_momentum_tstat_v2',
    expression:
      'tanh(weighted_return_1h_6h_24h_7d / realized_vol_scaled_standard_error / 3)',
    hypothesis:
      'risk-normalized multi-horizon momentum forecasts continuation while bounded by crypto tail risk',
    featureNames: ['return_1h', 'return_6h', 'return_24h', 'return_7d', 'realized_vol_pct'],
    role: 'alpha',
    runtimeAccepted: true,
    noveltyScore: 0.74,
    hypothesisAlignmentScore: 0.86,
    complexityScore: 0.36,
    symbolicLength: 10,
    parameterCount: 1,
  },
  {
    key: 'meanReversion',
    alphaId: 'runtime_factor_stationary_mean_reversion_v2',
    expression:
      'stationary_series_bollinger_zscore_with_rsi_confirmation(series_kind != raw_price)',
    hypothesis:
      'stationary spreads can mean revert when z-score extremes are confirmed and raw prices are disabled',
    featureNames: ['stationary_spread', 'bollinger_zscore', 'rsi_confirmation'],
    role: 'alpha',
    runtimeAccepted: true,
    noveltyScore: 0.76,
    hypothesisAlignmentScore: 0.88,
    complexityScore: 0.34,
    symbolicLength: 9,
    parameterCount: 0,
  },
  {
    key: 'volatilityRegime',
    alphaId: 'runtime_factor_volatility_regime_stress_v2',
    expression: '-weighted_sum(vol_expansion, vol_clustering, vol_of_vol_norm)',
    hypothesis:
      'expanding volatility and vol-of-vol represent stress that should cut risk and penalize fragile longs',
    featureNames: ['realized_vol_pct', 'vol_expansion', 'vol_of_vol_pct'],
    role: 'conditioning_filter',
    runtimeAccepted: false,
    noveltyScore: 0.69,
    hypothesisAlignmentScore: 0.82,
    complexityScore: 0.24,
    symbolicLength: 7,
    parameterCount: 0,
  },
  {
    key: 'liquidationPressure',
    alphaId: 'runtime_factor_liquidation_pressure_v2',
    expression: 'weighted_sum(funding_pressure, cascade_pressure, open_interest_pressure)',
    hypothesis:
      'crowded funding, volume cascade and open interest pressure indicate liquidation-driven directional risk',
    featureNames: ['funding_pressure', 'cascade_pressure', 'open_interest_pressure'],
    role: 'alpha',
    runtimeAccepted: true,
    noveltyScore: 0.73,
    hypothesisAlignmentScore: 0.86,
    complexityScore: 0.32,
    symbolicLength: 7,
    parameterCount: 0,
  },
  {
    key: 'crossTimeframeDivergence',
    alphaId: 'runtime_factor_cross_timeframe_vol_divergence_v2',
    expression: 'short_realized_vol / long_realized_vol -> confidence_conditioning_only',
    hypothesis:
      'cross-timeframe volatility divergence conditions confidence but is not directional alpha',
    featureNames: ['short_realized_vol', 'long_realized_vol', 'vol_ratio'],
    role: 'conditioning_filter',
    runtimeAccepted: false,
    noveltyScore: 0.71,
    hypothesisAlignmentScore: 0.9,
    complexityScore: 0.2,
    symbolicLength: 7,
    parameterCount: 0,
  },
]

export function buildRuntimeAlphaPoolArtifact(input: {
  config: StrategyConfig
  symbol: string
  generatedAt?: string
  includeDisabled?: boolean
}): AlphaPoolArtifact {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const includeDisabled = input.includeDisabled ?? false
  const entries = HANDCRAFTED_FACTOR_TEMPLATES.flatMap((template): AlphaPoolEntry[] => {
    const factorConfig = input.config.factors[template.key]
    const enabled = factorConfig?.enabled === true
    if (!enabled && !includeDisabled) {
      return []
    }

    return [{
      alphaId: template.alphaId,
      expression: template.expression,
      source: 'handcrafted',
      hypothesis: template.hypothesis,
      featureNames: template.featureNames,
      trainWindow: {
        start: '1970-01-01T00:00:00.000Z',
        end: generatedAt,
      },
      testWindow: {
        start: '1970-01-01T00:00:00.000Z',
        end: generatedAt,
      },
      oosIc: 0,
      costAdjustedSharpe: 0,
      turnover: 0,
      noveltyScore: template.noveltyScore,
      hypothesisAlignmentScore: template.hypothesisAlignmentScore,
      complexityScore: template.complexityScore,
      symbolicLength: template.symbolicLength,
      parameterCount: template.parameterCount,
      regimeSummary: {
        role: template.role,
        enabled,
        configuredWeight: factorConfig?.weight ?? 0,
        metricsSource: 'metadata_only',
        admissionScope: 'novelty_hypothesis_complexity',
      },
      acceptedForRuntime: enabled && template.runtimeAccepted,
    }]
  })

  return {
    generatedAt,
    artifactVersion: 'v1',
    symbol: input.symbol,
    entries,
  }
}

export async function materializeRuntimeAlphaPool(args: Partial<CliArgs> = {}) {
  const output = resolve(args.output ?? DEFAULT_ALPHA_POOL_PATH)
  const config = await readStrategyConfig()
  const artifact = buildRuntimeAlphaPoolArtifact({
    config,
    symbol: args.symbol ?? 'runtime-multi-asset',
    includeDisabled: args.includeDisabled ?? false,
  })
  const summary = summarizeAlphaPoolArtifact(artifact, output)
  const runtimeFailures = artifact.entries
    .filter((entry) => entry.acceptedForRuntime)
    .map((entry) => ({
      entry,
      decision: evaluateAlphaFactorAdmission(entry, {
        existingEntries: artifact.entries,
      }),
    }))
    .filter((item) => !item.decision.passed)

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8')

  return {
    output,
    artifact,
    summary,
    runtimeAdmissionFailures: runtimeFailures.map((item) => ({
      alphaId: item.entry.alphaId,
      reasons: item.decision.reasons,
    })),
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      raw.set(key, 'true')
      continue
    }
    raw.set(key, next)
    index += 1
  }

  return {
    output: raw.get('output') ?? DEFAULT_ALPHA_POOL_PATH,
    symbol: raw.get('symbol') ?? 'runtime-multi-asset',
    includeDisabled: parseBool(raw.get('includeDisabled'), false),
    selfCheck: parseBool(raw.get('selfCheck'), false),
  }
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase())
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await materializeRuntimeAlphaPool(args)

  const payload = {
    alphaPoolPath: result.output,
    totalCandidates: result.summary.totalCandidates,
    acceptedCount: result.summary.acceptedCount,
    runtimeAcceptedAdmissionGateFailedCount:
      result.summary.runtimeAcceptedAdmissionGateFailedCount,
    runtimeAdmissionFailures: result.runtimeAdmissionFailures,
  }

  console.log(JSON.stringify(payload, null, 2))
  if (result.runtimeAdmissionFailures.length > 0) {
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}
