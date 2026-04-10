import { Hono, type MiddlewareHandler } from 'hono'
import type { EngineContext } from '../../../core/types.js'
import {
  readAccountsConfig, writeAccountsConfig,
  accountConfigSchema,
} from '../../../core/config.js'
import { createBroker } from '../../../domain/trading/brokers/factory.js'
import { BROKER_REGISTRY } from '../../../domain/trading/brokers/registry.js'
import { createRequireAuth, sanitizeSecretsSection, unmaskSecrets } from './security.js'
import { getProcessHealthSnapshot, getWebReadinessSnapshot } from './health.js'
import { getSignalReadinessSnapshot } from './signals.js'

// ==================== Routes ====================

/** Trading config CRUD routes: accounts */
interface TradingConfigRouteOpts {
  requireAuth?: MiddlewareHandler
}

export function createTradingConfigRoutes(ctx: EngineContext, opts?: TradingConfigRouteOpts) {
  const app = new Hono()
  app.use('*', opts?.requireAuth ?? createRequireAuth())

  // ==================== Broker types (for dynamic UI rendering) ====================

  app.get('/broker-types', (c) => {
    const brokerTypes = Object.entries(BROKER_REGISTRY).map(([type, entry]) => ({
      type,
      name: entry.name,
      description: entry.description,
      badge: entry.badge,
      badgeColor: entry.badgeColor,
      fields: entry.configFields,
      subtitleFields: entry.subtitleFields,
      guardCategory: entry.guardCategory,
    }))
    return c.json({ brokerTypes })
  })

  // ==================== Read all ====================

  app.get('/', async (c) => {
    try {
      const accounts = await readAccountsConfig()
      const maskedAccounts = accounts.map((a) => sanitizeSecretsSection({ ...a }))
      return c.json({ accounts: maskedAccounts })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/runtime', async (c) => {
    try {
      const accounts = await readAccountsConfig()
      const accountSummaries = ctx.accountManager.listAccounts()
      const summaryById = new Map(accountSummaries.map((account) => [account.id, account]))

      const runtimeAccounts = accounts.map((account) => ({
        id: account.id,
        label: account.label ?? account.id,
        type: account.type,
        enabled: account.enabled !== false,
        health: summaryById.get(account.id)?.health,
        cryptoExecution: account.cryptoExecution,
        cryptoExecutionRuntime: ctx.accountManager.getExecutionRuntime(account.id),
      }))

      return c.json({
        process: getProcessHealthSnapshot(),
        webReadiness: getWebReadinessSnapshot(ctx),
        signalReadiness: getSignalReadinessSnapshot(ctx),
        accounts: runtimeAccounts,
      })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ==================== Accounts CRUD ====================

  app.put('/accounts/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json()
      if (body.id !== id) {
        return c.json({ error: 'Body id must match URL id' }, 400)
      }

      // Restore masked credentials from existing config
      const accounts = await readAccountsConfig()
      const existing = accounts.find((a) => a.id === id)
      if (existing) {
        unmaskSecrets(body as Record<string, unknown>, existing as unknown as Record<string, unknown>)
      }

      const validated = accountConfigSchema.parse(body)

      const idx = accounts.findIndex((a) => a.id === id)
      if (idx >= 0) {
        accounts[idx] = validated
      } else {
        accounts.push(validated)
      }
      await writeAccountsConfig(accounts)

      // Handle enabled state changes at runtime
      const wasEnabled = existing?.enabled !== false
      const nowEnabled = validated.enabled !== false
      if (wasEnabled && !nowEnabled) {
        // Disabled — close running account
        await ctx.accountManager.removeAccount(id)
      } else if (!wasEnabled && nowEnabled) {
        // Enabled — start account
        ctx.accountManager.reconnectAccount(id).catch(() => {})
      }

      return c.json(sanitizeSecretsSection(validated))
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  app.delete('/accounts/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const accounts = await readAccountsConfig()
      const filtered = accounts.filter((a) => a.id !== id)
      if (filtered.length === accounts.length) {
        return c.json({ error: `Account "${id}" not found` }, 404)
      }
      await writeAccountsConfig(filtered)
      // Close and deregister running account instance if any
      await ctx.accountManager.removeAccount(id)
      return c.json({ success: true })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ==================== Test Connection ====================

  app.post('/test-connection', async (c) => {
    let broker: { init: () => Promise<void>; getAccount: () => Promise<unknown>; close: () => Promise<void> } | null = null
    try {
      const body = await c.req.json()
      const accountConfig = accountConfigSchema.parse({ ...body, id: body.id ?? '__test__' })

      broker = createBroker(accountConfig)
      await broker.init()
      const account = await broker.getAccount()
      return c.json({ success: true, account })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: msg }, 400)
    } finally {
      try { await broker?.close() } catch { /* best effort */ }
    }
  })

  return app
}
