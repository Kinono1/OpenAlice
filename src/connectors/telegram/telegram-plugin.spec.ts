import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorCenter } from '../../core/connector-center.js'

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  setMyCommands: vi.fn(),
  verifyReady: vi.fn().mockResolvedValue({ id: 123, username: 'shared_test_bot' }),
}))

vi.mock('grammy', () => ({
  Bot: class FakeBot {
    botInfo = { username: 'shared_test_bot' }
    api = {
      config: { use: vi.fn() },
      setMyCommands: mocks.setMyCommands,
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(),
    }
    catch = vi.fn()
    use = vi.fn()
    command = vi.fn()
    on = vi.fn()
    init = mocks.init
    start = mocks.start
    stop = mocks.stop
  },
  InlineKeyboard: class FakeInlineKeyboard {},
  InputFile: class FakeInputFile {},
}))

vi.mock('@grammyjs/auto-retry', () => ({ autoRetry: () => vi.fn() }))
vi.mock('./telegram-connector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./telegram-connector.js')>()
  return {
    ...actual,
    TelegramHttpConnector: class FakeTelegramHttpConnector {
      channel = 'telegram'
      to = '123'
      capabilities = { push: true, media: false }
      verifyReady = mocks.verifyReady
      send = vi.fn().mockResolvedValue({ delivered: true, reason: 'delivered' })
    },
  }
})
vi.mock('../../core/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../core/config.js')>(),
  readAIBackend: vi.fn().mockResolvedValue({ backend: 'vercel-ai-sdk' }),
}))

import { TelegramPlugin } from './telegram-plugin.js'

describe('TelegramPlugin outbound-only mode', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registers outbound delivery without starting polling or setMyCommands', async () => {
    const connectorCenter = new ConnectorCenter()
    const plugin = new TelegramPlugin({
      token: '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHIJ',
      allowedChatIds: [123],
      pollingEnabled: false,
    })
    const context = {
      connectorCenter,
      config: { agent: { claudeCode: { disallowedTools: [], maxTurns: 20 } } },
    } as any

    await plugin.start(context)

    expect(mocks.verifyReady).toHaveBeenCalledOnce()
    expect(mocks.init).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.setMyCommands).not.toHaveBeenCalled()
    expect(connectorCenter.get('telegram')).not.toBeNull()
    expect(connectorCenter.getChannelStatuses().telegram).toEqual({
      status: 'ready',
      detail: 'outbound_only_shared_bot',
    })

    await plugin.stop()
    expect(mocks.stop).not.toHaveBeenCalled()
  })
})
