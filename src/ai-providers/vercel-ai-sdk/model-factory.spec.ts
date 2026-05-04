import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn((options?: Record<string, unknown>) => (model: string) => ({
    provider: 'anthropic',
    model,
    options,
  })),
}))

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn((options?: Record<string, unknown>) => (model: string) => ({
    provider: 'google',
    model,
    options,
  })),
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((options?: Record<string, unknown>) => Object.assign(
    (model: string) => ({
      provider: 'openai',
      mode: 'responses',
      model,
      options,
    }),
    {
      chat: (model: string) => ({
        provider: 'openai',
        mode: 'chat',
        model,
        options,
      }),
    },
  )),
}))

import { readFile } from 'node:fs/promises'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createConfiguredModel } from './model-factory.js'

const mockReadFile = vi.mocked(readFile)
const mockCreateOpenAI = vi.mocked(createOpenAI)
const mockCreateAnthropic = vi.mocked(createAnthropic)
const mockCreateGoogleGenerativeAI = vi.mocked(createGoogleGenerativeAI)

describe('createConfiguredModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.TEST_OPENAI_API_KEY
    delete process.env.TEST_ANTHROPIC_API_KEY
    delete process.env.TEST_GOOGLE_API_KEY
    delete process.env.MISSING_OPENAI_API_KEY
  })

  it('uses apiKeyEnv when creating an Anthropic model', async () => {
    process.env.TEST_ANTHROPIC_API_KEY = 'anthropic-secret'

    const { model, providerName } = await createConfiguredModel({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseURL: 'https://anthropic.example.invalid',
      apiKeyEnv: 'TEST_ANTHROPIC_API_KEY',
    })

    expect(mockCreateAnthropic).toHaveBeenCalledWith({
      apiKey: 'anthropic-secret',
      baseURL: 'https://anthropic.example.invalid',
    })
    expect(providerName).toBe('anthropic')
    expect(model).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      options: {
        apiKey: 'anthropic-secret',
        baseURL: 'https://anthropic.example.invalid',
      },
    })
  })

  it('uses apiKeyEnv when creating a Google model', async () => {
    process.env.TEST_GOOGLE_API_KEY = 'google-secret'

    const { model, providerName } = await createConfiguredModel({
      provider: 'google',
      model: 'gemini-2.5-pro',
      baseURL: 'https://google.example.invalid',
      apiKeyEnv: 'TEST_GOOGLE_API_KEY',
    })

    expect(mockCreateGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'google-secret',
      baseURL: 'https://google.example.invalid',
    })
    expect(providerName).toBe('google')
    expect(model).toMatchObject({
      provider: 'google',
      model: 'gemini-2.5-pro',
      options: {
        apiKey: 'google-secret',
        baseURL: 'https://google.example.invalid',
      },
    })
  })

  it('uses apiKeyEnv when creating an openai-compatible model', async () => {
    process.env.TEST_OPENAI_API_KEY = 'env-secret'

    const { model, providerName } = await createConfiguredModel({
      provider: 'openai-compatible',
      model: 'gpt-4o',
      baseURL: 'https://api.example.invalid/v1',
      apiKeyEnv: 'TEST_OPENAI_API_KEY',
    })

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      baseURL: 'https://api.example.invalid/v1',
      apiKey: 'env-secret',
      name: 'openai-compatible',
    })
    expect(providerName).toBe('openai-compatible')
    expect(model).toMatchObject({
      provider: 'openai',
      mode: 'chat',
      model: 'gpt-4o',
      options: {
        baseURL: 'https://api.example.invalid/v1',
        apiKey: 'env-secret',
        name: 'openai-compatible',
      },
    })
  })

  it('throws when an openai-compatible model has no api key', async () => {
    await expect(
      createConfiguredModel({
        provider: 'openai-compatible',
        model: 'gpt-4o',
        apiKeyEnv: 'MISSING_OPENAI_API_KEY',
      }),
    ).rejects.toThrow(/requires an API key/)
  })

  it('reads Codex TOML config for gmn providers', async () => {
    mockReadFile.mockResolvedValueOnce(`
model_provider = "local"
model = "gpt-4o-mini"

[model_providers.local]
base_url = "https://codex.example.invalid/v1/"
experimental_bearer_token = "bearer-token-123"
`.trim())

    const { model, providerName } = await createConfiguredModel({
      provider: 'gmn',
      model: '',
      codexConfigPath: '/tmp/codex.toml',
    })

    expect(mockReadFile).toHaveBeenCalledWith('/tmp/codex.toml', 'utf-8')
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      baseURL: 'https://codex.example.invalid/v1',
      apiKey: 'bearer-token-123',
      name: 'local',
    })
    expect(providerName).toBe('local')
    expect(model).toMatchObject({
      provider: 'openai',
      mode: 'responses',
      model: 'gpt-4o-mini',
      options: {
        baseURL: 'https://codex.example.invalid/v1',
        apiKey: 'bearer-token-123',
        name: 'local',
      },
    })
  })
})
