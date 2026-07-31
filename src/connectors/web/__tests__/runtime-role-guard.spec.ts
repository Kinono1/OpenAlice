import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createRuntimeRoleGuard } from '../routes/security.js'

function makeGuardedApp(role: 'primary' | 'canary' | 'test') {
  const app = new Hono()
  app.use('/api/*', createRuntimeRoleGuard(role))
  app.get('/api/system/status', (c) => c.json({ ok: true, role }))
  app.put('/api/config/agent', (c) => c.json({ mutated: true }))
  app.post('/api/trading/accounts/example/reconnect', (c) => c.json({ mutated: true }))
  app.post('/api/cron/jobs/example/run', (c) => c.json({ mutated: true }))
  app.put('/api/strategy/config', (c) => c.json({ mutated: true }))
  return app
}

describe('runtime role API guard', () => {
  it.each(['canary', 'test'] as const)(
    'allows status reads but rejects config/trade/Cron/strategy mutations for %s',
    async (role) => {
      const app = makeGuardedApp(role)

      expect((await app.request('/api/system/status')).status).toBe(200)
      for (const [path, method] of [
        ['/api/config/agent', 'PUT'],
        ['/api/trading/accounts/example/reconnect', 'POST'],
        ['/api/cron/jobs/example/run', 'POST'],
        ['/api/strategy/config', 'PUT'],
      ]) {
        const response = await app.request(path, { method })
        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toMatchObject({
          code: 'runtime_read_only',
          runtimeRole: role,
        })
      }
    },
  )

  it('preserves primary mutations', async () => {
    const app = makeGuardedApp('primary')

    expect((await app.request('/api/config/agent', { method: 'PUT' })).status).toBe(200)
    expect((await app.request('/api/cron/jobs/example/run', { method: 'POST' })).status).toBe(200)
  })
})
