import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reuseExistingTelegramToken } from './reuse_existing_telegram_token.js'

describe('reuseExistingTelegramToken', () => {
  it('copies one legacy token into a restricted env file without returning the secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-reuse-telegram-'))
    const sourcePath = join(root, 'clawdbot.json')
    const envPath = join(root, 'openalice.env')
    const token = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'
    await writeFile(sourcePath, JSON.stringify({ channels: { telegram: { botToken: token } } }))
    await writeFile(envPath, 'AUTH_TOKEN=existing\nTELEGRAM_BOT_TOKEN=old\n')

    const result = await reuseExistingTelegramToken({
      sourcePath,
      envPath,
      tokenEnv: 'TELEGRAM_BOT_TOKEN',
      pollingEnabled: false,
    })

    expect(JSON.stringify(result)).not.toContain(token)
    expect(result).toMatchObject({ tokenEnv: 'TELEGRAM_BOT_TOKEN', pollingEnabled: false })
    const env = await readFile(envPath, 'utf-8')
    expect(env).toContain('AUTH_TOKEN=existing')
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${token}`)
    expect(env).toContain('OPENALICE_TELEGRAM_POLLING_ENABLED=false')
    expect((await stat(envPath)).mode & 0o777).toBe(0o600)
  })
})
