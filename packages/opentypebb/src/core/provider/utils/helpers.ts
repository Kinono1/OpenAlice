/**
 * HTTP helpers and utility functions.
 * Maps to: openbb_core/provider/utils/helpers.py
 */

import { OpenBBError } from './errors.js'

/**
 * Make an async HTTP request and return the parsed JSON response.
 * Maps to: amake_request() in helpers.py
 *
 * @param url - The URL to request.
 * @param options - Optional fetch options.
 * @param responseCallback - Optional callback to process the response before parsing.
 * @param timeoutMs - Request timeout in milliseconds (default: 30000).
 * @returns Parsed JSON response.
 */
export async function amakeRequest<T = unknown>(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
    responseCallback?: (response: Response) => Promise<Response>
  } = {},
): Promise<T> {
  const { method = 'GET', headers, body, timeoutMs = 30_000, responseCallback } = options

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new OpenBBError(`Request timed out after ${timeoutMs}ms: ${url}`)
    }
    throw new OpenBBError(`Request failed: ${url}`, error)
  }

  if (responseCallback) {
    response = await responseCallback(response)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new OpenBBError(
      `HTTP ${response.status} ${response.statusText}: ${url}${text ? ` - ${text}` : ''}`,
    )
  }

  try {
    return (await response.json()) as T
  } catch (error) {
    throw new OpenBBError(`Failed to parse JSON response from: ${url}`, error)
  }
}

/**
 * Apply alias dictionary to a data record.
 * Maps to: Data.__alias_dict__ + _use_alias model_validator in data.py
 *
 * The alias dict maps {targetFieldName: sourceFieldName}.
 * This renames source keys to target keys in the data.
 *
 * @param data - The raw data object.
 * @param aliasDict - Mapping of {targetName: sourceName}.
 * @returns Data with renamed keys.
 */
export function applyAliases(
  data: Record<string, unknown>,
  aliasDict: Record<string, string>,
): Record<string, unknown> {
  if (!aliasDict || Object.keys(aliasDict).length === 0) return data

  const result: Record<string, unknown> = { ...data }

  // aliasDict maps {newName: originalName}
  for (const [newName, originalName] of Object.entries(aliasDict)) {
    if (originalName in result) {
      result[newName] = result[originalName]
      if (newName !== originalName) {
        delete result[originalName]
      }
    }
  }

  return result
}

/**
 * Replace empty strings and "NA" with null in a data record.
 * Common pattern in FMP/YFinance providers.
 */
export function replaceEmptyStrings(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    result[key] = value === '' || value === 'NA' ? null : value
  }
  return result
}

/**
 * Make an HTTP GET request using Node's native https module.
 * Bypasses the undici global dispatcher (and its proxy agent).
 * Useful for APIs that are incompatible with HTTP proxy tunneling
 * (e.g. OECD SDMX, ECB, IMF) but are accessible via OS network stack (TUN).
 */
export async function nativeFetch(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; text: string }> {
  const { headers, timeoutMs = 30_000 } = options
  const mod = url.startsWith('https') ? await import('https') : await import('http')

  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers, timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: body }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new OpenBBError(`Request timed out: ${url}`)) })
  })
}

/**
 * Build a query string from params, omitting null/undefined values.
 */
export function buildQueryString(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      searchParams.set(key, String(value))
    }
  }
  return searchParams.toString()
}
