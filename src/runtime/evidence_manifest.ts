import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

export type EvidenceTrust = 'pass' | 'quarantine' | 'fail'

export interface GitEvidenceSnapshot {
  commit: string | null
  dirty: boolean
  dirtyFilesCount: number
  dirtyHash: string
}

export interface EvidenceManifest {
  schemaVersion: 1
  job: string
  runId: string
  artifactPath: string
  manifestPath: string
  startedAt: string
  finishedAt: string
  durationMs: number
  exitCode: number
  git: GitEvidenceSnapshot
  dqStatus: EvidenceTrust
  evidenceTrust: EvidenceTrust
  businessStatus: 'pass' | 'warn' | 'fail' | 'unknown'
  recordsIn: number | null
  recordsOut: number | null
  artifactHash: string | null
  errorClass: string | null
}

export interface BuildEvidenceManifestInput {
  job: string
  artifactPath: string
  manifestPath?: string
  startedAt: Date | string
  finishedAt: Date | string
  exitCode: number
  businessStatus?: EvidenceManifest['businessStatus']
  recordsIn?: number | null
  recordsOut?: number | null
  errorClass?: string | null
  gitSnapshot?: GitEvidenceSnapshot
  artifactHash?: string | null
}

export function buildEvidenceManifest(input: BuildEvidenceManifestInput): EvidenceManifest {
  const startedAt = toIso(input.startedAt)
  const finishedAt = toIso(input.finishedAt)
  const git = input.gitSnapshot ?? readGitEvidenceSnapshot()
  const artifactPath = resolve(input.artifactPath)
  const manifestPath = resolve(input.manifestPath ?? `${artifactPath}.manifest.json`)
  const exitCode = Number.isFinite(input.exitCode) ? input.exitCode : 1
  const evidenceTrust: EvidenceTrust = exitCode !== 0
    ? 'fail'
    : git.dirty
      ? 'quarantine'
      : 'pass'

  return {
    schemaVersion: 1,
    job: input.job,
    runId: `${finishedAt}__${git.commit ?? 'unknown'}__${process.pid}`,
    artifactPath,
    manifestPath,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exitCode,
    git,
    dqStatus: evidenceTrust,
    evidenceTrust,
    businessStatus: input.businessStatus ?? 'unknown',
    recordsIn: input.recordsIn ?? null,
    recordsOut: input.recordsOut ?? null,
    artifactHash: input.artifactHash ?? hashFileIfExists(artifactPath),
    errorClass: input.errorClass ?? null,
  }
}

export async function writeEvidenceManifestForArtifact(
  input: BuildEvidenceManifestInput,
): Promise<EvidenceManifest> {
  const manifest = buildEvidenceManifest(input)
  await mkdir(dirname(manifest.manifestPath), { recursive: true })
  await writeFile(manifest.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  return manifest
}

export function readGitEvidenceSnapshot(
  cwd = process.cwd(),
  overrides: { statusPorcelain?: string; commit?: string | null } = {},
): GitEvidenceSnapshot {
  const commit = overrides.commit !== undefined
    ? overrides.commit
    : readGitCommand(['rev-parse', 'HEAD'], cwd)
  const status = overrides.statusPorcelain ?? readGitCommand(
    ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd,
  ) ?? ''
  const lines = status.split('\n').map(line => line.trimEnd()).filter(Boolean)
  return {
    commit,
    dirty: lines.length > 0,
    dirtyFilesCount: lines.length,
    dirtyHash: createHash('sha256').update(lines.join('\n')).digest('hex'),
  }
}

function readGitCommand(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null
  } catch {
    return null
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function hashFileIfExists(path: string): string | null {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
