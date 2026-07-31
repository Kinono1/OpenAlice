import type { ModelOverride } from '../ai-providers/vercel-ai-sdk/model-factory.js'

export type QuantLlmLane = 'regular' | 'analysis' | 'ttl' | 'event'

export interface QuantLlmModelSpec extends ModelOverride {
  lane: QuantLlmLane
  contextWindowTokens: number
}

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
const DEFAULT_REGULAR_MODEL = 'deepseek-v4-pro'
const DEFAULT_ANALYSIS_MODEL = 'deepseek-v4-pro'
const DEFAULT_TTL_MODEL = 'deepseek-v4-pro'
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000

export function resolveQuantLlmModel(
  lane: QuantLlmLane,
  env: NodeJS.ProcessEnv = process.env,
): QuantLlmModelSpec {
  if (lane === 'ttl') {
    const provider = readEnv(env, 'OPENALICE_LLM_TTL_PROVIDER') ?? 'anthropic'
    const baseUrl =
      readEnv(env, 'OPENALICE_LLM_TTL_BASE_URL') ??
      (provider === 'openai-compatible'
        ? readEnv(env, 'OPENALICE_LLM_BASE_URL') ??
          readEnv(env, 'OPENALICE_DEEPSEEK_BASE_URL') ??
          DEFAULT_DEEPSEEK_BASE_URL
        : undefined)
    const apiKeyEnv =
      readEnv(env, 'OPENALICE_LLM_TTL_API_KEY_ENV') ??
      (provider === 'openai-compatible'
        ? readEnv(env, 'OPENALICE_LLM_API_KEY_ENV') ??
          readEnv(env, 'OPENALICE_DEEPSEEK_API_KEY_ENV') ??
          'DEEPSEEK_API_KEY'
        : 'ANTHROPIC_API_KEY')
    return {
      lane,
      provider,
      model: readEnv(env, 'OPENALICE_LLM_TTL_MODEL') ??
        (provider === 'openai-compatible' ? DEFAULT_REGULAR_MODEL : DEFAULT_TTL_MODEL),
      baseUrl,
      apiKeyEnv,
      contextWindowTokens: readPositiveInt(
        env.OPENALICE_LLM_CONTEXT_WINDOW_TOKENS,
        DEFAULT_CONTEXT_WINDOW_TOKENS,
      ),
    }
  }

  const provider = readEnv(env, 'OPENALICE_LLM_PROVIDER') ?? 'anthropic'
  const baseUrl =
    readEnv(env, 'OPENALICE_LLM_BASE_URL') ??
    (provider === 'openai-compatible'
      ? readEnv(env, 'OPENALICE_DEEPSEEK_BASE_URL') ??
        DEFAULT_DEEPSEEK_BASE_URL
      : undefined)
  const apiKeyEnv =
    readEnv(env, 'OPENALICE_LLM_API_KEY_ENV') ??
    (provider === 'openai-compatible'
      ? readEnv(env, 'OPENALICE_DEEPSEEK_API_KEY_ENV') ??
        'DEEPSEEK_API_KEY'
      : 'NEWAPIS_API_KEY')
  const model = lane === 'analysis'
    ? readEnv(env, 'OPENALICE_LLM_ANALYSIS_MODEL') ??
      readEnv(env, 'OPENALICE_DEEPSEEK_PRO_MODEL') ??
      DEFAULT_ANALYSIS_MODEL
    : lane === 'event'
      ? readEnv(env, 'OPENALICE_LLM_EVENT_MODEL') ??
        readEnv(env, 'OPENALICE_LLM_REGULAR_MODEL') ??
        readEnv(env, 'OPENALICE_DEEPSEEK_FLASH_MODEL') ??
        DEFAULT_REGULAR_MODEL
      : readEnv(env, 'OPENALICE_LLM_REGULAR_MODEL') ??
        readEnv(env, 'OPENALICE_DEEPSEEK_FLASH_MODEL') ??
        DEFAULT_REGULAR_MODEL

  return {
    lane,
    provider,
    model,
    baseUrl,
    apiKeyEnv,
    contextWindowTokens: readPositiveInt(
      env.OPENALICE_LLM_CONTEXT_WINDOW_TOKENS,
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    ),
  }
}

export function describeQuantLlmModel(
  spec: QuantLlmModelSpec,
): {
  lane: QuantLlmLane
  provider: string
  model: string
  baseUrl: string | undefined
  apiKeyEnv: string | undefined
  contextWindowTokens: number
} {
  return {
    lane: spec.lane,
    provider: spec.provider,
    model: spec.model,
    baseUrl: spec.baseUrl ?? spec.baseURL,
    apiKeyEnv: spec.apiKeyEnv,
    contextWindowTokens: spec.contextWindowTokens,
  }
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
