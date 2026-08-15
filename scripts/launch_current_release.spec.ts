import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildReleaseManifest } from '../src/runtime/release_manifest.js'

const execFileAsync = promisify(execFile)

describe('stable current release launcher', () => {
  it('verifies manifest and artifact hashes before resolving current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-launcher-'))
    const commit = '1'.repeat(40)
    const releasePath = join(root, commit)
    await mkdir(join(releasePath, 'dist'), { recursive: true })
    const entry = 'console.log("release")\n'
    await writeFile(join(releasePath, 'dist/main.js'), entry)
    const closureFiles: Record<string, string> = {
      'scripts/runner.sh': '#!/bin/sh\n',
      'src/runtime.ts': 'export {}\n',
      'sidecars/nautilus_paper/runtime.py': 'def main(): pass\n',
      'ops/pipeline.json': '{}\n',
      'default/config.json': '{}\n',
      'node_modules/.bin/tsx': '#!/bin/sh\nexec node\n',
      'package.json': '{"name":"openalice-test"}\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'release-metadata/pipeline_registry.v1.json': '{"schemaVersion":"pipeline_registry.v1","entries":[]}\n',
    }
    for (const [path, content] of Object.entries(closureFiles)) {
      await mkdir(dirname(join(releasePath, path)), { recursive: true })
      await writeFile(join(releasePath, path), content)
    }
    const artifactHashes = {
      'dist/main.js': createHash('sha256').update(entry).digest('hex'),
      ...Object.fromEntries(
        Object.entries(closureFiles).map(([path, content]) => [
          path,
          createHash('sha256').update(content).digest('hex'),
        ]),
      ),
    }
    const manifest = buildReleaseManifest({
      releaseId: commit,
      sourceCommit: commit,
      dirtyStateHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      builtAt: '2026-08-01T12:00:00.000Z',
      runtimeEntry: 'dist/main.js',
      artifactHashes,
      pipelineRegistryHash: '3'.repeat(64),
      dependencyLockHash: '4'.repeat(64),
      strategyConfigHash: '5'.repeat(64),
      validationReceipts: [{
        checkId: 'engineering',
        path: 'receipt.json',
        receiptHash: '6'.repeat(64),
        sourceCommit: commit,
        dirtyStateHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        executedAt: '2026-08-01T11:59:00.000Z',
        expiresAt: '2026-08-02T12:00:00.000Z',
        status: 'pass',
      }],
      admissionDecisionId: null,
      engineeringChecks: ['engineering'],
      liveExecutionArmed: false,
    })
    await writeFile(
      join(releasePath, 'release_manifest.v1.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    await symlink(commit, join(root, 'current'), 'dir')

    const launcher = resolve('ops/release/launch_current.mjs')
    const result = await execFileAsync(process.execPath, [launcher, '--verify-only'], {
      env: { ...process.env, OPENALICE_RELEASE_DIR: root },
    })
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'pass',
      sourceCommit: commit,
      runtimeRole: 'primary',
      liveExecutionArmed: false,
    })

    await symlink(commit, join(root, 'research-current'), 'dir')
    const research = await execFileAsync(process.execPath, [launcher, '--verify-only'], {
      env: {
        ...process.env,
        OPENALICE_RELEASE_DIR: root,
        OPENALICE_RUNTIME_ROLE: 'research',
      },
    })
    expect(JSON.parse(research.stdout)).toMatchObject({
      status: 'pass',
      sourceCommit: commit,
      runtimeRole: 'research',
      liveExecutionArmed: false,
    })

    const canary = await execFileAsync('/bin/bash', [
      resolve('ops/release/launch_canary.sh'),
      '--verify-only',
    ], {
      env: {
        ...process.env,
        HOME: root,
        OPENALICE_ENV_FILE: '',
        OPENALICE_RELEASE_DIR: root,
        OPENALICE_CANARY_RELEASE_DIR: root,
        OPENALICE_CANARY_SOURCE_RELEASE_DIR: root,
        OPENALICE_CANARY_ROOT: join(root, 'canary-state'),
      },
    })
    expect(JSON.parse(canary.stdout)).toMatchObject({
      status: 'pass',
      sourceCommit: commit,
      runtimeRole: 'canary',
      liveExecutionArmed: false,
    })

    for (const relativePath of ['scripts/runner.sh', 'src/runtime.ts', 'ops/pipeline.json']) {
      const path = join(releasePath, relativePath)
      const original = await readFile(path)
      await writeFile(path, Buffer.concat([original, Buffer.from('tampered\n')]))
      await expect(execFileAsync(process.execPath, [launcher, '--verify-only'], {
        env: { ...process.env, OPENALICE_RELEASE_DIR: root },
      })).rejects.toMatchObject({
        stderr: expect.stringContaining(`release_artifact_hash_mismatch:${relativePath}`),
      })
      await writeFile(path, original)
    }

    await writeFile(join(releasePath, 'scripts/undeclared.js'), 'console.log("extra")\n')
    await expect(execFileAsync(process.execPath, [launcher, '--verify-only'], {
      env: { ...process.env, OPENALICE_RELEASE_DIR: root },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('release_artifact_undeclared:scripts/undeclared.js'),
    })

    await rm(join(releasePath, 'scripts/undeclared.js'))
    await writeFile(join(root, 'outside.txt'), 'outside\n')
    await symlink(join(root, 'outside.txt'), join(releasePath, 'scripts/escape.js'))
    await expect(execFileAsync(process.execPath, [launcher, '--verify-only'], {
      env: { ...process.env, OPENALICE_RELEASE_DIR: root },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('release_artifact_symlink_forbidden:scripts/escape.js'),
    })

    await rm(join(releasePath, 'scripts/escape.js'))
    await rm(join(releasePath, 'sidecars'), { recursive: true })
    delete artifactHashes['sidecars/nautilus_paper/runtime.py']
    const { schemaVersion: _schemaVersion, manifestHash: _manifestHash, ...core } = manifest
    const missingSidecarsManifest = buildReleaseManifest({
      ...core,
      artifactHashes,
    })
    await writeFile(
      join(releasePath, 'release_manifest.v1.json'),
      `${JSON.stringify(missingSidecarsManifest, null, 2)}\n`,
    )
    await expect(execFileAsync(process.execPath, [launcher, '--verify-only'], {
      env: { ...process.env, OPENALICE_RELEASE_DIR: root },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('release_executable_closure_missing:sidecars/'),
    })
  })

  it('fails closed when current content no longer matches the manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-launcher-tamper-'))
    const commit = '1'.repeat(40)
    const releasePath = join(root, commit)
    await mkdir(join(releasePath, 'dist'), { recursive: true })
    await writeFile(join(releasePath, 'dist/main.js'), 'tampered\n')
    const manifest = buildReleaseManifest({
      releaseId: commit,
      sourceCommit: commit,
      dirtyStateHash: '2'.repeat(64),
      builtAt: '2026-08-01T12:00:00.000Z',
      runtimeEntry: 'dist/main.js',
      artifactHashes: { 'dist/main.js': '3'.repeat(64) },
      pipelineRegistryHash: '4'.repeat(64),
      dependencyLockHash: '5'.repeat(64),
      strategyConfigHash: '6'.repeat(64),
      validationReceipts: [{
        checkId: 'engineering',
        path: 'receipt.json',
        receiptHash: '7'.repeat(64),
        sourceCommit: commit,
        dirtyStateHash: '2'.repeat(64),
        executedAt: '2026-08-01T11:59:00.000Z',
        expiresAt: '2026-08-02T12:00:00.000Z',
        status: 'pass',
      }],
      admissionDecisionId: null,
      engineeringChecks: ['engineering'],
      liveExecutionArmed: false,
    })
    await writeFile(join(releasePath, 'release_manifest.v1.json'), JSON.stringify(manifest))
    await symlink(commit, join(root, 'current'), 'dir')

    await expect(execFileAsync(process.execPath, [
      resolve('ops/release/launch_current.mjs'),
      '--verify-only',
    ], {
      env: { ...process.env, OPENALICE_RELEASE_DIR: root },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('release_artifact_hash_mismatch'),
    })
  })

  it('checks materialized research launch assets before sourcing env or starting Node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-research-launch-assets-'))
    const commit = '2'.repeat(40)
    const releasePath = join(root, commit)
    const binDir = join(root, 'bin')
    await mkdir(join(releasePath, 'dist'), { recursive: true })
    await mkdir(join(releasePath, 'scripts'), { recursive: true })
    await mkdir(join(releasePath, 'src'), { recursive: true })
    await mkdir(join(releasePath, 'sidecars', 'nautilus_paper'), { recursive: true })
    await mkdir(join(releasePath, 'ops', 'release'), { recursive: true })
    await mkdir(join(releasePath, 'default'), { recursive: true })
    await mkdir(join(releasePath, 'node_modules', '.bin'), { recursive: true })
    await mkdir(join(releasePath, 'release-metadata'), { recursive: true })
    await mkdir(binDir, { recursive: true })

    const sourceAssets: Record<string, string> = {
      'ops/release/launch_current.sh': resolve('ops/release/launch_current.sh'),
      'ops/release/launch_current.mjs': resolve('ops/release/launch_current.mjs'),
      'scripts/openalice_env.sh': resolve('scripts/openalice_env.sh'),
    }
    for (const [relativePath, sourcePath] of Object.entries(sourceAssets)) {
      await copyFile(sourcePath, join(releasePath, relativePath))
    }
    await copyFile(sourceAssets['ops/release/launch_current.sh'], join(binDir, 'launch_openalice_current.sh'))
    await copyFile(sourceAssets['ops/release/launch_current.mjs'], join(binDir, 'launch_current.mjs'))
    await copyFile(sourceAssets['scripts/openalice_env.sh'], join(binDir, 'openalice_env.sh'))
    await chmod(join(binDir, 'launch_openalice_current.sh'), 0o555)
    await chmod(join(binDir, 'launch_current.mjs'), 0o555)
    await chmod(join(binDir, 'openalice_env.sh'), 0o555)

    const closureFiles: Record<string, string> = {
      'dist/main.js': 'console.log("research-release")\n',
      'src/runtime.ts': 'export {}\n',
      'sidecars/nautilus_paper/runtime.py': 'def main(): pass\n',
      'default/config.json': '{}\n',
      'node_modules/.bin/tsx': '#!/bin/sh\nexec node\n',
      'package.json': '{"name":"openalice-research-launch-test"}\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'release-metadata/pipeline_registry.v1.json': '{}\n',
    }
    for (const [relativePath, content] of Object.entries(closureFiles)) {
      await writeFile(join(releasePath, relativePath), content)
    }

    const artifactHashes = Object.fromEntries(
      Object.keys(sourceAssets).concat(Object.keys(closureFiles)).map((relativePath) => {
        const filePath = join(releasePath, relativePath)
        return [relativePath, createHash('sha256').update(readFileSync(filePath)).digest('hex')]
      }),
    )
    const emptyDirtyStateHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const manifest = buildReleaseManifest({
      releaseId: commit,
      sourceCommit: commit,
      dirtyStateHash: emptyDirtyStateHash,
      builtAt: '2026-08-01T12:00:00.000Z',
      runtimeEntry: 'dist/main.js',
      artifactHashes,
      pipelineRegistryHash: '3'.repeat(64),
      dependencyLockHash: '4'.repeat(64),
      strategyConfigHash: '5'.repeat(64),
      validationReceipts: [{
        checkId: 'engineering',
        path: 'receipt.json',
        receiptHash: '6'.repeat(64),
        sourceCommit: commit,
        dirtyStateHash: emptyDirtyStateHash,
        executedAt: '2026-08-01T11:59:00.000Z',
        expiresAt: '2026-08-02T12:00:00.000Z',
        status: 'pass',
      }],
      admissionDecisionId: null,
      engineeringChecks: ['engineering'],
      liveExecutionArmed: false,
    })
    await writeFile(join(releasePath, 'release_manifest.v1.json'), `${JSON.stringify(manifest)}\n`)
    await symlink(commit, join(root, 'research-current'), 'dir')

    const env = {
      ...process.env,
      HOME: root,
      OPENALICE_ENV_FILE: '',
      OPENALICE_RUNTIME_ROLE: 'research',
      OPENALICE_RELEASE_DIR: root,
    }
    const launcher = join(binDir, 'launch_openalice_current.sh')
    const result = await execFileAsync('/bin/bash', [launcher, '--verify-only'], { env })
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'pass',
      runtimeRole: 'research',
      sourceCommit: commit,
    })

    await chmod(join(binDir, 'launch_current.mjs'), 0o644)
    await writeFile(join(binDir, 'launch_current.mjs'), 'tampered\n')
    await expect(execFileAsync('/bin/bash', [launcher, '--verify-only'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('research_launch_asset_hash_mismatch:ops/release/launch_current.mjs'),
    })
  })
})
