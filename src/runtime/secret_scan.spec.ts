import { chmod, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  inspectCredentialEnvFile,
  scanSecretPaths,
  scanSecretText,
} from './secret_scan.js'

describe('secret scan', () => {
  it('detects a known secret without reproducing it in the result', () => {
    const secret = 'actual-secret-material-123456789'
    const result = scanSecretText({
      kind: 'log',
      sourceLabel: 'runtime.log',
      text: `request failed token=${secret}`,
      secretValues: [secret],
    })
    expect(result.status).toBe('fail')
    expect(result.findingCount).toBe(1)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('detects credential argv but ignores non-secret token-count flags', () => {
    const unsafe = scanSecretText({
      kind: 'argv',
      sourceLabel: 'process_table',
      text: 'worker --api-key value-123456789 --max_output_tokens 30000',
    })
    expect(unsafe).toMatchObject({ status: 'fail', findingCount: 1 })

    const safe = scanSecretText({
      kind: 'argv',
      sourceLabel: 'process_table',
      text: 'worker --max_output_tokens 30000 --token_budget 1000',
    })
    expect(safe).toMatchObject({ status: 'pass', findingCount: 0 })
  })

  it('allows credential-name indirection but rejects raw plist credentials', () => {
    const safe = scanSecretText({
      kind: 'plist',
      sourceLabel: 'safe.plist',
      text: '<key>OPENALICE_LLM_API_KEY_ENV</key><string>DEEPSEEK_API_KEY</string>',
    })
    expect(safe.status).toBe('pass')

    const unsafe = scanSecretText({
      kind: 'plist',
      sourceLabel: 'unsafe.plist',
      text: [
        '<key>OKX_SECRET_KEY</key><string>live-value-123456789</string>',
        '<key>HTTP_PROXY</key><string>http://user:password@127.0.0.1:7892</string>',
      ].join(''),
    })
    expect(unsafe.status).toBe('fail')
    expect(unsafe.findingCount).toBe(2)
  })

  it('requires a regular owner-private env file containing every named credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'credential-store-'))
    const path = join(root, 'openalice.env')
    await writeFile(path, [
      'DEEPSEEK_API_KEY="value-a-123456789"',
      'OKX_SECRET_KEY=value-b-123456789',
    ].join('\n'))
    await chmod(path, 0o600)
    const ready = await inspectCredentialEnvFile({
      path,
      credentialNames: ['DEEPSEEK_API_KEY', 'OKX_SECRET_KEY'],
    })
    expect(ready.stored).toBe(true)
    expect(ready.secretValues).toHaveLength(2)

    await chmod(path, 0o644)
    const exposed = await inspectCredentialEnvFile({
      path,
      credentialNames: ['DEEPSEEK_API_KEY', 'OKX_SECRET_KEY'],
    })
    expect(exposed.stored).toBe(false)
    expect(exposed.reasonCodes).toContain('credential_store_permissions_not_private')

    const link = join(root, 'linked.env')
    await symlink(path, link)
    const linked = await inspectCredentialEnvFile({
      path: link,
      credentialNames: ['DEEPSEEK_API_KEY'],
    })
    expect(linked).toMatchObject({
      stored: false,
      secretValues: [],
      reasonCodes: ['credential_store_symlink_forbidden'],
    })
  })

  it('streams file trees and hashes scan evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secret-tree-'))
    await mkdir(join(root, 'logs'), { recursive: true })
    await writeFile(join(root, 'logs/a.log'), 'safe\n')
    const result = await scanSecretPaths({
      kind: 'log',
      repoRoot: root,
      paths: ['logs'],
    })
    expect(result).toMatchObject({ status: 'pass', scannedSources: 1, findingCount: 0 })
    expect(result.evidenceRef).toMatch(/^secret_scan:log:sha256:[a-f0-9]{64}$/)
  })

  it('allows only explicit external regular files when requested', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'secret-repo-'))
    const externalRoot = await mkdtemp(join(tmpdir(), 'secret-external-'))
    const plist = join(externalRoot, 'openalice.plist')
    await writeFile(plist, '<key>OPENALICE_API_KEY_ENV</key><string>DEEPSEEK_API_KEY</string>')

    const blocked = await scanSecretPaths({
      kind: 'plist',
      repoRoot,
      paths: [plist],
    })
    expect(blocked).toMatchObject({ status: 'fail', scannedSources: 0 })

    const allowed = await scanSecretPaths({
      kind: 'plist',
      repoRoot,
      paths: [plist],
      allowExternalFiles: true,
    })
    expect(allowed).toMatchObject({ status: 'pass', scannedSources: 1 })

    const directory = await scanSecretPaths({
      kind: 'plist',
      repoRoot,
      paths: [externalRoot],
      allowExternalFiles: true,
    })
    expect(directory).toMatchObject({ status: 'fail', scannedSources: 0 })
  })
})
