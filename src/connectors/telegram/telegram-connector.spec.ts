import { describe, expect, it, vi } from 'vitest'
import { TelegramHttpConnector, type TelegramHttpRequest } from './telegram-connector.js'

function response(result: unknown, statusCode = 200) {
  return { statusCode, body: { json: async () => ({ ok: statusCode === 200, result }) } }
}

describe('TelegramHttpConnector', () => {
  it('verifies the bot and sends text without polling', async () => {
    const methods: string[] = []
    const requestImpl: TelegramHttpRequest = vi.fn(async (url, options) => {
      methods.push(url.split('/').at(-1) ?? '')
      expect(options.headersTimeout).toBe(10_000)
      expect(options.bodyTimeout).toBe(10_000)
      return url.endsWith('/getMe')
        ? response({ id: 8023415008, username: 'DDTmet_bot' })
        : response({ message_id: 1 })
    })
    const connector = new TelegramHttpConnector('123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHIJ', 123, undefined, requestImpl)

    await expect(connector.verifyReady()).resolves.toEqual({ id: 8023415008, username: 'DDTmet_bot' })
    await expect(connector.send({ kind: 'notification', text: 'probe' })).resolves.toEqual({ delivered: true, reason: 'delivered' })
    expect(methods).toEqual(['getMe', 'sendMessage'])
  })

  it('classifies timeout and remote rejection separately', async () => {
    const timeoutRequest: TelegramHttpRequest = vi.fn(async () => { throw new Error('headers timeout') })
    const rejectedRequest: TelegramHttpRequest = vi.fn(async () => ({
      statusCode: 401,
      body: { json: async () => ({ ok: false, description: 'Unauthorized' }) },
    }))

    const timeout = new TelegramHttpConnector('123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHIJ', 123, undefined, timeoutRequest)
    const rejected = new TelegramHttpConnector('123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHIJ', 123, undefined, rejectedRequest)
    await expect(timeout.send({ kind: 'notification', text: 'probe' })).resolves.toMatchObject({ delivered: false, reason: 'send_timeout' })
    await expect(rejected.send({ kind: 'notification', text: 'probe' })).resolves.toMatchObject({ delivered: false, reason: 'remote_rejected' })
  })
})
