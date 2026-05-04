import { existsSync, readFileSync } from 'node:fs'

export interface AlphaPoolWindow {
  start: string
  end: string
}

export interface AlphaPoolEntry {
  alphaId: string
  expression: string
  source: 'handcrafted' | 'alpha_qcm' | 'evolutionary'
  hypothesis?: string
  featureNames: string[]
  trainWindow: AlphaPoolWindow
  testWindow: AlphaPoolWindow
  oosIc: number
  costAdjustedSharpe: number
  turnover: number
  noveltyScore?: number
  hypothesisAlignmentScore?: number
  complexityScore?: number
  symbolicLength?: number
  parameterCount?: number
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
  admissionGatePassedCount: number
  admissionGateFailedCount: number
  runtimeAcceptedAdmissionGateFailedCount: number
  qcmCandidateCount: number
  shadowOnlyCount: number
  shadowEligibleCount: number
  bestOosIc: number | null
}

export interface AlphaFactorAdmissionConfig {
  minNoveltyScore: number
  minHypothesisAlignmentScore: number
  maxComplexityScore: number
  maxSymbolicLength: number
  maxParameterCount: number
}

export interface AlphaFactorAdmissionDecision {
  passed: boolean
  noveltyScore: number
  hypothesisAlignmentScore: number
  complexityScore: number
  symbolicLength: number
  parameterCount: number
  maxAstSimilarity: number
  reasons: string[]
}

function readBooleanFlag(
  input: Record<string, unknown>,
  key: string,
): boolean {
  return typeof input[key] === 'boolean' ? input[key] : false
}

export const DEFAULT_ALPHA_POOL_PATH = 'data/research/alpha_pool/latest.json'

export const DEFAULT_ALPHA_FACTOR_ADMISSION_CONFIG: AlphaFactorAdmissionConfig = {
  minNoveltyScore: 0.35,
  minHypothesisAlignmentScore: 0.6,
  maxComplexityScore: 0.8,
  maxSymbolicLength: 64,
  maxParameterCount: 8,
}

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
      admissionGatePassedCount: 0,
      admissionGateFailedCount: 0,
      runtimeAcceptedAdmissionGateFailedCount: 0,
      qcmCandidateCount: 0,
      shadowOnlyCount: 0,
      shadowEligibleCount: 0,
      bestOosIc: null,
    }
  }

  const accepted = artifact.entries.filter((entry) => entry.acceptedForRuntime)
  const admissionDecisions = artifact.entries.map((entry) => ({
    entry,
    decision: evaluateAlphaFactorAdmission(entry, {
      existingEntries: artifact.entries,
    }),
  }))
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
    admissionGatePassedCount: admissionDecisions.filter((item) => item.decision.passed).length,
    admissionGateFailedCount: admissionDecisions.filter((item) => !item.decision.passed).length,
    runtimeAcceptedAdmissionGateFailedCount: admissionDecisions.filter(
      (item) => item.entry.acceptedForRuntime && !item.decision.passed,
    ).length,
    qcmCandidateCount: qcmCandidates.length,
    shadowOnlyCount: shadowOnly.length,
    shadowEligibleCount: shadowEligible.length,
    bestOosIc,
  }
}

export function evaluateAlphaFactorAdmission(
  entry: AlphaPoolEntry,
  options: {
    existingEntries?: AlphaPoolEntry[]
    config?: Partial<AlphaFactorAdmissionConfig>
  } = {},
): AlphaFactorAdmissionDecision {
  const config = {
    ...DEFAULT_ALPHA_FACTOR_ADMISSION_CONFIG,
    ...options.config,
  }
  const tokens = tokenizeExpression(entry.expression)
  const symbolicLength = entry.symbolicLength ?? tokens.length
  const parameterCount = entry.parameterCount ?? countNumericParameters(tokens)
  const maxAstSimilarity = maxExpressionSimilarity(entry, options.existingEntries ?? [])
  const noveltyScore = clamp01(entry.noveltyScore ?? (1 - maxAstSimilarity))
  const hypothesisAlignmentScore = clamp01(
    entry.hypothesisAlignmentScore ?? estimateHypothesisAlignment(entry),
  )
  const complexityScore = clamp01(
    entry.complexityScore
    ?? Math.max(symbolicLength / config.maxSymbolicLength, parameterCount / config.maxParameterCount),
  )
  const reasons: string[] = []

  if (noveltyScore < config.minNoveltyScore) {
    reasons.push(`novelty_score ${noveltyScore.toFixed(2)} below ${config.minNoveltyScore}`)
  }
  if (hypothesisAlignmentScore < config.minHypothesisAlignmentScore) {
    reasons.push(
      `hypothesis_alignment_score ${hypothesisAlignmentScore.toFixed(2)} below ${config.minHypothesisAlignmentScore}`,
    )
  }
  if (complexityScore > config.maxComplexityScore) {
    reasons.push(`complexity_score ${complexityScore.toFixed(2)} above ${config.maxComplexityScore}`)
  }
  if (symbolicLength > config.maxSymbolicLength) {
    reasons.push(`symbolic_length ${symbolicLength} above ${config.maxSymbolicLength}`)
  }
  if (parameterCount > config.maxParameterCount) {
    reasons.push(`parameter_count ${parameterCount} above ${config.maxParameterCount}`)
  }

  return {
    passed: reasons.length === 0,
    noveltyScore,
    hypothesisAlignmentScore,
    complexityScore,
    symbolicLength,
    parameterCount,
    maxAstSimilarity,
    reasons,
  }
}

function maxExpressionSimilarity(entry: AlphaPoolEntry, existingEntries: AlphaPoolEntry[]): number {
  const peers = existingEntries.filter((candidate) => candidate.alphaId !== entry.alphaId)
  if (peers.length === 0) {
    return 0
  }
  const left = expressionShingles(entry.expression)
  return Math.max(...peers.map((peer) => jaccard(left, expressionShingles(peer.expression))))
}

function estimateHypothesisAlignment(entry: AlphaPoolEntry): number {
  if (!entry.hypothesis || entry.hypothesis.trim().length === 0) {
    return entry.source === 'handcrafted' ? 1 : 0
  }
  const hypothesisTokens = new Set(tokenizeExpression(entry.hypothesis))
  if (hypothesisTokens.size === 0) {
    return 0
  }
  const expressionTokens = new Set([
    ...tokenizeExpression(entry.expression),
    ...entry.featureNames.flatMap(tokenizeExpression),
  ])
  const overlap = [...hypothesisTokens].filter((token) => expressionTokens.has(token)).length
  return overlap / hypothesisTokens.size
}

function expressionShingles(expression: string): Set<string> {
  const tokens = tokenizeExpression(expression)
  if (tokens.length <= 2) {
    return new Set(tokens)
  }
  const shingles = new Set<string>()
  for (let index = 0; index <= tokens.length - 3; index += 1) {
    shingles.add(tokens.slice(index, index + 3).join('|'))
  }
  return shingles
}

function tokenizeExpression(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/u)
    .map((token) => token.trim())
    .filter(Boolean)
}

function countNumericParameters(tokens: string[]): number {
  return tokens.filter((token) => /^-?\d+(\.\d+)?$/u.test(token)).length
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1
  }
  let intersection = 0
  for (const item of left) {
    if (right.has(item)) {
      intersection += 1
    }
  }
  const union = left.size + right.size - intersection
  return union > 0 ? intersection / union : 0
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}
