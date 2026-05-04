import {
  generateObject,
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
} from 'ai'
import type { z } from 'zod'
import type { SharedV3ProviderOptions } from '@ai-sdk/provider'
import type { ModelOverride } from '../ai-providers/vercel-ai-sdk/model-factory.js'

export interface LlmUsageSnapshot {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  noCacheTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  promptCacheHitTokens?: number
  promptCacheMissTokens?: number
  textTokens?: number
  reasoningTokens?: number
  raw?: Record<string, unknown>
}

export function shouldUseTextJsonMode(modelOverride?: ModelOverride): boolean {
  const provider = modelOverride?.provider?.trim().toLowerCase()
  const model = modelOverride?.model?.trim().toLowerCase() ?? ''
  const baseUrl = (modelOverride?.baseUrl ?? modelOverride?.baseURL ?? '').trim().toLowerCase()
  return provider === 'openai-compatible' || model.includes('deepseek') || baseUrl.includes('deepseek')
}

function buildProviderOptions(providerName?: string): SharedV3ProviderOptions | undefined {
  if (providerName !== 'openai-compatible') return undefined
  return { 'openai-compatible': { reasoningEffort: 'xhigh', forceReasoning: true } }
}

export function summarizeLlmUsage(usage: LanguageModelUsage): LlmUsageSnapshot {
  const raw = asRecord(usage.raw)
  const promptDetails = asRecord(raw?.prompt_tokens_details)
  const cacheReadTokens =
    usage.inputTokenDetails.cacheReadTokens ??
    usage.cachedInputTokens ??
    readNumber(raw?.prompt_cache_hit_tokens) ??
    readNumber(promptDetails?.cached_tokens)
  const noCacheTokens =
    usage.inputTokenDetails.noCacheTokens ??
    readNumber(raw?.prompt_cache_miss_tokens)

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    noCacheTokens,
    cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
    promptCacheHitTokens: cacheReadTokens,
    promptCacheMissTokens: noCacheTokens,
    textTokens: usage.outputTokenDetails.textTokens,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? usage.reasoningTokens,
    raw,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function extractJsonObjectText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('{')
  if (start < 0) {
    throw new Error('LLM response did not contain a JSON object')
  }

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return candidate.slice(start, i + 1)
      }
    }
  }

  throw new Error('LLM response contained an incomplete JSON object')
}

export async function generateZodJsonObject<TSchema extends z.ZodTypeAny>(input: {
  model: LanguageModel
  schema: TSchema
  prompt: string
  temperature?: number
  modelOverride?: ModelOverride
  jsonInstruction: string
  providerName?: string
  onUsage?: (usage: LlmUsageSnapshot) => void
}): Promise<z.infer<TSchema>> {
  const providerOptions = buildProviderOptions(input.providerName)

  if (!shouldUseTextJsonMode(input.modelOverride)) {
    const { object, usage } = await generateObject({
      model: input.model,
      schema: input.schema,
      prompt: input.prompt,
      temperature: input.temperature,
      providerOptions,
    })
    input.onUsage?.(summarizeLlmUsage(usage))
    return input.schema.parse(object)
  }

  const { text, usage } = await generateText({
    model: input.model,
    temperature: input.temperature,
    providerOptions,
    prompt: `${input.prompt}

Return exactly one valid JSON object and no markdown.
The JSON object must satisfy this contract:
${input.jsonInstruction}`,
  })

  input.onUsage?.(summarizeLlmUsage(usage))
  return input.schema.parse(JSON.parse(extractJsonObjectText(text)))
}
