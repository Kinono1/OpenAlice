import { describe, expect, it } from 'vitest'
import { resolveQuantLlmModel } from './llm_model_routing'

describe('resolveQuantLlmModel', () => {
  it('routes ttl openai-compatible models through the DeepSeek-compatible defaults', () => {
    const spec = resolveQuantLlmModel('ttl', {
      OPENALICE_LLM_TTL_PROVIDER: 'openai-compatible',
      OPENALICE_LLM_TTL_MODEL: 'deepseek-v4-flash',
      OPENALICE_DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      OPENALICE_LLM_API_KEY_ENV: 'DEEPSEEK_API_KEY',
    })

    expect(spec.provider).toBe('openai-compatible')
    expect(spec.model).toBe('deepseek-v4-flash')
    expect(spec.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(spec.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
  })
})
