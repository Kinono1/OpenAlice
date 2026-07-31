import { Bot, InlineKeyboard, InputFile } from 'grammy'
import { autoRetry } from '@grammyjs/auto-retry'
import { readFile } from 'node:fs/promises'
import { ProxyAgent } from 'undici'
import type { Message } from 'grammy/types'
import type { Plugin, EngineContext, MediaAttachment } from '../../core/types.js'
import type { TelegramConfig, ParsedMessage } from './types.js'
import { resolveTelegramProxyUrl } from './types.js'
import { buildParsedMessage } from './helpers.js'
import { MediaGroupMerger } from './media-group.js'
import { askAgentSdk } from '../../ai-providers/agent-sdk/query.js'
import type { AgentSdkConfig } from '../../ai-providers/agent-sdk/query.js'
import { SessionStore } from '../../core/session.js'
import { forceCompact } from '../../core/compaction.js'
import { readAIBackend, writeAIBackend, type AIBackend } from '../../core/config.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import { TelegramConnector, TelegramHttpConnector, splitMessage, MAX_MESSAGE_LENGTH } from './telegram-connector.js'

const BACKEND_LABELS: Record<AIBackend, string> = {
  'claude-code': 'Claude Code',
  'vercel-ai-sdk': 'Vercel AI SDK',
  'agent-sdk': 'Agent SDK',
}

export class TelegramPlugin implements Plugin {
  name = 'telegram'
  private config: TelegramConfig
  private agentSdkConfig: AgentSdkConfig
  private bot: Bot | null = null
  private connectorCenter: ConnectorCenter | null = null
  private merger: MediaGroupMerger | null = null
  private unregisterConnector?: () => void
  private rateLimitCleanupTimer?: ReturnType<typeof setInterval>
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private proxyAgent: ProxyAgent | null = null
  private pollingStarted = false
  private stopped = false
  private engineCtx: EngineContext | null = null

  /** Per-user unified session stores (keyed by userId). */
  private sessions = new Map<number, SessionStore>()

  /** Throttle: last time we sent an auth-guidance reply per chatId. */
  private authReplyThrottle = new Map<number, number>()

  /** Rate limit: message count and window reset per chatId. */
  private chatRateLimits = new Map<number, { count: number; resetAt: number }>()
  private static readonly MSG_RATE_LIMIT = 10        // max messages
  private static readonly MSG_RATE_WINDOW_MS = 60_000 // per 60s window

  constructor(
    config: Omit<TelegramConfig, 'pollingTimeout' | 'pollingEnabled'> & {
      pollingTimeout?: number
      pollingEnabled?: boolean
    },
    agentSdkConfig: AgentSdkConfig = {},
  ) {
    this.config = { pollingTimeout: 30, pollingEnabled: true, ...config }
    this.agentSdkConfig = agentSdkConfig
  }

  async start(engineCtx: EngineContext) {
    this.stopped = false
    this.engineCtx = engineCtx
    this.connectorCenter = engineCtx.connectorCenter

    // Inject agent config into Claude Code config (used by /compact command)
    this.agentSdkConfig = {
      disallowedTools: engineCtx.config.agent.claudeCode.disallowedTools,
      maxTurns: engineCtx.config.agent.claudeCode.maxTurns,
      ...this.agentSdkConfig,
    }

    if (!this.config.token) {
      this.connectorCenter.setChannelStatus('telegram', 'degraded', 'missing_secret')
      console.warn('telegram: degraded (configured token environment variable is missing)')
      return
    }

    try {
      await this.initialize(engineCtx)
    } catch (err) {
      this.markDegraded(err)
      this.scheduleReconnect()
    }
  }

  private async initialize(engineCtx: EngineContext): Promise<void> {
    if (!this.config.token) throw new Error('telegram token missing')
    const proxyUrl = resolveTelegramProxyUrl()
    this.proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null
    if (!this.config.pollingEnabled) {
      if (this.config.allowedChatIds.length === 0) {
        throw new Error('telegram outbound-only mode requires one allowed chat id')
      }
      const connector = new TelegramHttpConnector(
        this.config.token,
        this.config.allowedChatIds[0],
        this.proxyAgent ?? undefined,
      )
      const botInfo = await connector.verifyReady()
      this.unregisterConnector = this.connectorCenter!.register(connector)
      this.connectorCenter!.setChannelStatus('telegram', 'ready', 'outbound_only_shared_bot')
      console.log(`telegram plugin: connected as @${botInfo.username ?? 'unknown'} (outbound-only shared bot)`)
      console.log('telegram: outbound-only mode enabled; inbound polling and command registration are disabled')
      return
    }

    const bot = new Bot(this.config.token, { client: { timeoutSeconds: 10 } })

    // Auto-retry on 429 rate limits
    bot.api.config.use(autoRetry())

    // Error handler
    bot.catch((err) => {
      console.error('telegram bot error:', err)
    })

    // Verify the token with a short request before registering outbound delivery.
    await bot.init()
    const aiConfig = await readAIBackend()
    console.log(`telegram plugin: connected as @${bot.botInfo.username} (backend: ${aiConfig.backend})`)

    this.bot = bot
    if (this.config.allowedChatIds.length > 0) {
      const deliveryChatId = this.config.allowedChatIds[0]
      this.unregisterConnector = this.connectorCenter!.register(new TelegramConnector(bot, deliveryChatId))
    }
    this.connectorCenter!.setChannelStatus('telegram', 'ready')

    // ── Middleware: auth guard (always active) ──
    bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id
      if (!chatId) return
      if (this.config.allowedChatIds.includes(chatId)) return next()

      // Unauthorized — log chat ID for operator, throttle reply (60s)
      const now = Date.now()
      const last = this.authReplyThrottle.get(chatId) ?? 0
      if (now - last > 60_000) {
        this.authReplyThrottle.set(chatId, now)
        console.log(`telegram: unauthorized chat ${chatId}, set TELEGRAM_CHAT_ID=${chatId} to allow`)
        await ctx.reply('This chat is not authorized. Add this chat ID to TELEGRAM_CHAT_ID in your environment config.').catch(() => {})
      }
    })

    // ── Middleware: inbound rate limit per chat (10 msg / 60s) ──
    bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id
      if (!chatId) return next()
      const now = Date.now()
      let rl = this.chatRateLimits.get(chatId)
      if (!rl || now > rl.resetAt) {
        rl = { count: 0, resetAt: now + TelegramPlugin.MSG_RATE_WINDOW_MS }
        this.chatRateLimits.set(chatId, rl)
      }
      rl.count++
      if (rl.count > TelegramPlugin.MSG_RATE_LIMIT) {
        console.warn(`telegram: rate-limited chat ${chatId} (${rl.count} msgs in window)`)
        return // drop — no reply to avoid amplifying spam
      }
      return next()
    })

    // Periodic cleanup of stale rate-limit entries (every 5 min)
    if (this.rateLimitCleanupTimer) clearInterval(this.rateLimitCleanupTimer)
    this.rateLimitCleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [chatId, rl] of this.chatRateLimits) {
        if (now > rl.resetAt) this.chatRateLimits.delete(chatId)
      }
      for (const [chatId, ts] of this.authReplyThrottle) {
        if (now - ts > 60_000) this.authReplyThrottle.delete(chatId)
      }
    }, 5 * 60_000)
    bot.command('status', async (ctx) => {
      const aiConfig = await readAIBackend()
      await this.sendReply(ctx.chat.id, `Engine is running. Provider: ${BACKEND_LABELS[aiConfig.backend]}`)
    })

    bot.command('settings', async (ctx) => {
      await this.sendSettingsMenu(ctx.chat.id)
    })

    bot.command('heartbeat', async (ctx) => {
      await this.sendHeartbeatMenu(ctx.chat.id, engineCtx)
    })

    bot.command('compact', async (ctx) => {
      const userId = ctx.from?.id
      if (!userId) return
      await this.handleCompactCommand(ctx.chat.id, userId)
    })

    // ── Callback queries (inline keyboard presses) ──
    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data
      try {
        if (data.startsWith('provider:')) {
          const backend = data.slice('provider:'.length) as AIBackend
          await writeAIBackend(backend)
          await ctx.answerCallbackQuery({ text: `Switched to ${BACKEND_LABELS[backend]}` })

          // Edit the original settings message in-place
          const ccLabel = backend === 'claude-code' ? '> Claude Code' : 'Claude Code'
          const aiLabel = backend === 'vercel-ai-sdk' ? '> Vercel AI SDK' : 'Vercel AI SDK'
          const sdkLabel = backend === 'agent-sdk' ? '> Agent SDK' : 'Agent SDK'
          const keyboard = new InlineKeyboard()
            .text(ccLabel, 'provider:claude-code')
            .text(aiLabel, 'provider:vercel-ai-sdk')
            .text(sdkLabel, 'provider:agent-sdk')
          await ctx.editMessageText(
            `Current provider: ${BACKEND_LABELS[backend]}\n\nChoose default AI provider:`,
            { reply_markup: keyboard },
          )
        } else if (data.startsWith('heartbeat:')) {
          const newEnabled = data === 'heartbeat:on'
          await engineCtx.heartbeat.setEnabled(newEnabled)
          await ctx.answerCallbackQuery({ text: `Heartbeat ${newEnabled ? 'ON' : 'OFF'}` })

          // Edit message in-place
          const onLabel = newEnabled ? '> ON' : 'ON'
          const offLabel = !newEnabled ? '> OFF' : 'OFF'
          const keyboard = new InlineKeyboard()
            .text(onLabel, 'heartbeat:on')
            .text(offLabel, 'heartbeat:off')
          await ctx.editMessageText(
            `Heartbeat: ${newEnabled ? 'ON' : 'OFF'}\n\nToggle heartbeat self-check:`,
            { reply_markup: keyboard },
          )
        } else {
          await ctx.answerCallbackQuery()
        }
      } catch (err) {
        console.error('telegram callback query error:', err)
      }
    })

    // ── Set up media group merger ──
    this.merger = new MediaGroupMerger({
      onMerged: (message) => this.handleMessage(engineCtx, message),
    })

    // ── Messages (text, media, edited, channel posts) ──
    const messageHandler = (msg: Message) => {
      const parsed = buildParsedMessage(msg)
      console.log(`telegram: [${parsed.chatId}] ${parsed.from.firstName}: ${parsed.text?.slice(0, 80) || '(media)'}`)
      this.merger!.push(parsed)
    }

    bot.on('message', (ctx) => messageHandler(ctx.message))
    bot.on('edited_message', (ctx) => messageHandler(ctx.editedMessage))
    bot.on('channel_post', (ctx) => messageHandler(ctx.channelPost))

    // ── Start polling ──
    this.pollingStarted = true
    bot.start({
      allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query'],
      onStart: () => console.log('telegram: polling started'),
    }).catch((err) => {
      this.pollingStarted = false
      console.error('telegram polling fatal error:', err)
      this.markDegraded(err)
      this.scheduleReconnect()
    })

    void bot.api.setMyCommands([
      { command: 'status', description: 'Show engine status' },
      { command: 'settings', description: 'Choose default AI provider' },
      { command: 'heartbeat', description: 'Toggle heartbeat self-check' },
      { command: 'compact', description: 'Force compact session context' },
    ]).catch((err) => {
      console.warn('telegram: setMyCommands failed (non-fatal):', err instanceof Error ? err.message : err)
    })
  }

  async stop() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.merger?.flush()
    if (this.pollingStarted) await this.bot?.stop()
    this.pollingStarted = false
    this.bot = null
    this.unregisterConnector?.()
    this.unregisterConnector = undefined
    if (this.rateLimitCleanupTimer) {
      clearInterval(this.rateLimitCleanupTimer)
      this.rateLimitCleanupTimer = undefined
    }
    this.chatRateLimits.clear()
    this.authReplyThrottle.clear()
    await this.closeProxyAgent()
    this.connectorCenter?.setChannelStatus('telegram', 'stopped')
  }

  private markDegraded(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`telegram: degraded (${message})`)
    this.unregisterConnector?.()
    this.unregisterConnector = undefined
    if (this.pollingStarted) void this.bot?.stop().catch(() => undefined)
    this.pollingStarted = false
    this.bot = null
    void this.closeProxyAgent()
    this.connectorCenter?.setChannelStatus('telegram', 'degraded', message)
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.engineCtx || this.reconnectTimer || !this.config.token) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.stopped || !this.engineCtx) return
      void this.initialize(this.engineCtx).catch((err) => {
        this.markDegraded(err)
        this.scheduleReconnect()
      })
    }, 5 * 60_000)
    this.reconnectTimer.unref?.()
  }

  private async closeProxyAgent(): Promise<void> {
    const agent = this.proxyAgent
    this.proxyAgent = null
    if (agent) await agent.close().catch(() => undefined)
  }

  private async getSession(userId: number): Promise<SessionStore> {
    let session = this.sessions.get(userId)
    if (!session) {
      session = new SessionStore(`telegram/${userId}`)
      await session.restore()
      this.sessions.set(userId, session)
      console.log(`telegram: session telegram/${userId} ready`)
    }
    return session
  }

  /**
   * Sends "typing..." chat action and refreshes it every 4 seconds.
   * Returns a function to stop the indicator.
   */
  private startTypingIndicator(chatId: number): () => void {
    const send = () => {
      this.bot?.api.sendChatAction(chatId, 'typing').catch(() => {})
    }
    send()
    const interval = setInterval(send, 4000)
    return () => clearInterval(interval)
  }

  private async handleMessage(engineCtx: EngineContext, message: ParsedMessage) {
    try {
      // Build prompt from message content
      const prompt = this.buildPrompt(message)
      if (!prompt) return

      // Log: message received
      const receivedEntry = await engineCtx.eventLog.append('message.received', {
        channel: 'telegram',
        to: String(message.chatId),
        prompt,
      })

      // Send placeholder + typing indicator while generating
      const placeholder = await this.bot!.api.sendMessage(message.chatId, '...').catch(() => null)
      const stopTyping = this.startTypingIndicator(message.chatId)

      try {
        // Route through AgentCenter → GenerateRouter → active provider
        const session = await this.getSession(message.from.id)
        const result = await engineCtx.agentCenter.askWithSession(prompt, session, {
          historyPreamble: 'The following is the recent conversation from this Telegram chat. Use it as context if the user references earlier messages.',
        })
        stopTyping()
        await this.sendReplyWithPlaceholder(message.chatId, result.text, result.media, placeholder?.message_id)

        // Log: message sent
        await engineCtx.eventLog.append('message.sent', {
          channel: 'telegram',
          to: String(message.chatId),
          prompt,
          reply: result.text,
          durationMs: Date.now() - receivedEntry.ts,
        })
      } catch (err) {
        stopTyping()
        // Edit placeholder to show error instead of leaving "..."
        if (placeholder) {
          await this.bot!.api.editMessageText(
            message.chatId, placeholder.message_id,
            'Sorry, something went wrong processing your message.',
          ).catch(() => {})
        }
        throw err
      }
    } catch (err) {
      console.error('telegram message handling error:', err)
    }
  }

  private async handleCompactCommand(chatId: number, userId: number) {
    const session = await this.getSession(userId)
    await this.sendReply(chatId, '> Compacting session...')

    const result = await forceCompact(
      session,
      async (summarizePrompt) => {
        const r = await askAgentSdk(summarizePrompt, { ...this.agentSdkConfig, maxTurns: 1 })
        return r.text
      },
    )

    if (!result) {
      await this.sendReply(chatId, 'Session is empty, nothing to compact.')
    } else {
      await this.sendReply(chatId, `Compacted. Pre-compaction: ~${result.preTokens} tokens.`)
    }
  }

  private async sendSettingsMenu(chatId: number) {
    const aiConfig = await readAIBackend()
    const ccLabel = aiConfig.backend === 'claude-code' ? '> Claude Code' : 'Claude Code'
    const aiLabel = aiConfig.backend === 'vercel-ai-sdk' ? '> Vercel AI SDK' : 'Vercel AI SDK'
    const sdkLabel = aiConfig.backend === 'agent-sdk' ? '> Agent SDK' : 'Agent SDK'

    const keyboard = new InlineKeyboard()
      .text(ccLabel, 'provider:claude-code')
      .text(aiLabel, 'provider:vercel-ai-sdk')
      .text(sdkLabel, 'provider:agent-sdk')

    await this.bot!.api.sendMessage(
      chatId,
      `Current provider: ${BACKEND_LABELS[aiConfig.backend]}\n\nChoose default AI provider:`,
      { reply_markup: keyboard },
    )
  }

  private async sendHeartbeatMenu(chatId: number, engineCtx: EngineContext) {
    const enabled = engineCtx.heartbeat.isEnabled()
    const onLabel = enabled ? '> ON' : 'ON'
    const offLabel = !enabled ? '> OFF' : 'OFF'

    const keyboard = new InlineKeyboard()
      .text(onLabel, 'heartbeat:on')
      .text(offLabel, 'heartbeat:off')

    await this.bot!.api.sendMessage(
      chatId,
      `Heartbeat: ${enabled ? 'ON' : 'OFF'}\n\nToggle heartbeat self-check:`,
      { reply_markup: keyboard },
    )
  }

  private buildPrompt(message: ParsedMessage): string | null {
    const parts: string[] = []

    if (message.from.firstName) {
      parts.push(`[From: ${message.from.firstName}${message.from.username ? ` (@${message.from.username})` : ''}]`)
    }

    if (message.text) {
      parts.push(message.text)
    }

    if (message.media.length > 0) {
      const mediaDesc = message.media
        .map((m) => {
          const details: string[] = [m.type]
          if (m.fileName) details.push(m.fileName)
          if (m.mimeType) details.push(m.mimeType)
          return `[${details.join(': ')}]`
        })
        .join(' ')
      parts.push(mediaDesc)
    }

    const prompt = parts.join('\n')
    return prompt || null
  }

  /**
   * Send a reply, optionally editing a placeholder "..." message into the first text chunk.
   */
  private async sendReplyWithPlaceholder(chatId: number, text: string, media?: MediaAttachment[], placeholderMsgId?: number) {
    console.log(`telegram: sendReply chatId=${chatId} textLen=${text.length} media=${media?.length ?? 0}`)

    // Send images first (if any)
    if (media && media.length > 0) {
      for (let i = 0; i < media.length; i++) {
        const attachment = media[i]
        console.log(`telegram: sending photo ${i + 1}/${media.length} path=${attachment.path}`)
        try {
          const buf = await readFile(attachment.path)
          console.log(`telegram: photo file size=${buf.byteLength} bytes`)
          await this.bot!.api.sendPhoto(chatId, new InputFile(buf, 'screenshot.jpg'))
          console.log(`telegram: photo ${i + 1} sent ok`)
        } catch (err) {
          console.error(`telegram: failed to send photo ${i + 1}:`, err)
        }
      }
    }

    // Send text — edit placeholder for first chunk, send the rest as new messages
    if (text) {
      const chunks = splitMessage(text, MAX_MESSAGE_LENGTH)
      let startIdx = 0

      if (placeholderMsgId && chunks.length > 0) {
        const edited = await this.bot!.api.editMessageText(chatId, placeholderMsgId, chunks[0]).then(() => true).catch(() => false)
        if (edited) startIdx = 1
      }

      for (let i = startIdx; i < chunks.length; i++) {
        await this.bot!.api.sendMessage(chatId, chunks[i])
      }

      // Placeholder was edited — done
      if (startIdx > 0) return
    }

    // No text or edit failed — clean up the placeholder
    if (placeholderMsgId) {
      await this.bot!.api.deleteMessage(chatId, placeholderMsgId).catch(() => {})
    }
  }

  private async sendReply(chatId: number, text: string) {
    if (text) {
      const chunks = splitMessage(text, MAX_MESSAGE_LENGTH)
      for (const chunk of chunks) {
        await this.bot!.api.sendMessage(chatId, chunk)
      }
    }
  }
}
