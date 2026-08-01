#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT_RE = /^[a-f0-9]{40}$/
const SHA256_RE = /^[a-f0-9]{64}$/

async function main() {
  const binDir = dirname(fileURLToPath(import.meta.url))
  const releaseRoot = await realpath(resolve(
    process.env.OPENALICE_RELEASE_DIR ?? join(binDir, '..', 'releases'),
  ))
  const releasePath = await realpath(join(releaseRoot, 'current'))
  assertWithin(releaseRoot, releasePath)
  const manifestPath = join(releasePath, 'release_manifest.v1.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  validateManifestShape(manifest)

  const { schemaVersion: _schemaVersion, manifestHash, ...core } = manifest
  if (sha256Canonical(core) !== manifestHash) {
    throw new Error('release_manifest_hash_mismatch')
  }
  if (resolve(releasePath) !== resolve(releaseRoot, manifest.releaseId)) {
    throw new Error('release_pointer_target_mismatch')
  }
  for (const [relativePath, expectedHash] of Object.entries(manifest.artifactHashes)) {
    const artifactPath = resolve(releasePath, relativePath)
    assertWithin(releasePath, artifactPath)
    const actualHash = createHash('sha256').update(await readFile(artifactPath)).digest('hex')
    if (actualHash !== expectedHash) {
      throw new Error(`release_artifact_hash_mismatch:${relativePath}`)
    }
  }

  process.env.OPENALICE_SOURCE_COMMIT = manifest.sourceCommit
  process.env.OPENALICE_DIRTY_STATE_HASH = manifest.dirtyStateHash
  process.env.OPENALICE_RELEASE_MANIFEST_HASH = manifest.manifestHash
  process.env.OPENALICE_RELEASE_PATH = releasePath
  process.env.OPENALICE_RUNTIME_ROLE = process.env.OPENALICE_RUNTIME_ROLE ?? 'primary'

  if (process.argv.includes('--verify-only')) {
    process.stdout.write(`${JSON.stringify({
      status: 'pass',
      releasePath,
      sourceCommit: manifest.sourceCommit,
      manifestHash: manifest.manifestHash,
      runtimeRole: process.env.OPENALICE_RUNTIME_ROLE,
      liveExecutionArmed: false,
    })}\n`)
    return
  }

  const entryPath = resolve(releasePath, manifest.runtimeEntry)
  assertWithin(releasePath, entryPath)
  const child = spawn(process.execPath, [entryPath, ...process.argv.slice(2)], {
    cwd: releasePath,
    env: process.env,
    stdio: 'inherit',
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exitCode = code ?? 1
  })
}

function validateManifestShape(value) {
  if (!value || value.schemaVersion !== 'release_manifest.v1') {
    throw new Error('release_manifest_schema_unknown')
  }
  for (const field of [
    'manifestHash',
    'dirtyStateHash',
    'pipelineRegistryHash',
    'dependencyLockHash',
    'strategyConfigHash',
  ]) {
    if (!SHA256_RE.test(value[field])) throw new Error(`release_manifest_invalid:${field}`)
  }
  for (const field of ['releaseId', 'sourceCommit']) {
    if (!COMMIT_RE.test(value[field])) throw new Error(`release_manifest_invalid:${field}`)
  }
  if (value.releaseId !== value.sourceCommit) throw new Error('release_manifest_source_mismatch')
  if (value.liveExecutionArmed !== false) {
    throw new Error('engineering_release_must_not_arm_live_execution')
  }
  if (!isSafeRelativePath(value.runtimeEntry)) throw new Error('release_runtime_entry_unsafe')
  if (!value.artifactHashes || typeof value.artifactHashes !== 'object') {
    throw new Error('release_artifact_hashes_missing')
  }
  if (!SHA256_RE.test(value.artifactHashes[value.runtimeEntry] ?? '')) {
    throw new Error('release_runtime_entry_hash_missing')
  }
  for (const [path, hash] of Object.entries(value.artifactHashes)) {
    if (!isSafeRelativePath(path) || !SHA256_RE.test(hash)) {
      throw new Error(`release_artifact_invalid:${path}`)
    }
  }
}

function sha256Canonical(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')
}

function stableStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in manifest')
    return Object.is(value, -0) ? '0' : JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  throw new Error(`unsupported manifest value: ${typeof value}`)
}

function compareUnicodeCodePoints(left, right) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index]
  }
  return leftPoints.length - rightPoints.length
}

function isSafeRelativePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) {
    return false
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function assertWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) return
  throw new Error(`release_path_escape:${child}`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
