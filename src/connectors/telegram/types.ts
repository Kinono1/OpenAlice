import type { Update, Message, Chat, User } from 'grammy/types'

export type { Update, Message, Chat, User }

export interface TelegramConfig {
  token?: string
  /** Chat IDs allowed to interact. Empty = allow all. */
  allowedChatIds: number[]
  /** Polling timeout in seconds (Telegram long-poll parameter). Default: 30 */
  pollingTimeout: number
  /** Disable inbound long polling when the bot token is shared with another owner. */
  pollingEnabled: boolean
}

export function resolveTelegramPollingEnabled(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === '') return true
  const normalized = raw.trim().toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  return true
}

export function resolveTelegramProxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.OPENALICE_TELEGRAM_PROXY_URL,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ]
  for (const candidate of candidates) {
    const value = candidate?.trim()
    if (!value) continue
    if (['0', 'false', 'none', 'direct', 'off'].includes(value.toLowerCase())) return null
    return value
  }
  return null
}

export interface ParsedMessage {
  chatId: number
  messageId: number
  from: { id: number; firstName: string; username?: string }
  date: Date
  text: string
  command?: string
  commandArgs?: string
  media: MediaRef[]
  /** media_group_id if present */
  mediaGroupId?: string
  raw: Message
}

export interface MediaRef {
  type: 'photo' | 'document' | 'animation' | 'voice' | 'sticker' | 'video' | 'video_note' | 'audio'
  fileId: string
  fileName?: string
  mimeType?: string
  width?: number
  height?: number
}
