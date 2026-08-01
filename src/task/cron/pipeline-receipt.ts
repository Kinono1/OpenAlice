import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { z } from 'zod'
import { sha256Canonical } from '../../sidecar/contracts.js'

const SHA256_RE = /^[a-f0-9]{64}$/

const pipelineLockSchema = z.object({
  policy: z.enum(['none', 'required']),
  key: z.string().min(1).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.policy === 'required' && value.key === null) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: 'required lock needs a key' })
  }
  if (value.policy === 'none' && value.key !== null) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: 'unlocked entry cannot carry a key' })
  }
})

export const pipelineRunContextV1Schema = z.object({
  schemaVersion: z.literal('pipeline_run_context.v1'),
  registryHash: z.string().regex(SHA256_RE),
  registryEntryId: z.string().min(1).max(500),
  entrypoint: z.string().min(1).max(1000),
  owner: z.string().min(1).max(200),
  safetyLevel: z.enum(['read_only', 'artifact_write', 'paper', 'live_forbidden']),
  networkPolicy: z.enum(['denied', 'readonly_public', 'declared_required']),
  timeoutSeconds: z.number().int().positive().max(86_400),
  lock: pipelineLockSchema,
  inputs: z.array(z.string().min(1).max(2000)),
  outputs: z.array(z.string().min(1).max(2000)),
}).strict()

export type PipelineRunContextV1 = z.infer<typeof pipelineRunContextV1Schema>

const lineageArtifactSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'directory', 'missing', 'unsafe', 'unsupported']),
  sha256: z.string().regex(SHA256_RE).nullable(),
  reason: z.string().min(1).nullable(),
}).strict()

export const pipelineExecutionReceiptV1Schema = z.object({
  schemaVersion: z.literal('pipeline_execution_receipt.v1'),
  receiptId: z.string().regex(SHA256_RE),
  jobId: z.string().min(1),
  jobName: z.string().min(1),
  sourceFireSeq: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  status: z.enum(['pass', 'fail']),
  registryHash: z.string().regex(SHA256_RE),
  registryEntryId: z.string().min(1),
  entrypoint: z.string().min(1),
  owner: z.string().min(1),
  safetyLevel: z.enum(['read_only', 'artifact_write', 'paper', 'live_forbidden']),
  networkPolicy: z.enum(['denied', 'readonly_public', 'declared_required']),
  timeoutSeconds: z.number().int().positive(),
  lock: pipelineLockSchema,
  artifactLineage: z.object({
    status: z.enum(['complete', 'partial']),
    inputs: z.array(lineageArtifactSchema),
    outputs: z.array(lineageArtifactSchema),
  }).strict(),
  reasonCodes: z.array(z.string().min(1)),
}).strict()

export type PipelineExecutionReceiptV1 = z.infer<
  typeof pipelineExecutionReceiptV1Schema
>

export async function buildPipelineExecutionReceipt(options: {
  context: PipelineRunContextV1
  jobId: string
  jobName: string
  sourceFireSeq: number
  startedAt: Date
  endedAt: Date
  status: 'pass' | 'fail'
  repoRoot?: string
  reasonCodes?: string[]
}): Promise<PipelineExecutionReceiptV1> {
  const context = pipelineRunContextV1Schema.parse(options.context)
  const repoRoot = resolve(options.repoRoot ?? process.cwd())
  const inputs = await Promise.all(
    context.inputs.map((path) => hashLineageArtifact(repoRoot, path)),
  )
  const outputs = await Promise.all(
    context.outputs.map((path) => hashLineageArtifact(repoRoot, path)),
  )
  const lineageComplete = [...inputs, ...outputs].every(
    (artifact) => artifact.sha256 !== null,
  )
  const core = {
    jobId: options.jobId,
    jobName: options.jobName,
    sourceFireSeq: options.sourceFireSeq,
    startedAt: options.startedAt.toISOString(),
    endedAt: options.endedAt.toISOString(),
    status: options.status,
    registryHash: context.registryHash,
    registryEntryId: context.registryEntryId,
    entrypoint: context.entrypoint,
    owner: context.owner,
    safetyLevel: context.safetyLevel,
    networkPolicy: context.networkPolicy,
    timeoutSeconds: context.timeoutSeconds,
    lock: context.lock,
    artifactLineage: {
      status: lineageComplete ? 'complete' as const : 'partial' as const,
      inputs,
      outputs,
    },
    reasonCodes: [...new Set(options.reasonCodes ?? [])].sort(),
  }
  return pipelineExecutionReceiptV1Schema.parse({
    schemaVersion: 'pipeline_execution_receipt.v1',
    receiptId: sha256Canonical(core),
    ...core,
  })
}

async function hashLineageArtifact(repoRoot: string, rawPath: string) {
  if (!isSafeRelativePath(rawPath)) {
    return {
      path: rawPath,
      kind: 'unsafe' as const,
      sha256: null,
      reason: 'unsafe_relative_path',
    }
  }
  const path = resolve(repoRoot, rawPath)
  try {
    assertWithin(repoRoot, path)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      return {
        path: rawPath,
        kind: 'unsafe' as const,
        sha256: null,
        reason: 'symlink_forbidden',
      }
    }
    if (stat.isFile()) {
      return {
        path: rawPath,
        kind: 'file' as const,
        sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
        reason: null,
      }
    }
    if (stat.isDirectory()) {
      return {
        path: rawPath,
        kind: 'directory' as const,
        sha256: await hashDirectory(repoRoot, path),
        reason: null,
      }
    }
    return {
      path: rawPath,
      kind: 'unsupported' as const,
      sha256: null,
      reason: 'unsupported_file_type',
    }
  } catch (error) {
    if (isEnoent(error)) {
      return {
        path: rawPath,
        kind: 'missing' as const,
        sha256: null,
        reason: 'path_missing',
      }
    }
    return {
      path: rawPath,
      kind: 'unsafe' as const,
      sha256: null,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

async function hashDirectory(repoRoot: string, dir: string): Promise<string> {
  const entries: Array<{ path: string; sha256: string }> = []
  await collectDirectoryHashes(repoRoot, dir, entries)
  return sha256Canonical(entries.sort((left, right) => compareUnicodeCodePoints(
    left.path,
    right.path,
  )))
}

async function collectDirectoryHashes(
  repoRoot: string,
  dir: string,
  entries: Array<{ path: string; sha256: string }>,
): Promise<void> {
  for (const name of (await readdir(dir)).sort()) {
    const path = resolve(dir, name)
    assertWithin(repoRoot, path)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error(`lineage_symlink_forbidden:${relative(repoRoot, path)}`)
    if (stat.isDirectory()) {
      await collectDirectoryHashes(repoRoot, path, entries)
      continue
    }
    if (!stat.isFile()) throw new Error(`lineage_type_unsupported:${relative(repoRoot, path)}`)
    entries.push({
      path: relative(repoRoot, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    })
  }
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((segment) => (
    segment !== '' && segment !== '.' && segment !== '..'
  ))
}

function assertWithin(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) return
  throw new Error(`lineage_path_escape:${child}`)
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index]
    }
  }
  return leftPoints.length - rightPoints.length
}
