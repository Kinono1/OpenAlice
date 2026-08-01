import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRuntimePaths } from '../../../runtime/runtime-paths.js'
import { loadSystemStatus, serializeSystemStatus } from '../../../runtime/system_status.js'
import { createRequireStrongAuth } from './security.js'
import { createSystemRoutes } from './system.js'

describe('GET /api/system/status', () => {
  const originalAuthToken = process.env.AUTH_TOKEN
  const originalDevBypass = process.env.DEV_AUTH_BYPASS
  const originalAllowUnsafeDevBypass = process.env.ALLOW_UNSAFE_DEV_AUTH_BYPASS
  const originalNodeEnv = process.env.NODE_ENV

  afterEach(() => {
    restore('AUTH_TOKEN', originalAuthToken)
    restore('DEV_AUTH_BYPASS', originalDevBypass)
    restore('ALLOW_UNSAFE_DEV_AUTH_BYPASS', originalAllowUnsafeDevBypass)
    restore('NODE_ENV', originalNodeEnv)
  })

  it('rejects absent and weak authentication even when development bypass is enabled', async () => {
    const { app } = await makeApp()
    delete process.env.AUTH_TOKEN
    expect((await app.request('/api/system/status')).status).toBe(401)

    process.env.AUTH_TOKEN = 'too-short'
    process.env.DEV_AUTH_BYPASS = 'true'
    process.env.ALLOW_UNSAFE_DEV_AUTH_BYPASS = 'true'
    process.env.NODE_ENV = 'development'
    expect((await app.request('/api/system/status')).status).toBe(401)
  })

  it('returns the same canonical SystemStatusV1 bytes used by the CLI', async () => {
    const { app, status } = await makeApp()
    const token = 'a'.repeat(40)
    process.env.AUTH_TOKEN = token

    const response = await app.request('/api/system/status', {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe(serializeSystemStatus(status))
  })
})

async function makeApp() {
  const root = await mkdtemp(join(tmpdir(), 'openalice-system-route-'))
  const runtime = resolveRuntimePaths({
    repoRoot: root,
    osTmpDir: tmpdir(),
    env: {
      OPENALICE_RUNTIME_ROLE: 'test',
      OPENALICE_TEST_ROOT: root,
    },
  })
  const status = await loadSystemStatus({
    runtime,
    now: new Date('2026-08-01T00:00:00.000Z'),
  })
  const app = new Hono()
  app.route('/api/system', createSystemRoutes({
    runtime,
    cronEngine: { list: () => [] },
  } as any, {
    requireStrongAuth: createRequireStrongAuth(),
    loadStatus: async () => status,
  }))
  return { app, status }
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
