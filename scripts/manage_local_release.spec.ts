import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectArtifactHashes, parseArgs } from './manage_local_release.js'

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
})
