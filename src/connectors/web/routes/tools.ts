import { Hono, type MiddlewareHandler } from 'hono'
import type { ToolCenter } from '../../../core/tool-center.js'
import { readToolsConfig, writeConfigSection } from '../../../core/config.js'

interface ToolsRouteOpts {
  requireAuth?: MiddlewareHandler
}

/** Tools routes: GET / (inventory + disabled), PUT / (update disabled list) */
export function createToolsRoutes(toolCenter: ToolCenter, opts?: ToolsRouteOpts) {
  const app = new Hono()
  if (opts?.requireAuth) {
    app.use('*', opts.requireAuth)
  }

  app.get('/', async (c) => {
    try {
      const inventory = toolCenter.getInventory()
      const { disabled } = await readToolsConfig()
      return c.json({ inventory, disabled })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.put('/', async (c) => {
    try {
      const body = await c.req.json()
      const validated = await writeConfigSection('tools', body)
      return c.json(validated)
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}
