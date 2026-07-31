import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface CliArgs { url: string; authTokenEnv: string; outputPath: string; text: string }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const generatedAt = new Date().toISOString()
  const token = process.env[args.authTokenEnv]
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  let result: Record<string, unknown>
  try {
    const response = await fetch(args.url, { method: 'POST', headers, body: JSON.stringify({ channel: 'telegram', kind: 'notification', source: 'manual', text: args.text }), signal: AbortSignal.timeout(15_000) })
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    result = { generatedAt, delivered: response.ok && body.delivered === true, reason: typeof body.reason === 'string' ? body.reason : response.ok ? 'remote_rejected' : `http_${response.status}`, channel: body.channel ?? 'telegram', statusCode: response.status }
  } catch (error) {
    result = { generatedAt, delivered: false, reason: /timeout/i.test(String(error)) ? 'send_timeout' : 'remote_rejected', channel: 'telegram', error: error instanceof Error ? error.message : String(error) }
  }
  await mkdir(dirname(args.outputPath), { recursive: true })
  await writeFile(args.outputPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.delivered !== true) process.exitCode = 1
}

function parseArgs(argv: string[]): CliArgs {
  const raw = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token?.startsWith('--')) continue; const next = argv[i + 1]; if (next && !next.startsWith('--')) { raw.set(token.slice(2), next); i += 1 } }
  return {
    url: raw.get('url') ?? 'http://127.0.0.1:3002/api/dev/send',
    authTokenEnv: raw.get('authTokenEnv') ?? 'AUTH_TOKEN',
    outputPath: resolve(raw.get('outputPath') ?? 'data/runtime/telegram_push_probe.latest.json'),
    text: raw.get('text') ?? `OpenAlice manual push probe ${new Date().toISOString()}`,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error); process.exitCode = 1 })
