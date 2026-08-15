import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function ensureReadonlyWebAuth(path: string): Promise<{ path: string; created: boolean; tradeTokenPresent: boolean }> {
  const resolved = resolve(path)
  let raw = ''
  try { raw = await readFile(resolved, 'utf-8') } catch {}
  const hasAuth = /^(?:export\s+)?AUTH_TOKEN=/m.test(raw)
  const tradeTokenPresent = /^(?:export\s+)?TRADE_TOKEN=\S+/m.test(raw)
  if (!hasAuth) {
    const suffix = raw.length === 0 || raw.endsWith('\n') ? '' : '\n'
    const next = `${raw}${suffix}AUTH_TOKEN=${randomBytes(32).toString('base64url')}\n`
    await mkdir(dirname(resolved), { recursive: true })
    const tempPath = `${resolved}.${process.pid}.tmp`
    await writeFile(tempPath, next, { mode: 0o600 })
    await rename(tempPath, resolved)
  }
  await chmod(resolved, 0o600)
  return { path: resolved, created: !hasAuth, tradeTokenPresent }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  ensureReadonlyWebAuth(process.argv[2] ?? `${homedir()}/.config/openalice/openalice.env`)
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
