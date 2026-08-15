import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSyncOkxLaunchdEnv } from './sync_okx_launchd_env.js'

describe('sync_okx_launchd_env', () => {
  it('dry-runs a redacted OKX credential sync without writing target env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-env-sync-'))
    const sourcePath = join(root, 'source.env')
    const targetPath = join(root, 'openalice.env')
    await writeFile(sourcePath, [
      'EXCHANGE_API_KEY=sourceKey123456789',
      'EXCHANGE_API_SECRET=sourceSecret123456789',
      'EXCHANGE_PASSWORD=sourcePassphrase',
    ].join('\n'), 'utf-8')
    await writeFile(targetPath, [
      'DEEPSEEK_API_KEY=keep-me',
      'EXCHANGE_API_KEY=oldKey',
    ].join('\n'), 'utf-8')
    await chmod(sourcePath, 0o600)
    await chmod(targetPath, 0o600)

    const report = await runSyncOkxLaunchdEnv({
      sourcePath,
      targetPath,
      dryRun: true,
      backup: true,
      json: true,
    })

    expect(report).toMatchObject({
      dryRun: true,
      status: 'ready_to_sync',
      targetWritten: false,
      backupPath: null,
      mismatchedKeys: ['EXCHANGE_API_KEY', 'EXCHANGE_API_SECRET', 'EXCHANGE_PASSWORD'],
      blockers: [],
    })
    expect(JSON.stringify(report)).not.toContain('sourceKey123456789')
    expect(JSON.stringify(report)).not.toContain('sourceSecret123456789')
    expect(JSON.stringify(report)).not.toContain('sourcePassphrase')
    expect(await readFile(targetPath, 'utf-8')).toContain('EXCHANGE_API_KEY=oldKey')
  })

  it('merges OKX credentials into target only when dryRun is false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-env-sync-write-'))
    const sourcePath = join(root, 'source.env')
    const targetPath = join(root, 'openalice.env')
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(sourcePath, [
      'EXCHANGE_API_KEY=sourceKey123456789',
      'EXCHANGE_API_SECRET=sourceSecret123456789',
      'EXCHANGE_PASSWORD=sourcePassphrase',
    ].join('\n'), 'utf-8')
    await writeFile(targetPath, [
      'DEEPSEEK_API_KEY=keep-me',
      'EXCHANGE_API_KEY=oldKey',
    ].join('\n'), 'utf-8')
    await chmod(sourcePath, 0o600)
    await chmod(targetPath, 0o600)

    const report = await runSyncOkxLaunchdEnv({
      sourcePath,
      targetPath,
      dryRun: false,
      backup: true,
      json: true,
    })

    expect(report).toMatchObject({
      dryRun: false,
      status: 'synced',
      targetWritten: true,
      blockers: [],
    })
    expect(report.backupPath).toEqual(expect.stringContaining('openalice.env.bak.'))
    const targetRaw = await readFile(targetPath, 'utf-8')
    expect(targetRaw).toContain('DEEPSEEK_API_KEY=keep-me')
    expect(targetRaw).toContain('EXCHANGE_API_KEY=sourceKey123456789')
    expect(targetRaw).toContain('EXCHANGE_API_SECRET=sourceSecret123456789')
    expect(targetRaw).toContain('EXCHANGE_PASSWORD=sourcePassphrase')
  })

  it('blocks sync when source env is not restricted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-env-sync-blocked-'))
    const sourcePath = join(root, 'source.env')
    const targetPath = join(root, 'openalice.env')
    await writeFile(sourcePath, [
      'EXCHANGE_API_KEY=sourceKey123456789',
      'EXCHANGE_API_SECRET=sourceSecret123456789',
      'EXCHANGE_PASSWORD=sourcePassphrase',
    ].join('\n'), 'utf-8')
    await writeFile(targetPath, '', 'utf-8')
    await chmod(sourcePath, 0o644)
    await chmod(targetPath, 0o600)

    const report = await runSyncOkxLaunchdEnv({
      sourcePath,
      targetPath,
      dryRun: false,
      backup: true,
      json: true,
    })

    expect(report.status).toBe('blocked')
    expect(report.targetWritten).toBe(false)
    expect(report.blockers).toContain('source_env_not_restricted')
    expect(await readFile(targetPath, 'utf-8')).toBe('')
  })
})
