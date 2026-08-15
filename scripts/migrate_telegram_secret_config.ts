import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface TelegramConfig extends Record<string, unknown> {
  botToken?: unknown
  botTokenEnv?: unknown
}

export async function migrateTelegramSecretConfig(path: string): Promise<{
  path: string
  legacyTokenRemoved: boolean
  tokenEnv: string
}> {
  const resolved = resolve(path)
  const raw = JSON.parse(await readFile(resolved, 'utf-8')) as Record<string, unknown>
  const telegram = raw.telegram && typeof raw.telegram === 'object' && !Array.isArray(raw.telegram)
    ? raw.telegram as TelegramConfig
    : {}
  const legacyTokenRemoved = typeof telegram.botToken === 'string' && telegram.botToken.length > 0
  delete telegram.botToken
  telegram.botTokenEnv = typeof telegram.botTokenEnv === 'string' && telegram.botTokenEnv.trim()
    ? telegram.botTokenEnv.trim()
    : 'TELEGRAM_BOT_TOKEN'
  raw.telegram = telegram
  const tempPath = `${resolved}.${process.pid}.tmp`
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(tempPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  await rename(tempPath, resolved)
  return { path: resolved, legacyTokenRemoved, tokenEnv: String(telegram.botTokenEnv) }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2] ?? 'data/config/connectors.json'
  migrateTelegramSecretConfig(path)
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
