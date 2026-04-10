import type { Context } from 'hono'

type CorsOriginResolver = (
  origin: string,
  c: Context,
) => string | null | undefined | Promise<string | null | undefined>

/**
 * Build a Hono-compatible CORS origin resolver from config allowlists.
 * Empty allowlists intentionally emit no CORS allow-origin header.
 */
export function createCorsOriginResolver(allowOrigins?: string[]): string | CorsOriginResolver {
  const normalized = (allowOrigins ?? [])
    .map(origin => origin.trim())
    .filter(Boolean)

  if (normalized.includes('*')) {
    return '*'
  }

  if (normalized.length === 0) {
    return () => null
  }

  const allowed = new Set(normalized)
  return (origin: string) => {
    if (!origin) return null
    return allowed.has(origin) ? origin : null
  }
}
