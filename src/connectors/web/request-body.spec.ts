import { describe, expect, it } from 'vitest'
import {
  MAX_JSON_BODY_BYTES,
  RequestBodyTooLargeError,
  readJsonWithLimit,
} from './request-body.js'

describe('readJsonWithLimit', () => {
  it('parses JSON bodies within the size cap', async () => {
    const payload = JSON.stringify({ message: 'hello' })
    const result = await readJsonWithLimit<{ message: string }>(
      {
        req: {
          header: () => String(Buffer.byteLength(payload, 'utf-8')),
          text: async () => payload,
        },
      } as any,
    )

    expect(result).toEqual({ message: 'hello' })
  })

  it('throws when the declared content-length exceeds the cap', async () => {
    await expect(
      readJsonWithLimit(
        {
          req: {
            header: () => String(MAX_JSON_BODY_BYTES + 1),
            text: async () => '{}',
          },
        } as any,
      ),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })
})
