import { z } from 'zod'
import { sha256Canonical } from '../sidecar/contracts.js'

export const RELEASE_MANIFEST_V1 = 'release_manifest.v1' as const

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/

const validationReceiptBindingSchema = z.object({
  checkId: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(1000),
  receiptHash: z.string().regex(SHA256_RE),
  sourceCommit: z.string().regex(COMMIT_RE),
  dirtyStateHash: z.string().regex(SHA256_RE),
  executedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  status: z.literal('pass'),
}).strict()

export const releaseManifestV1Schema = z.object({
  schemaVersion: z.literal(RELEASE_MANIFEST_V1),
  manifestHash: z.string().regex(SHA256_RE),
  releaseId: z.string().regex(COMMIT_RE),
  sourceCommit: z.string().regex(COMMIT_RE),
  dirtyStateHash: z.string().regex(SHA256_RE),
  builtAt: z.string().datetime(),
  runtimeEntry: z.string().trim().min(1).max(500),
  artifactHashes: z.record(z.string().trim().min(1), z.string().regex(SHA256_RE)),
  pipelineRegistryHash: z.string().regex(SHA256_RE),
  dependencyLockHash: z.string().regex(SHA256_RE),
  strategyConfigHash: z.string().regex(SHA256_RE),
  validationReceipts: z.array(validationReceiptBindingSchema).min(1),
  admissionDecisionId: z.string().regex(SHA256_RE).nullable(),
  engineeringChecks: z.array(z.string().trim().min(1).max(200)).min(1),
  liveExecutionArmed: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (value.releaseId !== value.sourceCommit) {
    ctx.addIssue({
      code: 'custom',
      path: ['releaseId'],
      message: 'releaseId must equal sourceCommit',
    })
  }
  if (!isSafeRelativePath(value.runtimeEntry)) {
    ctx.addIssue({
      code: 'custom',
      path: ['runtimeEntry'],
      message: 'runtimeEntry must be a safe relative path',
    })
  }
  if (!(value.runtimeEntry in value.artifactHashes)) {
    ctx.addIssue({
      code: 'custom',
      path: ['artifactHashes'],
      message: 'runtimeEntry must be covered by artifactHashes',
    })
  }
  for (const path of Object.keys(value.artifactHashes)) {
    if (!isSafeRelativePath(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifactHashes', path],
        message: 'artifact path must be safe and relative',
      })
    }
  }
  for (const receipt of value.validationReceipts) {
    if (receipt.sourceCommit !== value.sourceCommit) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} sourceCommit mismatch`,
      })
    }
    if (receipt.dirtyStateHash !== value.dirtyStateHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} dirtyStateHash mismatch`,
      })
    }
    if (Date.parse(receipt.expiresAt) <= Date.parse(value.builtAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} is stale at build time`,
      })
    }
  }
})

export type ReleaseManifestV1 = z.infer<typeof releaseManifestV1Schema>
export type ReleaseValidationReceiptBinding = z.infer<
  typeof validationReceiptBindingSchema
>

export type ReleaseManifestCore = Omit<
  ReleaseManifestV1,
  'schemaVersion' | 'manifestHash'
>

export function buildReleaseManifest(core: ReleaseManifestCore): ReleaseManifestV1 {
  return releaseManifestV1Schema.parse({
    schemaVersion: RELEASE_MANIFEST_V1,
    manifestHash: releaseManifestHash(core),
    ...core,
  })
}

export function validateReleaseManifest(input: unknown): ReleaseManifestV1 {
  const manifest = releaseManifestV1Schema.parse(input)
  const { schemaVersion: _schemaVersion, manifestHash, ...core } = manifest
  if (releaseManifestHash(core) !== manifestHash) {
    throw new Error('release_manifest_hash_mismatch')
  }
  return manifest
}

export function releaseManifestHash(core: ReleaseManifestCore): string {
  return sha256Canonical(core)
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false
  const segments = path.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}
