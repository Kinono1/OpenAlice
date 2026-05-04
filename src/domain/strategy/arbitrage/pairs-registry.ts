/**
 * PairsRegistry - loads and caches the offline cointegration scan results.
 *
 * The Python scanner (scripts/scan_cointegration_pairs.py) writes
 * data/runtime/pairs_registry.json daily. This module reads it and
 * provides typed access to the cointegrated pairs for the TS runtime.
 */

import { readFile } from 'node:fs/promises'
import type { CointegrationResult } from './types.js'

export interface PairsRegistryEntry extends CointegrationResult {
  symbolA: string
  symbolB: string
  updatedAt: string
}

export interface PairsRegistry {
  generatedAt: string
  interval: string
  lookbackBars: number
  pThreshold: number
  pairs: PairsRegistryEntry[]
}

const DEFAULT_PATH = 'data/runtime/pairs_registry.json'

let _cache: PairsRegistry | null = null
let _cacheLoadedAt = 0
const CACHE_TTL_MS = 60 * 60 * 1000  // re-read at most once per hour

/**
 * Load the pairs registry from disk. Caches in memory for TTL.
 * Returns null if the file does not exist or is malformed.
 */
export async function loadPairsRegistry(path = DEFAULT_PATH): Promise<PairsRegistry | null> {
  const now = Date.now()
  if (_cache && now - _cacheLoadedAt < CACHE_TTL_MS) return _cache

  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as PairsRegistry
    if (!Array.isArray(parsed.pairs)) return null
    _cache = parsed
    _cacheLoadedAt = now
    return _cache
  } catch {
    return null
  }
}

/** Invalidate the in-memory cache (e.g. after scanner re-runs). */
export function invalidatePairsRegistryCache(): void {
  _cache = null
  _cacheLoadedAt = 0
}

/**
 * Get all cointegrated pairs from the registry.
 * Returns empty array if registry is unavailable.
 */
export async function getCointegrationPairs(path = DEFAULT_PATH): Promise<PairsRegistryEntry[]> {
  const registry = await loadPairsRegistry(path)
  return registry?.pairs.filter(p => p.isCointegrated) ?? []
}

/**
 * Find a specific pair by symbols (order-insensitive).
 */
export async function findPair(
  symbolA: string,
  symbolB: string,
  path = DEFAULT_PATH,
): Promise<PairsRegistryEntry | null> {
  const pairs = await getCointegrationPairs(path)
  return pairs.find(p =>
    (p.symbolA === symbolA && p.symbolB === symbolB) ||
    (p.symbolA === symbolB && p.symbolB === symbolA)
  ) ?? null
}
