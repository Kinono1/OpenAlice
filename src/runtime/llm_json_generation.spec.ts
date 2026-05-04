import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const aiMocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
}))

vi.mock('ai', () => ({
  generateObject: aiMocks.generateObject,
  generateText: aiMocks.generateText,
}))

import {
  clearStructuredGenerationCompatibilityUsageEvents,
  extractJsonFromText,
  generateStructuredObject,
  generateZodJsonObject,
  getStructuredGenerationCompatibilityUsageEvents,
  normalizeLlmUsage,
  StructuredGenerationError,
} from './llm_json_generation.js'

const schema = z.object({
  decision: z.enum(['go', 'hold']),
  confidence: z.number(),
})

const model = {} as never

describe('generateStructuredObject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearStructuredGenerationCompatibilityUsageEvents()
  })

  it('returns native object results with normalized usage and reasoning content', async () => {
    aiMocks.generateObject.mockResolvedValueOnce({
      object: { decision: 'go', confidence: 0.8 },
      reasoning: 'brief reasoning',
      usage: {
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: 8,
          cacheReadTokens: 2,
          cacheWriteTokens: undefined,
        },
        outputTokens: 5,
        outputTokenDetails: {
          textTokens: 4,
          reasoningTokens: 1,
        },
        totalTokens: 15,
      },
    })

    const result = await generateStructuredObject({
      model,
      schema,
      prompt: 'decide',
    })

    expect(result.object).toEqual({ decision: 'go', confidence: 0.8 })
    expect(result.fallbackReason).toBeUndefined()
    expect(result.reasoningContent).toBe('brief reasoning')
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: 1,
      promptCacheHitTokens: 2,
      promptCacheMissTokens: 8,
    })
  })

  it('falls back to text JSON when native object generation fails', async () => {
    aiMocks.generateObject.mockRejectedValueOnce(new Error('native failed'))
    aiMocks.generateText.mockResolvedValueOnce({
      text: 'Result:\n```json\n{"decision":"hold","confidence":0.45}\n```',
      usage: {
        raw: {
          prompt_tokens: 20,
          completion_tokens: 6,
          total_tokens: 26,
          prompt_cache_hit_tokens: 12,
          prompt_cache_miss_tokens: 8,
          reasoning_tokens: 3,
        },
      },
    })

    const result = await generateStructuredObject({
      model,
      schema,
      prompt: 'decide',
      jsonInstruction: 'Only JSON.',
    })

    expect(aiMocks.generateObject).toHaveBeenCalledOnce()
    expect(aiMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'decide\n\nOnly JSON.',
    }))
    expect(result.object).toEqual({ decision: 'hold', confidence: 0.45 })
    expect(result.fallbackReason).toBe('native_object_failed')
    expect(result.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 6,
      totalTokens: 26,
      promptCacheHitTokens: 12,
      promptCacheMissTokens: 8,
      reasoningTokens: 3,
    })
  })

  it('can force text JSON mode for providers that require it', async () => {
    aiMocks.generateText.mockResolvedValueOnce({
      text: '{"decision":"go","confidence":0.6}',
      usage: {},
    })

    const result = await generateStructuredObject({
      model,
      schema,
      prompt: 'decide',
      mode: 'text_json',
      providerName: 'deepseek',
    })

    expect(aiMocks.generateObject).not.toHaveBeenCalled()
    expect(result.object).toEqual({ decision: 'go', confidence: 0.6 })
    expect(result.fallbackReason).toBe('provider_requires_text_json')
  })

  it('throws a structured no_json_found error when text fallback has no JSON', async () => {
    aiMocks.generateText.mockResolvedValueOnce({
      text: 'no object here',
      usage: {},
    })

    await expect(
      generateStructuredObject({
        model,
        schema,
        prompt: 'decide',
        mode: 'text_json',
      }),
    ).rejects.toMatchObject({
      name: 'StructuredGenerationError',
      reason: 'no_json_found',
    })
  })

  it('throws a structured schema_validation_failed error when JSON violates schema', async () => {
    aiMocks.generateText.mockResolvedValueOnce({
      text: '{"decision":"go","confidence":"high"}',
      usage: {},
    })

    await expect(
      generateStructuredObject({
        model,
        schema,
        prompt: 'decide',
        mode: 'text_json',
      }),
    ).rejects.toMatchObject({
      name: 'StructuredGenerationError',
      reason: 'schema_validation_failed',
    })
  })
})

describe('generateZodJsonObject compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearStructuredGenerationCompatibilityUsageEvents()
  })

  it('returns only the object while preserving usage in a side channel', async () => {
    aiMocks.generateText.mockResolvedValueOnce({
      text: '{"decision":"hold","confidence":0.5}',
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
      },
    })

    const object = await generateZodJsonObject({
      model,
      schema,
      prompt: 'decide',
      mode: 'text_json',
      providerName: 'deepseek',
    })

    expect(object).toEqual({ decision: 'hold', confidence: 0.5 })
    expect(getStructuredGenerationCompatibilityUsageEvents()).toEqual([
      expect.objectContaining({
        providerName: 'deepseek',
        fallbackReason: 'provider_requires_text_json',
        usage: expect.objectContaining({
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
        }),
      }),
    ])
  })
})

describe('extractJsonFromText', () => {
  it('extracts direct, fenced, and embedded JSON objects', () => {
    expect(extractJsonFromText('{"a":1}')).toEqual({ a: 1 })
    expect(extractJsonFromText('```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(extractJsonFromText('prefix {"a":{"b":"} in string"}} suffix')).toEqual({
      a: { b: '} in string' },
    })
  })

  it('returns null when no JSON can be parsed', () => {
    expect(extractJsonFromText('plain text')).toBeNull()
  })
})

describe('normalizeLlmUsage', () => {
  it('normalizes AI SDK and provider raw usage fields', () => {
    expect(normalizeLlmUsage({
      inputTokens: 10,
      inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 3 },
      outputTokens: 5,
      outputTokenDetails: { reasoningTokens: 2 },
      totalTokens: 15,
    })).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: 2,
      promptCacheHitTokens: 3,
      promptCacheMissTokens: 7,
    })

    expect(normalizeLlmUsage({
      raw: {
        prompt_tokens: 11,
        completion_tokens: 6,
        total_tokens: 17,
        prompt_cache_hit_tokens: 4,
        prompt_cache_miss_tokens: 7,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })).toMatchObject({
      inputTokens: 11,
      outputTokens: 6,
      totalTokens: 17,
      reasoningTokens: 2,
      promptCacheHitTokens: 4,
      promptCacheMissTokens: 7,
    })
  })

  it('returns undefined for absent usage', () => {
    expect(normalizeLlmUsage(undefined)).toBeUndefined()
  })
})

describe('StructuredGenerationError', () => {
  it('exposes a stable reason field', () => {
    const error = new StructuredGenerationError('native_object_failed', 'failed')
    expect(error.reason).toBe('native_object_failed')
  })
})
