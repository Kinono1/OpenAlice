export type RiskSimulationMethod = 'iid_bootstrap' | 'moving_block_bootstrap'

export interface RiskSimulationConfig {
  method?: RiskSimulationMethod
  simulations?: number
  horizonBars?: number
  blockSize?: number
  ruinDrawdownPct?: number
  minProfitProbability?: number
  maxRuinProbability?: number
  confidenceLevel?: number
  seed?: number
}

export interface RiskSimulationPathStats {
  finalReturnPct: number
  maxDrawdownPct: number
}

export interface RiskSimulationResult {
  method: RiskSimulationMethod
  simulations: number
  horizonBars: number
  ruinDrawdownPct: number
  maxRuinProbability: number
  minProfitProbability: number
  confidenceLevel: number
  profitProbability: number
  riskOfRuin: number
  expectedFinalReturnPct: number
  medianFinalReturnPct: number
  confidenceInterval: {
    finalReturnPct: [number, number]
    maxDrawdownPct: [number, number]
  }
  gatePassed: boolean
}

const DEFAULT_CONFIG: Required<RiskSimulationConfig> = {
  method: 'moving_block_bootstrap',
  simulations: 5000,
  horizonBars: 24 * 90,
  blockSize: 24,
  ruinDrawdownPct: 30,
  minProfitProbability: 0.55,
  maxRuinProbability: 0.02,
  confidenceLevel: 0.95,
  seed: 42,
}

export function evaluateRiskSimulation(
  historicalReturns: number[],
  config: RiskSimulationConfig = {},
): RiskSimulationResult {
  const returns = validateReturns(historicalReturns)
  const resolved = resolveConfig(config)
  const rng = createXorShift32(resolved.seed)
  const stats: RiskSimulationPathStats[] = []

  for (let i = 0; i < resolved.simulations; i++) {
    const path =
      resolved.method === 'iid_bootstrap'
        ? sampleIid(returns, resolved.horizonBars, rng)
        : sampleMovingBlock(
            returns,
            resolved.horizonBars,
            resolved.blockSize,
            rng,
          )
    stats.push(simulatePath(path))
  }

  const profitProbability =
    stats.filter((path) => path.finalReturnPct > 0).length / stats.length
  const riskOfRuin =
    stats.filter((path) => path.maxDrawdownPct >= resolved.ruinDrawdownPct).length /
    stats.length

  const finalReturns = stats.map((path) => path.finalReturnPct).sort((a, b) => a - b)
  const drawdowns = stats.map((path) => path.maxDrawdownPct).sort((a, b) => a - b)
  const lowerQ = (1 - resolved.confidenceLevel) / 2
  const upperQ = 1 - lowerQ

  return {
    method: resolved.method,
    simulations: resolved.simulations,
    horizonBars: resolved.horizonBars,
    ruinDrawdownPct: resolved.ruinDrawdownPct,
    maxRuinProbability: resolved.maxRuinProbability,
    minProfitProbability: resolved.minProfitProbability,
    confidenceLevel: resolved.confidenceLevel,
    profitProbability,
    riskOfRuin,
    expectedFinalReturnPct:
      stats.reduce((sum, path) => sum + path.finalReturnPct, 0) / stats.length,
    medianFinalReturnPct: percentileFromSorted(finalReturns, 0.5),
    confidenceInterval: {
      finalReturnPct: [
        percentileFromSorted(finalReturns, lowerQ),
        percentileFromSorted(finalReturns, upperQ),
      ],
      maxDrawdownPct: [
        percentileFromSorted(drawdowns, lowerQ),
        percentileFromSorted(drawdowns, upperQ),
      ],
    },
    gatePassed:
      profitProbability >= resolved.minProfitProbability &&
      riskOfRuin <= resolved.maxRuinProbability,
  }
}

function resolveConfig(config: RiskSimulationConfig): Required<RiskSimulationConfig> {
  const method = config.method ?? DEFAULT_CONFIG.method
  if (method !== 'iid_bootstrap' && method !== 'moving_block_bootstrap') {
    throw new Error(`Unsupported risk simulation method: ${String(method)}`)
  }

  return {
    method,
    simulations: toInt(
      config.simulations ?? DEFAULT_CONFIG.simulations,
      'simulations',
      100,
    ),
    horizonBars: toInt(
      config.horizonBars ?? DEFAULT_CONFIG.horizonBars,
      'horizonBars',
      10,
    ),
    blockSize: toInt(config.blockSize ?? DEFAULT_CONFIG.blockSize, 'blockSize', 2),
    ruinDrawdownPct: toBounded(
      config.ruinDrawdownPct ?? DEFAULT_CONFIG.ruinDrawdownPct,
      'ruinDrawdownPct',
      1,
      99,
    ),
    minProfitProbability: toBounded(
      config.minProfitProbability ?? DEFAULT_CONFIG.minProfitProbability,
      'minProfitProbability',
      0,
      1,
    ),
    maxRuinProbability: toBounded(
      config.maxRuinProbability ?? DEFAULT_CONFIG.maxRuinProbability,
      'maxRuinProbability',
      0,
      1,
    ),
    confidenceLevel: toBounded(
      config.confidenceLevel ?? DEFAULT_CONFIG.confidenceLevel,
      'confidenceLevel',
      0.5,
      0.9999,
    ),
    seed: toInt(config.seed ?? DEFAULT_CONFIG.seed, 'seed', 1),
  }
}

function validateReturns(values: number[]): number[] {
  if (!Array.isArray(values) || values.length < 20) {
    throw new Error('historicalReturns must have at least 20 points.')
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error(`historicalReturns contains non-finite at index ${i}`)
    }
  }
  return values
}

function sampleIid(
  returns: number[],
  horizonBars: number,
  rng: () => number,
): number[] {
  const out: number[] = []
  for (let i = 0; i < horizonBars; i++) {
    const idx = Math.floor(rng() * returns.length)
    out.push(returns[idx])
  }
  return out
}

function sampleMovingBlock(
  returns: number[],
  horizonBars: number,
  blockSize: number,
  rng: () => number,
): number[] {
  if (blockSize >= returns.length) {
    return sampleIid(returns, horizonBars, rng)
  }

  const out: number[] = []
  while (out.length < horizonBars) {
    const start = Math.floor(rng() * (returns.length - blockSize))
    for (let i = 0; i < blockSize && out.length < horizonBars; i++) {
      out.push(returns[start + i])
    }
  }
  return out
}

function simulatePath(pathReturns: number[]): RiskSimulationPathStats {
  let equity = 1
  let peak = 1
  let maxDrawdown = 0
  for (const value of pathReturns) {
    equity *= 1 + value
    peak = Math.max(peak, equity)
    const drawdown = peak > 0 ? (peak - equity) / peak : 0
    maxDrawdown = Math.max(maxDrawdown, drawdown)
  }
  return {
    finalReturnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
  }
}

function createXorShift32(seed: number): () => number {
  let state = seed | 0
  if (state === 0) {
    state = 123456789
  }
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

function percentileFromSorted(sorted: number[], q: number): number {
  if (sorted.length < 1) {
    return 0
  }
  const qq = Math.min(1, Math.max(0, q))
  const pos = (sorted.length - 1) * qq
  const low = Math.floor(pos)
  const high = Math.ceil(pos)
  if (low === high) {
    return sorted[low]
  }
  const weight = pos - low
  return sorted[low] * (1 - weight) + sorted[high] * weight
}

function toInt(value: number, name: string, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be integer >= ${min}`)
  }
  return value
}

function toBounded(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be in [${min}, ${max}]`)
  }
  return value
}
