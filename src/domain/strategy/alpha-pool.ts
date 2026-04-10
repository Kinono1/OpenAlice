import { existsSync, readFileSync } from 'node:fs'

export interface AlphaPoolWindow {
  start: string
  end: string
}

export interface AlphaPoolEntry {
  alphaId: string
  expression: string
  source: 'handcrafted' | 'alpha_qcm' | 'evolutionary'
  featureNames: string[]
  trainWindow: AlphaPoolWindow
  testWindow: AlphaPoolWindow
  oosIc: number
  costAdjustedSharpe: number
  turnover: number
  regimeSummary: Record<string, unknown>
  acceptedForRuntime: boolean
}

export interface AlphaPoolArtifact {
  generatedAt: string
  artifactVersion: 'v1'
  symbol: string
  entries: AlphaPoolEntry[]
}

export interface AlphaPoolSummary {
  available: boolean
  path: string
  generatedAt: string | null
  totalCandidates: number
  acceptedCount: number
  qcmCandidateCount: number
  shadowOnlyCount: number
  shadowEligibleCount: number
  bestOosIc: number | null
}

function readBooleanFlag(
  input: Record<string, unknown>,
  key: string,
): boolean {
  return typeof input[key] === 'boolean' ? input[key] : false
}

export const DEFAULT_ALPHA_POOL_PATH = 'data/research/alpha_pool/latest.json'

export function readAlphaPoolArtifactSync(
  path = DEFAULT_ALPHA_POOL_PATH,
): AlphaPoolArtifact | null {
  if (!existsSync(path)) {
    return null
  }

  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AlphaPoolArtifact>
  if (parsed.artifactVersion !== 'v1' || !Array.isArray(parsed.entries)) {
    throw new Error(`Invalid alpha pool artifact at ${path}`)
  }

  return {
    generatedAt: parsed.generatedAt ?? new Date(0).toISOString(),
    artifactVersion: 'v1',
    symbol: parsed.symbol ?? 'unknown',
    entries: parsed.entries as AlphaPoolEntry[],
  }
}

export function summarizeAlphaPoolArtifact(
  artifact: AlphaPoolArtifact | null,
  path = DEFAULT_ALPHA_POOL_PATH,
): AlphaPoolSummary {
  if (!artifact) {
    return {
      available: false,
      path,
      generatedAt: null,
      totalCandidates: 0,
      acceptedCount: 0,
      qcmCandidateCount: 0,
      shadowOnlyCount: 0,
      shadowEligibleCount: 0,
      bestOosIc: null,
    }
  }

  const accepted = artifact.entries.filter((entry) => entry.acceptedForRuntime)
  const qcmCandidates = artifact.entries.filter((entry) => entry.source === 'alpha_qcm')
  const shadowOnly = artifact.entries.filter((entry) =>
    entry.source === 'alpha_qcm' && !entry.acceptedForRuntime)
  const shadowEligible = artifact.entries.filter((entry) =>
    readBooleanFlag(entry.regimeSummary, 'shadowEligible'))
  const bestOosIc = artifact.entries.length > 0
    ? Math.max(...artifact.entries.map((entry) => entry.oosIc))
    : null

  return {
    available: true,
    path,
    generatedAt: artifact.generatedAt,
    totalCandidates: artifact.entries.length,
    acceptedCount: accepted.length,
    qcmCandidateCount: qcmCandidates.length,
    shadowOnlyCount: shadowOnly.length,
    shadowEligibleCount: shadowEligible.length,
    bestOosIc,
  }
}
