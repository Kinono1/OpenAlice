import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler } from 'hono'
import { resolveGatewayClientIp } from '../../../openclaw/gateway/net.js'
import {
  createRequireAuth as createCoreRequireAuth,
  createRequireTrade as createCoreRequireTrade,
  getAuthTokens,
  isAuthEnabled as isCoreAuthEnabled,
} from '../../../core/auth.js'

const SENSITIVE_KEY_RE = /key|secret|password|token/i
const SECRET_CONTAINER_KEYS = new Set([
  'apiKeys',
  'providerKeys',
  'brokerConfig',
  'vercelAiSdk',
  'agentSdk',
])

function getWebAuthTokens() {
  const { auth, trade, authConfigured, tradeConfigured } = getAuthTokens()
  const devBypassRequested = process.env.DEV_AUTH_BYPASS === 'true'
  const devBypassAllowed = (
    process.env.ALLOW_UNSAFE_DEV_AUTH_BYPASS === 'true'
    && process.env.NODE_ENV === 'development'
  )
  return {
    auth,
    trade,
    authConfigured,
    tradeConfigured,
    devBypass: devBypassRequested && devBypassAllowed,
    devBypassRequested,
    devBypassAllowed,
  }
}

export function isAuthEnabled(): boolean {
  return isCoreAuthEnabled()
}

function withDevBypass(inner: MiddlewareHandler): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const { devBypass } = getWebAuthTokens()
    if (devBypass) return next()
    return inner(c, next)
  })
}

export function createRequireAuth(enforceAuth = false): MiddlewareHandler {
  return withDevBypass(createCoreRequireAuth(enforceAuth))
}

export function createRequireTrade(enforceAuth = true): MiddlewareHandler {
  return withDevBypass(createCoreRequireTrade(enforceAuth))
}

export function createRateLimitMiddleware(opts?: {
  maxRequests?: number
  windowMs?: number
}) : MiddlewareHandler {
  const windowMs = opts?.windowMs ?? Number(process.env.WEB_RATE_LIMIT_WINDOW_MS ?? 60_000)
  const maxRequests = opts?.maxRequests ?? Number(process.env.WEB_RATE_LIMIT_MAX ?? 100)
  const trustedProxies = (process.env.WEB_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const requests = new Map<string, { count: number; resetAt: number }>()

  return createMiddleware(async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()

    const remoteAddr = ((c.req.raw as unknown as { socket?: { remoteAddress?: string } })?.socket?.remoteAddress) ?? ''
    const ip = remoteAddr
      ? resolveGatewayClientIp({
          remoteAddr,
          forwardedFor: c.req.header('x-forwarded-for'),
          realIp: c.req.header('x-real-ip'),
          trustedProxies,
        }) ?? remoteAddr
      : 'unknown'

    const now = Date.now()
    const entry = requests.get(ip)
    if (!entry || now >= entry.resetAt) {
      requests.set(ip, { count: 1, resetAt: now + windowMs })
      return next()
    }

    entry.count += 1
    if (entry.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      const response = c.json({ error: 'Rate limit exceeded' }, 429)
      response.headers.set('Retry-After', String(retryAfter))
      return response
    }

    return next()
  })
}

function maskLeaf(value: string): string {
  if (value.length <= 4) return '****'
  return `****${value.slice(-4)}`
}

function sanitizeDeep(value: unknown, key?: string, parentKey?: string, forceMask = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDeep(item, undefined, key, forceMask))
  }
  if (!value || typeof value !== 'object') {
    if (
      typeof value === 'string'
      && (forceMask || (key && SENSITIVE_KEY_RE.test(key)) || (parentKey && SENSITIVE_KEY_RE.test(parentKey)))
    ) {
      return maskLeaf(value)
    }
    return value
  }

  const result: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const nextForceMask = forceMask || SECRET_CONTAINER_KEYS.has(childKey)
    result[childKey] = sanitizeDeep(childValue, childKey, key, nextForceMask)
  }
  return result
}

function unmaskDeep(value: unknown, existing: unknown, forceMask = false): void {
  if (Array.isArray(value) && Array.isArray(existing)) {
    for (let i = 0; i < value.length; i += 1) {
      unmaskDeep(value[i], existing[i], forceMask)
    }
    return
  }

  if (!value || typeof value !== 'object' || !existing || typeof existing !== 'object') return

  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    const current = (existing as Record<string, unknown>)[key]
    const nextForceMask = forceMask || SECRET_CONTAINER_KEYS.has(key)
    if (typeof childValue === 'string' && childValue.startsWith('****') && typeof current === 'string') {
      (value as Record<string, unknown>)[key] = current
      continue
    }

    if (childValue && typeof childValue === 'object' && current && typeof current === 'object') {
      unmaskDeep(childValue, current, nextForceMask)
    }
  }
}

export function sanitizeSecrets<T>(value: T): T {
  return sanitizeDeep(value) as T
}

export function sanitizeSecretsSection<T>(value: T): T {
  return sanitizeDeep(value) as T
}

export function unmaskSecrets<T extends Record<string, unknown>>(value: T, existing: unknown): T {
  unmaskDeep(value, existing)
  return value
}

export function getWebAuthStatus() {
  return getWebAuthTokens()
}
