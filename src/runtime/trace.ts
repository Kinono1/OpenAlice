import { randomBytes } from 'node:crypto'

/**
 * Generate a unified trace ID for end-to-end observability.
 * Format: oa_YYYYMMDDTHHMMSSZ_8hex
 * All shadow outputs within a single cron tick share the same trace_id.
 */
export function generateTraceId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const time = now.toISOString().slice(11, 19).replace(/:/g, '')
  const hex = randomBytes(4).toString('hex')
  return `oa_${date}T${time}Z_${hex}`
}
