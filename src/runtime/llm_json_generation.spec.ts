import { describe, expect, it } from 'vitest'
import type { LanguageModelUsage } from 'ai'
import { summarizeLlmUsage } from './llm_json_generation.js'

describe('summarizeLlmUsage', () => {
  it('normalizes DeepSeek prompt cache usage fields', () => {
    const usage: LanguageModelUsage = {
      inputTokens: 120,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: 30,
      outputTokenDetails: {
        textTokens: 24,
        reasoningTokens: 6,
      },
      totalTokens: 150,
      raw: {
        prompt_cache_hit_tokens: 100,
        prompt_cache_miss_tokens: 20,
      },
    }

    expect(summarizeLlmUsage(usage)).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cacheReadTokens: 100,
      noCacheTokens: 20,
      promptCacheHitTokens: 100,
      promptCacheMissTokens: 20,
      textTokens: 24,
      reasoningTokens: 6,
    })
  })
})
