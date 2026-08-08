import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectArtifactHashes, copyReleaseTree, parseArgs } from './manage_local_release.js'

describe('manage_local_release', () => {
  it('keeps build, activation and rollback as distinct explicit commands', () => {
    const build = parseArgs([
      'build',
      '--releaseId',
      '1'.repeat(40),
      '--receipt',
      '/tmp/a.json',
      '--receipt',
      '/tmp/b.json',
      '--requiredChecks',
      'typescript,pipeline_registry',
      '--credentialRotationReceiptPath',
      '/tmp/credential-rotation.json',
    ])
    expect(build.command).toBe('build')
    expect(build.receiptPaths).toEqual(['/tmp/a.json', '/tmp/b.json'])
    expect(build.requiredChecks).toEqual(['typescript', 'pipeline_registry'])
    expect(build.credentialRotationReceiptPath).toBe('/tmp/credential-rotation.json')
    expect(build.drill).toBe(false)

    expect(parseArgs(['rollback', '--drill', 'true']).drill).toBe(true)
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
