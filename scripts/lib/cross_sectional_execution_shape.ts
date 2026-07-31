import type { CrossSectionalConfig } from '../../src/domain/strategy/cross-sectional-momentum.js'

export type CrossSectionalExecutionMode = 'paper' | 'legacy_thirds'

export interface CrossSectionalExecutionShape {
  executionMode: CrossSectionalExecutionMode
  topN: number
  bottomN: number
  minUniverseSize: number
}

interface ResolveExecutionShapeOptions {
  mode?: CrossSectionalExecutionMode
  minUniverseSizeOverride?: number | null
}

export function parseCrossSectionalExecutionMode(
  raw: string | null | undefined,
  fallback: CrossSectionalExecutionMode = 'paper',
): CrossSectionalExecutionMode {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase().replace(/-/g, '_')
  if (
    normalized === 'paper' ||
    normalized === 'paper_top1_bottom1_half_universe' ||
    normalized === 'paper_top1_bottom1_half_universe_v1'
  ) {
    return 'paper'
  }
  if (normalized === 'legacy' || normalized === 'legacy_thirds' || normalized === 'thirds') {
    return 'legacy_thirds'
  }
  throw new Error(`Unsupported cross-sectional executionMode: ${raw}`)
}

export function resolveCrossSectionalExecutionShape(
  assetCount: number,
  options: ResolveExecutionShapeOptions = {},
): CrossSectionalExecutionShape {
  if (!Number.isFinite(assetCount) || assetCount < 0) {
    throw new Error(`assetCount must be a non-negative finite number, got ${assetCount}`)
  }
  const count = Math.floor(assetCount)
  const executionMode = options.mode ?? 'paper'
  if (executionMode === 'paper') {
    return {
      executionMode,
      topN: 1,
      bottomN: 1,
      minUniverseSize: Math.max(2, Math.floor(count / 2)),
    }
  }

  const bucketSize = Math.max(1, Math.floor(count / 3))
  return {
    executionMode,
    topN: bucketSize,
    bottomN: bucketSize,
    minUniverseSize: options.minUniverseSizeOverride ?? count,
  }
}

export function applyCrossSectionalExecutionShape<T extends CrossSectionalConfig>(
  config: T,
  assetCount: number,
  options: ResolveExecutionShapeOptions = {},
): T & Pick<CrossSectionalExecutionShape, 'topN' | 'bottomN' | 'minUniverseSize'> {
  const shape = resolveCrossSectionalExecutionShape(assetCount, options)
  return {
    ...config,
    topN: shape.topN,
    bottomN: shape.bottomN,
    minUniverseSize: shape.minUniverseSize,
  }
}
