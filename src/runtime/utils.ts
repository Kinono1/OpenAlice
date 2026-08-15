/**
 * Shared runtime utilities extracted from repeated patterns across the runtime layer.
 */

/**
 * Check whether an ISO 8601 timestamp string has expired relative to `now`.
 * Returns `true` when the timestamp is invalid or in the past.
 */
export function isExpired(isoString: string, now: Date = new Date()): boolean {
  const t = Date.parse(isoString)
  return isNaN(t) || t <= now.getTime()
}
