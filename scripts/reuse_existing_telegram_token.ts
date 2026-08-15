import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface CliArgs {
  sourcePath: string
  envPath: string
  tokenEnv: string
  pollingEnabled: boolean
}

export async function reuseExistingTelegramToken(args: CliArgs): Promise<{
  envPath: string
  tokenEnv: string
  tokenHashPrefix: string
  pollingEnabled: boolean
}> {
  const sourceStat = await lstat(args.sourcePath)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('Telegram token source must be a regular non-symlink file')
  }
  const source = JSON.parse(await readFile(args.sourcePath, 'utf-8')) as unknown
  const tokens = findTelegramTokens(source)
  const uniqueTokens = [...new Set(tokens)]
  if (uniqueTokens.length !== 1) {
    throw new Error(`Expected exactly one Telegram botToken in source config, found ${uniqueTokens.length}`)
  }
  const token = uniqueTokens[0]
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new Error('Source botToken does not have a valid Telegram token shape')
  }

  let existing = ''
  try {
    const envStat = await lstat(args.envPath)
    if (!envStat.isFile() || envStat.isSymbolicLink()) {
      throw new Error('OpenAlice env path must be a regular non-symlink file')
    }
    existing = await readFile(args.envPath, 'utf-8')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error
  }

  const assignments = new Map<string, string>([
    [args.tokenEnv, token],
    ['OPENALICE_TELEGRAM_POLLING_ENABLED', String(args.pollingEnabled)],
  ])
  const output = upsertEnvAssignments(existing, assignments)
  const temporaryPath = `${args.envPath}.${process.pid}.tmp`
  await mkdir(dirname(args.envPath), { recursive: true })
  await writeFile(temporaryPath, output, { encoding: 'utf-8', mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, args.envPath)
  await chmod(args.envPath, 0o600)

  return {
    envPath: args.envPath,
    tokenEnv: args.tokenEnv,
    tokenHashPrefix: createHash('sha256').update(token).digest('hex').slice(0, 12),
    pollingEnabled: args.pollingEnabled,
  }
}

export function findTelegramTokens(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const tokens: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'botToken' && typeof child === 'string') tokens.push(child.trim())
    else tokens.push(...findTelegramTokens(child))
  }
  return tokens.filter(Boolean)
}

export function upsertEnvAssignments(existing: string, assignments: Map<string, string>): string {
  const remaining = new Map(assignments)
  const lines = existing.split(/\r?\n/)
  const output: string[] = []
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    const key = match?.[1]
    if (key && remaining.has(key)) {
      output.push(`${key}=${remaining.get(key)}`)
      remaining.delete(key)
    } else if (line !== '' || output.length > 0) {
      output.push(line)
    }
  }
  for (const [key, value] of remaining) output.push(`${key}=${value}`)
  return `${output.join('\n').replace(/\n+$/, '')}\n`
}

function parseArgs(argv: string[]): CliArgs {
  const raw = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      raw.set(token.slice(2), next)
      index += 1
    }
  }
  return {
    sourcePath: resolve(raw.get('sourcePath') ?? `${homedir()}/.openclaw/clawdbot.json`),
    envPath: resolve(raw.get('envPath') ?? `${homedir()}/.config/openalice/openalice.env`),
    tokenEnv: raw.get('tokenEnv') ?? 'TELEGRAM_BOT_TOKEN',
    pollingEnabled: (raw.get('pollingEnabled') ?? 'false').toLowerCase() === 'true',
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  reuseExistingTelegramToken(parseArgs(process.argv.slice(2)))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
