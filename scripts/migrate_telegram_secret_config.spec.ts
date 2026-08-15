import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateTelegramSecretConfig } from './migrate_telegram_secret_config.ts'

describe('migrate_telegram_secret_config', () => {
  it('removes legacy plaintext token and preserves chat ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-telegram-migrate-'))
    const path = join(root, 'connectors.json')
    await writeFile(path, JSON.stringify({ telegram: { enabled: true, botToken: 'old-secret', chatIds: [123] } }))
    await expect(migrateTelegramSecretConfig(path)).resolves.toMatchObject({ legacyTokenRemoved: true, tokenEnv: 'TELEGRAM_BOT_TOKEN' })
    const migrated = JSON.parse(await readFile(path, 'utf-8'))
    expect(migrated.telegram).toEqual({ enabled: true, chatIds: [123], botTokenEnv: 'TELEGRAM_BOT_TOKEN' })
    expect(JSON.stringify(migrated)).not.toContain('old-secret')
  })
})
