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

export type EvidenceSourceKind = 'git_worktree' | 'verified_release'

export interface VerifiedReleaseIdentity {
  sourceKind: 'verified_release'
  sourceCommit: string
  dirtyStateHash: string
  releaseId: string
  releaseManifestHash: string
  releasePathIdentity: string
}

export interface EvidenceManifest {
  schemaVersion: 2
  job: string
  /** Stable logical producer identifier; intentionally not an absolute machine path. */
  producer: string
  /** Exit code reported by the producer that generated the artifact. */
  producerExitCode: number
  /** Completion timestamp for the producer output. */
  generatedAt: string
  runId: string
  artifactPath: string
  manifestPath: string
  startedAt: string
  finishedAt: string
  durationMs: number
  exitCode: number
  git: GitEvidenceSnapshot
  sourceKind: EvidenceSourceKind
  sourceCommit: string | null
  dirtyStateHash: string
  releaseId: string | null
  releaseManifestHash: string | null
  releasePathIdentity: string | null
  sourceIdentityValid: boolean
  sourceIdentityError: string | null
  dqStatus: EvidenceTrust
  evidenceTrust: EvidenceTrust
  /** @deprecated Use evidenceTrust instead. businessStatus is user-supplied and can diverge from computed trust. */
  businessStatus: 'pass' | 'warn' | 'fail' | 'unknown'
  recordsIn: number | null
  recordsOut: number | null
  artifactHash: string | null
  errorClass: string | null
}

export interface BuildEvidenceManifestInput {
  job: string
  producer?: string
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
  releaseIdentity?: VerifiedReleaseIdentity
}

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/
const EMPTY_DIRTY_STATE_HASH = createHash('sha256').update('').digest('hex')

export function buildEvidenceManifest(input: BuildEvidenceManifestInput): EvidenceManifest {
  const startedAt = toIso(input.startedAt)
  const finishedAt = toIso(input.finishedAt)
  const releaseIdentity = input.releaseIdentity ?? readVerifiedReleaseIdentity()
  const git = releaseIdentity
    ? {
        commit: releaseIdentity.sourceCommit,
        dirty: releaseIdentity.dirtyStateHash !== EMPTY_DIRTY_STATE_HASH,
        dirtyFilesCount: 0,
        dirtyHash: releaseIdentity.dirtyStateHash,
      }
    : input.gitSnapshot ?? readGitEvidenceSnapshot()
  const artifactPath = resolve(input.artifactPath)
  const manifestPath = resolve(input.manifestPath ?? `${artifactPath}.manifest.json`)
  const exitCode = Number.isFinite(input.exitCode) ? input.exitCode : 1
  const sourceIdentityValid = releaseIdentity
    ? releaseIdentity.dirtyStateHash === EMPTY_DIRTY_STATE_HASH
      && COMMIT_RE.test(releaseIdentity.sourceCommit)
      && COMMIT_RE.test(releaseIdentity.releaseId)
      && releaseIdentity.sourceCommit === releaseIdentity.releaseId
      && SHA256_RE.test(releaseIdentity.dirtyStateHash)
      && SHA256_RE.test(releaseIdentity.releaseManifestHash)
      && Boolean(releaseIdentity.releasePathIdentity)
    // A directory that is not a Git repository is not evidence of a clean
    // worktree. Keep legacy Git-worktree behavior for test/fixture commits,
    // but fail closed when Git identity is unavailable altogether.
    : git.commit !== null
  const sourceIdentityError = !sourceIdentityValid
    ? releaseIdentity ? 'verified_release_identity_invalid' : 'git_identity_missing'
    : null
  const evidenceTrust: EvidenceTrust = exitCode !== 0
    ? 'fail'
    : !sourceIdentityValid
      ? 'quarantine'
      : git.dirty
      ? 'quarantine'
      : 'pass'

  return {
    schemaVersion: 2,
    job: input.job,
    producer: input.producer?.trim() || input.job,
    producerExitCode: exitCode,
    generatedAt: finishedAt,
    runId: `${finishedAt}__${git.commit ?? 'unknown'}__${process.pid}`,
    artifactPath,
    manifestPath,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exitCode,
    git,
    sourceKind: releaseIdentity ? 'verified_release' : 'git_worktree',
    sourceCommit: releaseIdentity?.sourceCommit ?? git.commit,
    dirtyStateHash: releaseIdentity?.dirtyStateHash ?? git.dirtyHash,
    releaseId: releaseIdentity?.releaseId ?? null,
    releaseManifestHash: releaseIdentity?.releaseManifestHash ?? null,
    releasePathIdentity: releaseIdentity?.releasePathIdentity ?? null,
    sourceIdentityValid,
    sourceIdentityError,
    dqStatus: evidenceTrust,
    evidenceTrust,
    businessStatus: input.businessStatus ?? 'unknown',
    recordsIn: input.recordsIn ?? null,
    recordsOut: input.recordsOut ?? null,
    artifactHash: input.artifactHash ?? hashFileIfExists(artifactPath),
    errorClass: input.errorClass ?? null,
  }
}

export function readVerifiedReleaseIdentity(
  env: NodeJS.ProcessEnv = process.env,
): VerifiedReleaseIdentity | null {
  const sourceKind = env.OPENALICE_SOURCE_KIND
  const hasReleaseIdentityField = [
    env.OPENALICE_SOURCE_COMMIT,
    env.OPENALICE_DIRTY_STATE_HASH,
    env.OPENALICE_RELEASE_ID,
    env.OPENALICE_RELEASE_MANIFEST_HASH,
    env.OPENALICE_RELEASE_PATH,
  ].some((value) => Boolean(value))
  const invalidSourceKindRequested = sourceKind !== undefined && sourceKind !== 'git_worktree' && sourceKind !== 'verified_release'
  const requested = hasReleaseIdentityField || sourceKind === 'verified_release' || invalidSourceKindRequested
  if (!requested) return null

  // Any release identity field is meaningful only when the launcher explicitly
  // declared a verified release.  Returning an intentionally invalid identity
  // for contradictory/missing declarations makes the evidence builder
  // quarantine it instead of silently accepting a mixed source.
  const identityIsExplicitlyVerified = sourceKind === 'verified_release' && hasReleaseIdentityField
  if (!identityIsExplicitlyVerified) {
    return {
      sourceKind: 'verified_release',
      sourceCommit: '',
      dirtyStateHash: '',
      releaseId: '',
      releaseManifestHash: '',
      releasePathIdentity: '',
    }
  }
  return {
    sourceKind: 'verified_release',
    sourceCommit: env.OPENALICE_SOURCE_COMMIT ?? '',
    dirtyStateHash: env.OPENALICE_DIRTY_STATE_HASH ?? '',
    releaseId: env.OPENALICE_RELEASE_ID ?? '',
    releaseManifestHash: env.OPENALICE_RELEASE_MANIFEST_HASH ?? '',
    releasePathIdentity: env.OPENALICE_RELEASE_PATH ?? '',
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
