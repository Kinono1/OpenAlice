import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { stableStringify } from '../sidecar/contracts.js'

export const EVIDENCE_REF_V1 = 'evidence_ref.v1' as const

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/

export const evidenceRefV1Schema = z.object({
  artifactHash: z.string().regex(SHA256_RE),
  schemaVersion: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1),
  generatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  sourceCommit: z.string().regex(COMMIT_RE),
  dirtyStateHash: z.string().regex(SHA256_RE),
  inputHashes: z.array(z.string().regex(SHA256_RE)),
  parentEvidenceRefs: z.array(z.string().regex(SHA256_RE)),
}).strict()

export type EvidenceRefV1 = z.infer<typeof evidenceRefV1Schema>

export interface StoreEvidenceArtifactInput {
  rootDir: string
  schemaVersion: string
  payload: unknown
  generatedAt: string
  expiresAt: string
  sourceCommit: string
  dirtyStateHash: string
  inputHashes?: string[]
  parentEvidenceRefs?: string[]
}

export type EvidenceArtifactVerification =
  | { status: 'pass' }
  | { status: 'missing' | 'tampered' | 'invalid'; reason: string }

/**
 * Store immutable JSON by its exact byte hash. Existing matching artifacts are
 * retained byte-for-byte; a conflicting file is never overwritten.
 */
export function storeEvidenceArtifact(
  input: StoreEvidenceArtifactInput,
): EvidenceRefV1 {
  const normalizedPayload = normalizeJson(input.payload)
  const text = serializeArtifact(normalizedPayload)
  const artifactHash = sha256Text(text)
  const artifactPath = resolve(
    input.rootDir,
    'sha256',
    artifactHash.slice(0, 2),
    `${artifactHash}.json`,
  )

  if (existsSync(artifactPath)) {
    const existing = readFileSync(artifactPath, 'utf-8')
    if (existing !== text) {
      throw new Error(`content-addressed evidence collision: ${artifactPath}`)
    }
  } else {
    writeImmutableArtifact(artifactPath, text)
  }

  const ref = evidenceRefV1Schema.parse({
    artifactHash,
    schemaVersion: input.schemaVersion,
    path: artifactPath,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    sourceCommit: input.sourceCommit,
    dirtyStateHash: input.dirtyStateHash,
    inputHashes: sortedUnique(input.inputHashes ?? []),
    parentEvidenceRefs: sortedUnique(input.parentEvidenceRefs ?? []),
  })
  assertChronology(ref)
  return ref
}

function writeImmutableArtifact(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = join(
    dirname(path),
    `.${path.split('/').pop()}.${process.pid}.${randomUUID()}.tmp`,
  )
  let fd: number | null = null
  try {
    fd = openSync(tempPath, 'wx')
    writeFileSync(fd, text, 'utf-8')
    fdatasyncSync(fd)
    closeSync(fd)
    fd = null
    try {
      linkSync(tempPath, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = readFileSync(path, 'utf-8')
      if (existing !== text) {
        throw new Error(`content-addressed evidence collision: ${path}`)
      }
    }
  } finally {
    if (fd !== null) closeSync(fd)
    try {
      unlinkSync(tempPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export function verifyEvidenceArtifact(
  input: EvidenceRefV1,
): EvidenceArtifactVerification {
  let parsed: EvidenceRefV1
  try {
    parsed = evidenceRefV1Schema.parse(input)
    assertChronology(parsed)
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    const text = readFileSync(parsed.path, 'utf-8')
    const actualHash = sha256Text(text)
    if (actualHash !== parsed.artifactHash) {
      return {
        status: 'tampered',
        reason: `artifact_hash_mismatch:${actualHash}`,
      }
    }
    return { status: 'pass' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return {
      status: code === 'ENOENT' ? 'missing' : 'invalid',
      reason: code === 'ENOENT'
        ? 'artifact_missing'
        : error instanceof Error
          ? error.message
          : String(error),
    }
  }
}

export function evidenceRefId(ref: EvidenceRefV1): string {
  return ref.artifactHash
}

export function contentAddressedPath(rootDir: string, artifactHash: string): string {
  if (!SHA256_RE.test(artifactHash)) {
    throw new Error(`invalid artifact hash: ${artifactHash}`)
  }
  return join(resolve(rootDir), 'sha256', artifactHash.slice(0, 2), `${artifactHash}.json`)
}

function normalizeJson(value: unknown): unknown {
  return JSON.parse(stableStringify(value)) as unknown
}

function serializeArtifact(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

function assertChronology(ref: EvidenceRefV1): void {
  const generatedAtMs = Date.parse(ref.generatedAt)
  const expiresAtMs = Date.parse(ref.expiresAt)
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new Error('evidence timestamps are invalid')
  }
  if (expiresAtMs <= generatedAtMs) {
    throw new Error('evidence expiresAt must be later than generatedAt')
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}
