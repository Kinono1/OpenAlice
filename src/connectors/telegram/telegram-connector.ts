/**
 * Telegram outbound connector.
 *
 * Delivers messages and media to a specific Telegram chat via the grammY
 * Bot API. Handles photo attachments (read from disk, sent via sendPhoto)
 * and automatic text chunking for messages exceeding Telegram's 4096-char limit.
 *
 * Does not support streaming (no sendStream) — ConnectorCenter falls back
 * to draining the stream and calling send() with the completed result.
 */

import { readFile } from 'node:fs/promises'
import { Bot, InputFile } from 'grammy'
import { request, type Dispatcher } from 'undici'
import type { Connector, ConnectorCapabilities, SendPayload, SendResult } from '../types.js'

export const MAX_MESSAGE_LENGTH = 4096

export class TelegramConnector implements Connector {
  readonly channel = 'telegram'
  readonly to: string
  readonly capabilities: ConnectorCapabilities = { push: true, media: true }

  constructor(
    private readonly bot: Bot,
    private readonly chatId: number,
  ) {
    this.to = String(chatId)
  }

  async send(payload: SendPayload): Promise<SendResult> {
    let anyDelivered = false
    let lastError: string | undefined

    // Send media first (photos)
    if (payload.media && payload.media.length > 0) {
      for (const attachment of payload.media) {
        try {
          const buf = await readFile(attachment.path)
          await this.bot.api.sendPhoto(this.chatId, new InputFile(buf, 'screenshot.jpg'))
          anyDelivered = true
        } catch (err) {
          lastError = `photo: ${err instanceof Error ? err.message : err}`
          console.error('telegram: failed to send photo:', lastError)
        }
      }
    }

    // Send text with chunking
    if (payload.text) {
      const chunks = splitMessage(payload.text, MAX_MESSAGE_LENGTH)
      for (const chunk of chunks) {
        try {
          await this.bot.api.sendMessage(this.chatId, chunk)
          anyDelivered = true
        } catch (err) {
          lastError = `text: ${err instanceof Error ? err.message : err}`
          console.error('telegram: failed to send message chunk:', lastError)
        }
      }
    }

    return {
      delivered: anyDelivered,
      reason: anyDelivered ? 'delivered' : 'remote_rejected',
      ...(lastError ? { error: lastError } : {}),
    }
  }
}

interface TelegramHttpResponse {
  statusCode: number
  body: { json(): Promise<unknown> }
}

interface TelegramHttpRequestOptions {
  method: 'POST'
  headers: Record<string, string>
  body: string
  dispatcher?: Dispatcher
  headersTimeout: number
  bodyTimeout: number
}

export type TelegramHttpRequest = (
  url: string,
  options: TelegramHttpRequestOptions,
) => Promise<TelegramHttpResponse>

/**
 * Text-only outbound connector for sharing a bot token with another polling owner.
 * It never calls getUpdates, setMyCommands, or any inbound Telegram endpoint.
 */
export class TelegramHttpConnector implements Connector {
  readonly channel = 'telegram'
  readonly to: string
  readonly capabilities: ConnectorCapabilities = { push: true, media: false }

  constructor(
    private readonly token: string,
    private readonly chatId: number,
    private readonly dispatcher?: Dispatcher,
    private readonly requestImpl: TelegramHttpRequest = request as unknown as TelegramHttpRequest,
  ) {
    this.to = String(chatId)
  }

  async verifyReady(): Promise<{ id: number | null; username: string | null }> {
    const result = await this.call('getMe', {})
    return {
      id: typeof result.id === 'number' ? result.id : null,
      username: typeof result.username === 'string' ? result.username : null,
    }
  }

  async send(payload: SendPayload): Promise<SendResult> {
    if (!payload.text) {
      return {
        delivered: false,
        reason: 'remote_rejected',
        error: payload.media?.length ? 'outbound-only shared bot does not send media' : 'empty Telegram payload',
      }
    }
    try {
      for (const chunk of splitMessage(payload.text, MAX_MESSAGE_LENGTH)) {
        await this.call('sendMessage', { chat_id: this.chatId, text: chunk })
      }
      return { delivered: true, reason: 'delivered' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        delivered: false,
        reason: /timeout|timed out|headers timeout|body timeout/i.test(message) ? 'send_timeout' : 'remote_rejected',
        error: message,
      }
    }
  }

  private async call(method: 'getMe' | 'sendMessage', payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.requestImpl(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      },
    )
    const body = await response.body.json() as unknown
    if (
      response.statusCode !== 200 ||
      body == null ||
      typeof body !== 'object' ||
      (body as { ok?: unknown }).ok !== true
    ) {
      const description = body && typeof body === 'object' && typeof (body as { description?: unknown }).description === 'string'
        ? (body as { description: string }).description
        : `Telegram HTTP ${response.statusCode}`
      throw new Error(description)
    }
    const result = (body as { result?: unknown }).result
    return result && typeof result === 'object' ? result as Record<string, unknown> : {}
  }
}

// ==================== Helpers ====================

export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt === -1 || splitAt < maxLength / 2) {
      // Fall back to splitting at a space
      splitAt = remaining.lastIndexOf(' ', maxLength)
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      // Hard split
      splitAt = maxLength
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}
