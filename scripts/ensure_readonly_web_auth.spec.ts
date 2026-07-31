import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureReadonlyWebAuth } from './ensure_readonly_web_auth.ts'

describe('ensure_readonly_web_auth', () => {
  it('creates AUTH_TOKEN without creating TRADE_TOKEN or changing existing secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-auth-'))
    const path = join(root, 'openalice.env')
    await writeFile(path, 'EXISTING_SECRET=preserve-me\n')
    await expect(ensureReadonlyWebAuth(path)).resolves.toMatchObject({ created: true, tradeTokenPresent: false })
    const raw = await readFile(path, 'utf-8')
    expect(raw).toContain('EXISTING_SECRET=preserve-me')
    expect(raw).toMatch(/^AUTH_TOKEN=[A-Za-z0-9_-]{40,}$/m)
    expect(raw).not.toMatch(/^TRADE_TOKEN=/m)
  })
})
