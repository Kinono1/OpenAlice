import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sdkQuery: vi.fn(),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.sdkQuery,
}))

vi.mock('pino', () => ({
  pino: vi.fn(() => mocks.logger),
}))

import { askAgentSdk } from './query.js'

function mockSuccessfulQuery(result = 'ok') {
  mocks.sdkQuery.mockImplementation(async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      result,
      model: 'mock-model',
      usage: { input_tokens: 1, output_tokens: 2 },
    }
  })
}

describe('askAgentSdk provider isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.ALICE_SDK_DEBUG
    mockSuccessfulQuery()
  })

  it('injects only the explicit API key and baseUrl override for Anthropic-compatible profiles', async () => {
    await askAgentSdk(
      'prompt',
      {},
      {
        model: 'deepseek-v4-pro',
        apiKey: 'deepseek-secret',
        baseUrl: 'https://api.deepseek.com/anthropic',
        loginMethod: 'api-key',
      },
    )

    const call = mocks.sdkQuery.mock.calls[0][0]
    expect(call.options.model).toBe('deepseek-v4-pro')
    expect(call.options.env.ANTHROPIC_API_KEY).toBe('deepseek-secret')
    expect(call.options.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(call.options.env.CLAUDE_CODE_SIMPLE).toBe('1')
    expect(call.options.forceLoginMethod).toBeUndefined()
  })

  it('does not inherit a process-level baseUrl when the profile has no baseUrl', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'

    await askAgentSdk(
      'prompt',
      {},
      {
        model: 'claude-sonnet-4-6',
        apiKey: 'anthropic-secret',
        loginMethod: 'api-key',
      },
    )

    const call = mocks.sdkQuery.mock.calls[0][0]
    expect(call.options.model).toBe('claude-sonnet-4-6')
    expect(call.options.env.ANTHROPIC_API_KEY).toBe('anthropic-secret')
    expect(call.options.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(call.options.env.CLAUDE_CODE_SIMPLE).toBe('1')
  })

  it('removes inherited API-key mode and baseUrl variables in OAuth mode', async () => {
    process.env.ANTHROPIC_API_KEY = 'inherited-api-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.CLAUDE_CODE_SIMPLE = '1'

    await askAgentSdk(
      'prompt',
      {},
      {
        model: 'claude-opus-4-7',
        loginMethod: 'claudeai',
      },
    )

    const call = mocks.sdkQuery.mock.calls[0][0]
    expect(call.options.model).toBe('claude-opus-4-7')
    expect(call.options.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(call.options.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(call.options.env.CLAUDE_CODE_SIMPLE).toBeUndefined()
    expect(call.options.forceLoginMethod).toBe('claudeai')
  })

  it('keeps sequential provider calls isolated', async () => {
    await askAgentSdk(
      'deepseek prompt',
      {},
      {
        model: 'deepseek-v4-flash',
        apiKey: 'deepseek-secret',
        baseUrl: 'https://api.deepseek.com/anthropic',
        loginMethod: 'api-key',
      },
    )

    await askAgentSdk(
      'anthropic prompt',
      {},
      {
        model: 'claude-haiku-4-5',
        apiKey: 'anthropic-secret',
        loginMethod: 'api-key',
      },
    )

    const first = mocks.sdkQuery.mock.calls[0][0]
    const second = mocks.sdkQuery.mock.calls[1][0]
    expect(first.options.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(first.options.env.ANTHROPIC_API_KEY).toBe('deepseek-secret')
    expect(second.options.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(second.options.env.ANTHROPIC_API_KEY).toBe('anthropic-secret')
  })
})
