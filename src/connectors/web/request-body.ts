import type { Context } from 'hono'

export const MAX_JSON_BODY_BYTES = 1_048_576

export class RequestBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`)
    this.name = 'RequestBodyTooLargeError'
  }
}

export async function readJsonWithLimit<T>(
  c: Pick<Context, 'req'>,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<T> {
  const contentLengthHeader = c.req.header('content-length')
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader)
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes)
    }
  }

  const raw = await c.req.text()
  const byteLength = Buffer.byteLength(raw, 'utf-8')
  if (byteLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes)
  }

  return JSON.parse(raw) as T
}
