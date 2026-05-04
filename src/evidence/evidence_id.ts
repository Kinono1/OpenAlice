import { createHash } from 'node:crypto'
import { isAbsolute, normalize, relative } from 'node:path'

export interface EvidenceIdentityInput {
  strategyFamily: string
  strategyConfigHash: string
  dataManifestHash: string
  featureSchemaHash: string
  validationProfileHash: string
  costModelHash: string
}

export interface EvidenceIdResult {
  evidenceId: string
  hashHex: string
}

export interface EvidenceArtifactMeta {
  evidenceId: string
  strategyFamily: string
  codeCommit: string
  dataManifestHash: string
  featureSchemaHash: string
  validationProfileHash: string
  costModelHash: string
  createdAt: string
  verdict: string
}

const VOLATILE_FIELD_NAMES = new Set([
  'absolute_path',
  'absolutePath',
  'code_commit',
  'codeCommit',
  'created_at',
  'createdAt',
  'generated_at',
  'generatedAt',
  'hostname',
  'local_absolute_path',
  'localAbsolutePath',
  'machine_hostname',
  'machineHostname',
  'runtime_duration_ms',
  'runtimeDurationMs',
])

export function buildEvidenceId(input: EvidenceIdentityInput): EvidenceIdResult {
  const canonicalInput: EvidenceIdentityInput = {
    strategyFamily: input.strategyFamily,
    strategyConfigHash: input.strategyConfigHash,
    dataManifestHash: input.dataManifestHash,
    featureSchemaHash: input.featureSchemaHash,
    validationProfileHash: input.validationProfileHash,
    costModelHash: input.costModelHash,
  }
  const hashHex = sha256Hex(stableStringifyEvidenceInput(canonicalInput))
  return {
    evidenceId: `sha256:${hashHex}`,
    hashHex,
  }
}

export function evidenceIdToPathKey(evidenceId: string): string {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(evidenceId)
  if (match) return match[1].toLowerCase()
  return evidenceId.replaceAll(':', '_').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}

export function hashEvidenceComponent(value: unknown): string {
  return `sha256:${sha256Hex(stableStringifyEvidenceInput(value))}`
}

export function stableStringifyEvidenceInput(input: unknown): string {
  return JSON.stringify(canonicalizeEvidenceInput(input))
}

export function canonicalizeEvidenceInput(input: unknown): unknown {
  return canonicalizeValue(input, null)
}

function canonicalizeValue(value: unknown, keyName: string | null): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item, null))
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && keyName && isPathLikeKey(keyName)) {
      return normalizePathForHash(value)
    }
    return value
  }

  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (VOLATILE_FIELD_NAMES.has(key)) continue
    const child = source[key]
    if (child === undefined) continue
    out[key] = canonicalizeValue(child, key)
  }
  return out
}

function isPathLikeKey(keyName: string): boolean {
  const normalized = keyName.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return /(^|_)(path|dir|directory|file)($|_)/.test(normalized)
}

function normalizePathForHash(value: string): string {
  if (!value.trim()) return value
  if (/^[a-z]+:\/\//i.test(value)) return value

  const slashNormalized = value.replaceAll('\\', '/')
  const normalized = normalize(slashNormalized).replaceAll('\\', '/')
  if (!isAbsolute(normalized)) return normalized

  const cwdRelative = relative(process.cwd(), normalized).replaceAll('\\', '/')
  if (cwdRelative && !cwdRelative.startsWith('..') && cwdRelative !== normalized) {
    return cwdRelative
  }
  return normalized
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}
