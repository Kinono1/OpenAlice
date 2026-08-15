import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXECUTION_SIDECAR_RUNTIME_COPY_FILES,
  REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2,
} from '../src/runtime/release_manager.js'
import {
  collectArtifactHashes,
  copyHashBoundD1Evidence,
  assertExactD1MaterializedReleaseTree,
  assertNoForbiddenD1ReleaseTree,
  copyReleaseTree,
  hardenD1ReleaseTree,
  parseArgs,
  prepareStableTsxLauncher,
  verifyExecutionSidecarProtoFreshness,
} from './manage_local_release.js'

describe('manage_local_release', () => {
  it('keeps the TypeScript runner in production dependencies for immutable Cron scripts', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    expect(packageJson.dependencies?.tsx).toBe('^4.21.0')
    expect(packageJson.devDependencies?.tsx).toBeUndefined()
  })

  it('keeps build, activation and rollback as distinct explicit commands', () => {
    const build = parseArgs([
      'build',
      '--releaseId',
      '1'.repeat(40),
      '--d1Bundle',
      '/tmp/d1-bundle',
      '--requiredChecks',
      'typescript,pipeline_registry',
      '--credentialRotationReceiptPath',
      '/tmp/credential-rotation.json',
    ])
    expect(build.command).toBe('build')
    expect(build.receiptPaths).toEqual([])
    expect(build.d1BundlePath).toBe('/tmp/d1-bundle')
    expect(build.requiredChecks).toEqual(['typescript', 'pipeline_registry'])
    expect(build.credentialRotationReceiptPath).toBe('/tmp/credential-rotation.json')
    expect(build.runtimeEntry).toBe('ops/release/launch_nautilus_paper.sh')
    expect(build.drill).toBe(false)

    expect(parseArgs(['rollback', '--drill', 'true']).drill).toBe(true)
  })

  it('copies only the formal PAPER_LOCAL Python runtime closure', () => {
    expect(REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2).toContain(
      'ops/release/launch_nautilus_paper.mjs',
    )
    expect(REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2).toContain(
      'ops/release/launch_nautilus_paper.sh',
    )
    expect(EXECUTION_SIDECAR_RUNTIME_COPY_FILES).toContain(
      'sidecars/nautilus_paper/supervisor.py',
    )
    expect(EXECUTION_SIDECAR_RUNTIME_COPY_FILES).toContain(
      'sidecars/nautilus_paper/verify_release_environment.py',
    )
    expect(EXECUTION_SIDECAR_RUNTIME_COPY_FILES.some((path) => (
      path.includes('/test_')
      || path.endsWith('_test_server.py')
      || path.endsWith('runtime_crash_test_server.py')
    ))).toBe(false)
  })

  it('hashes release artifacts deterministically without following symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-artifacts-'))
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist/a.js'), 'a\n')
    await writeFile(join(root, 'dist/b.js'), 'b\n')

    const first = await collectArtifactHashes(root, ['dist'])
    const second = await collectArtifactHashes(root, ['dist'])
    expect(first).toEqual(second)
    expect(Object.keys(first)).toEqual(['dist/a.js', 'dist/b.js'])
  })

  it('copies built runtime artifacts that package deployment excludes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-copy-'))
    const source = join(root, 'source/dist')
    const destination = join(root, 'release/dist')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'main.js'), 'runtime\n')

    await copyReleaseTree(source, destination)

    expect(await readFile(join(destination, 'main.js'), 'utf-8')).toBe('runtime\n')
  })

  it('copies D1 evidence only when the materialized bytes retain the loaded hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-evidence-copy-'))
    const source = join(root, 'source.json')
    const destination = join(root, 'release/evidence.json')
    await writeFile(source, '{"status":"pass"}\n')
    const expected = createHash('sha256').update('{"status":"pass"}\n').digest('hex')
    await expect(copyHashBoundD1Evidence(source, destination, expected, 'bundle')).resolves.toBeUndefined()
    expect(await readFile(destination, 'utf8')).toBe('{"status":"pass"}\n')
    await expect(copyHashBoundD1Evidence(source, join(root, 'release/mismatch.json'), '0'.repeat(64), 'bundle'))
      .rejects.toThrow('d1_release_evidence_changed_during_copy:bundle')
  })

  it('removes group/world write permission while preserving publisher executable bits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-permissions-'))
    const executable = join(root, 'ops/release/launch.sh')
    await mkdir(join(root, 'ops/release'), { recursive: true })
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(root, 0o777)
    await chmod(join(root, 'ops'), 0o777)
    await chmod(join(root, 'ops/release'), 0o777)
    await chmod(executable, 0o775)

    await hardenD1ReleaseTree(root)

    expect((await lstat(root)).mode & 0o022).toBe(0)
    expect((await lstat(join(root, 'ops'))).mode & 0o022).toBe(0)
    expect((await lstat(executable)).mode & 0o022).toBe(0)
    expect((await lstat(executable)).mode & 0o100).toBe(0o100)
  })

  it('fails the release gate when committed Python protobuf bindings are stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-proto-gate-'))
    const passingPython = join(root, 'passing-python')
    const failingPython = join(root, 'failing-python')
    await writeFile(passingPython, '#!/bin/sh\nexit 0\n')
    await writeFile(failingPython, '#!/bin/sh\nexit 1\n')
    await chmod(passingPython, 0o700)
    await chmod(failingPython, 0o700)

    await expect(
      verifyExecutionSidecarProtoFreshness(root, passingPython),
    ).resolves.toBeUndefined()
    await expect(
      verifyExecutionSidecarProtoFreshness(root, failingPython),
    ).rejects.toThrow('execution_sidecar_proto_freshness_check_failed')
  })

  it('materializes a release-relative tsx launcher without source-worktree paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-tsx-launcher-'))
    const cli = join(root, 'node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs')
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true })
    await mkdir(join(root, 'node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist'), { recursive: true })
    await writeFile(cli, '#!/usr/bin/env node\n')

    expect(await prepareStableTsxLauncher(root)).toBe('node_modules/.bin/tsx')
    const wrapper = await readFile(join(root, 'node_modules/.bin/tsx'), 'utf8')
    expect(wrapper).toContain('../.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs')
    expect(wrapper).not.toContain(String(root))
  })

  it('excludes regenerable interpreter caches from the immutable closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-copy-cache-'))
    const source = join(root, 'source/scripts')
    const destination = join(root, 'release/scripts')
    await mkdir(join(source, '__pycache__'), { recursive: true })
    await writeFile(join(source, '__pycache__/cached.pyc'), 'cache\n')
    await writeFile(join(source, 'runner.sh'), '#!/bin/sh\n')

    await copyReleaseTree(source, destination)

    expect(await readFile(join(destination, 'runner.sh'), 'utf-8')).toContain('#!/bin/sh')
    await expect(readFile(join(destination, '__pycache__/cached.pyc'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts the exact materialized D1 tree including its V2 manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-exact-tree-'))
    await mkdir(join(root, 'ops/release'), { recursive: true })
    await writeFile(join(root, 'ops/release/launch_nautilus_paper.sh'), '#!/bin/sh\n')
    await writeFile(join(root, 'release_manifest.v2.json'), '{}\n')

    await expect(assertNoForbiddenD1ReleaseTree(root)).resolves.toBeUndefined()
    await expect(assertExactD1MaterializedReleaseTree(root, [
      'ops/release/launch_nautilus_paper.sh',
      'release_manifest.v2.json',
    ])).resolves.toBeUndefined()
  })

  it.each([
    ['unexpected.txt', 'not declared\n', 'd1_release_materialized_artifact_not_declared'],
    ['src/domain/trading/brokers/ccxt/evil.ts', 'export {}\n', 'd1_release_materialized_artifact_not_declared'],
    ['sidecars/nautilus_paper/__pycache__/runtime.pyc', 'cache\n', 'd1_release_forbidden_artifact'],
    ['scripts/test/helper.ts', 'test\n', 'd1_release_forbidden_artifact'],
  ])('rejects a non-D1 materialized path: %s', async (relativePath, content, error) => {
    const root = await mkdtemp(join(tmpdir(), 'release-exact-tree-attack-'))
    const target = join(root, relativePath)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)

    if (error === 'd1_release_forbidden_artifact') {
      await expect(assertNoForbiddenD1ReleaseTree(root)).rejects.toThrow(error)
    } else {
      await expect(assertExactD1MaterializedReleaseTree(root, [])).rejects.toThrow(error)
    }
  })

  it('rejects an empty materialized directory before D1 sealing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-exact-tree-empty-'))
    await mkdir(join(root, 'unexpected-empty'), { recursive: true })
    await expect(assertExactD1MaterializedReleaseTree(root, [])).rejects.toThrow(
      'd1_release_materialized_directory_not_declared:unexpected-empty',
    )
  })

  it('rejects symlinks while copying built runtime artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-copy-symlink-'))
    const source = join(root, 'source/dist')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'main.js'), 'runtime\n')
    await symlink('main.js', join(source, 'alias.js'))

    await expect(copyReleaseTree(source, join(root, 'release/dist')))
      .rejects.toThrow('release_artifact_symlink_forbidden')
  })
})
