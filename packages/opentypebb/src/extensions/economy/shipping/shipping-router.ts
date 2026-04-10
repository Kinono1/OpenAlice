/**
 * Shipping Sub-Router.
 * Maps to: openbb_economy/shipping/
 *
 * Note: These endpoints are stubs — they register the routes but always
 * throw EmptyDataError until a reliable public data source is integrated.
 */

import { Router } from '../../../core/app/router.js'

export const shippingRouter = new Router({
  prefix: '/shipping',
  description: 'Global shipping and trade route data.',
})

shippingRouter.command({
  model: 'PortInfo',
  path: '/port_info',
  description: 'Get information about a port.',
  handler: async (executor, provider, params, credentials) => {
    return executor.execute(provider, 'PortInfo', params, credentials)
  },
})

shippingRouter.command({
  model: 'PortVolume',
  path: '/port_volume',
  description: 'Get shipping volume data for a port.',
  handler: async (executor, provider, params, credentials) => {
    return executor.execute(provider, 'PortVolume', params, credentials)
  },
})

shippingRouter.command({
  model: 'ChokepointInfo',
  path: '/chokepoint_info',
  description: 'Get information about a maritime chokepoint.',
  handler: async (executor, provider, params, credentials) => {
    return executor.execute(provider, 'ChokepointInfo', params, credentials)
  },
})

shippingRouter.command({
  model: 'ChokepointVolume',
  path: '/chokepoint_volume',
  description: 'Get transit volume data for a maritime chokepoint.',
  handler: async (executor, provider, params, credentials) => {
    return executor.execute(provider, 'ChokepointVolume', params, credentials)
  },
})
