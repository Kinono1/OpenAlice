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
  createOpenAI: vi.fn((options?: Record<string, unknown>) => (model: string) => ({
    provider: 'openai',
    model,
    options,
  })),
}))

import { readFile } from 'node:fs/promises'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import {
  createConfiguredModel,
  createModelFromProfile,
  modelConfigCacheKey,
} from './model-factory.js'

const mockReadFile = vi.mocked(readFile)
const mockCreateAnthropic = vi.mocked(createAnthropic)
const mockCreateGoogleGenerativeAI = vi.mocked(createGoogleGenerativeAI)
const mockCreateOpenAI = vi.mocked(createOpenAI)

describe('createModelFromProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps provider-specific base URLs and API keys isolated', async () => {
    await createModelFromProfile({
      backend: 'vercel-ai-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'anthropic-secret',
      baseUrl: 'https://anthropic.example.invalid',
    })
    await createModelFromProfile({
      backend: 'vercel-ai-sdk',
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'google-secret',
      baseUrl: 'https://google.example.invalid',
    })
    await createModelFromProfile({
      backend: 'vercel-ai-sdk',
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'openai-secret',
      baseUrl: 'https://openai.example.invalid/v1',
    })

    expect(mockCreateAnthropic).toHaveBeenCalledWith({
      apiKey: 'anthropic-secret',
      baseURL: 'https://anthropic.example.invalid',
    })
    expect(mockCreateGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'google-secret',
      baseURL: 'https://google.example.invalid',
    })
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'openai-secret',
      baseURL: 'https://openai.example.invalid/v1',
    })
  })

  it('uses a cache key that changes with provider, model, baseUrl, and apiKey', () => {
    const base = {
      provider: 'openai',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.example/v1',
      apiKey: 'deepseek-secret-a',
    }

    const keys = new Set([
      modelConfigCacheKey(base),
      modelConfigCacheKey({ ...base, provider: 'anthropic' }),
      modelConfigCacheKey({ ...base, model: 'deepseek-v4-flash' }),
      modelConfigCacheKey({ ...base, baseUrl: 'https://api.deepseek.example/v2' }),
      modelConfigCacheKey({ ...base, apiKey: 'deepseek-secret-b' }),
      modelConfigCacheKey({ ...base, apiKey: undefined }),
    ])

    expect(keys.size).toBe(6)
    expect(modelConfigCacheKey(base)).not.toContain('deepseek-secret-a')
  })
})

describe('createConfiguredModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.TEST_OPENAI_API_KEY
    delete process.env.MISSING_OPENAI_API_KEY
  })

  it('uses apiKeyEnv when creating an openai-compatible model', async () => {
    process.env.TEST_OPENAI_API_KEY = 'env-secret'

    const model = await createConfiguredModel({
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
    expect(model).toMatchObject({
      provider: 'openai',
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

    const model = await createConfiguredModel({
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
    expect(model).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      options: {
        baseURL: 'https://codex.example.invalid/v1',
        apiKey: 'bearer-token-123',
        name: 'local',
      },
    })
  })
})
