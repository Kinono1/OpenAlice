import { generateObject, generateText } from 'ai'
import type { LanguageModel, LanguageModelUsage } from 'ai'
import { z } from 'zod'

export type StructuredGenerationFallbackReason =
  | 'provider_requires_text_json'
  | 'native_object_unsupported'
  | 'native_object_failed'
  | 'schema_validation_failed'
  | 'no_json_found'

export interface LlmUsageSnapshot {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  promptCacheHitTokens?: number
  promptCacheMissTokens?: number
  raw?: unknown
}

export interface StructuredGenerationResult<TObject> {
  object: TObject
  usage?: LlmUsageSnapshot
  fallbackReason?: StructuredGenerationFallbackReason
  reasoningContent?: string
  rawText?: string
}

export interface GenerateStructuredObjectInput<TSchema extends z.ZodType> {
  model: LanguageModel
  schema: TSchema
  prompt: string
  system?: string
  jsonInstruction?: string
  temperature?: number
  providerName?: string
  mode?: 'auto' | 'native_object' | 'text_json'
  schemaName?: string
  schemaDescription?: string
  maxRetries?: number
}

export interface StructuredGenerationCompatibilityUsageEvent {
  generatedAt: string
  usage?: LlmUsageSnapshot
  fallbackReason?: StructuredGenerationFallbackReason
  providerName?: string
}

export class StructuredGenerationError extends Error {
  constructor(
    readonly reason: StructuredGenerationFallbackReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message)
    this.name = 'StructuredGenerationError'
    this.cause = options?.cause
  }
}

const compatibilityUsageEvents: StructuredGenerationCompatibilityUsageEvent[] = []

const DEFAULT_JSON_INSTRUCTION =
  'Return only one valid JSON object that matches the requested schema. Do not include Markdown fences or explanatory text.'

export async function generateStructuredObject<TSchema extends z.ZodType>(
  input: GenerateStructuredObjectInput<TSchema>,
): Promise<StructuredGenerationResult<z.output<TSchema>>> {
  const mode = input.mode ?? 'auto'

  if (mode === 'text_json') {
    return generateTextJsonObject(input, 'provider_requires_text_json')
  }

  try {
    return await generateNativeObject(input)
  } catch (error) {
    if (mode === 'native_object') {
      throw toStructuredGenerationError(error, classifyNativeObjectError(error))
    }
    const reason = classifyNativeObjectError(error)
    return generateTextJsonObject(input, reason)
  }
}

export async function generateZodJsonObject<TSchema extends z.ZodType>(
  input: GenerateStructuredObjectInput<TSchema>,
): Promise<z.output<TSchema>> {
  const result = await generateStructuredObject(input)
  compatibilityUsageEvents.push({
    generatedAt: new Date().toISOString(),
    usage: result.usage,
    fallbackReason: result.fallbackReason,
    providerName: input.providerName,
  })
  return result.object
}

export function getStructuredGenerationCompatibilityUsageEvents(): StructuredGenerationCompatibilityUsageEvent[] {
  return [...compatibilityUsageEvents]
}

export function clearStructuredGenerationCompatibilityUsageEvents(): void {
  compatibilityUsageEvents.length = 0
}

export function normalizeLlmUsage(rawUsage: unknown): LlmUsageSnapshot | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return undefined
  }

  const usage = rawUsage as Record<string, unknown>
  const raw = asRecord(usage.raw)
  const inputDetails = asRecord(usage.inputTokenDetails)
  const outputDetails = asRecord(usage.outputTokenDetails)
  const completionDetails = asRecord(raw?.completion_tokens_details)

  const snapshot: LlmUsageSnapshot = {
    inputTokens:
      readNumber(usage.inputTokens) ??
      readNumber(usage.prompt_tokens) ??
      readNumber(raw?.prompt_tokens),
    outputTokens:
      readNumber(usage.outputTokens) ??
      readNumber(usage.completion_tokens) ??
      readNumber(raw?.completion_tokens),
    totalTokens:
      readNumber(usage.totalTokens) ??
      readNumber(usage.total_tokens) ??
      readNumber(raw?.total_tokens),
    reasoningTokens:
      readNumber(outputDetails?.reasoningTokens) ??
      readNumber(usage.reasoningTokens) ??
      readNumber(usage.reasoning_tokens) ??
      readNumber(raw?.reasoning_tokens) ??
      readNumber(completionDetails?.reasoning_tokens),
    promptCacheHitTokens:
      readNumber(inputDetails?.cacheReadTokens) ??
      readNumber(usage.cachedInputTokens) ??
      readNumber(usage.promptCacheHitTokens) ??
      readNumber(usage.prompt_cache_hit_tokens) ??
      readNumber(raw?.prompt_cache_hit_tokens),
    promptCacheMissTokens:
      readNumber(inputDetails?.noCacheTokens) ??
      readNumber(usage.promptCacheMissTokens) ??
      readNumber(usage.prompt_cache_miss_tokens) ??
      readNumber(raw?.prompt_cache_miss_tokens),
    raw: rawUsage,
  }

  return hasUsageValue(snapshot) ? snapshot : { raw: rawUsage }
}

export function extractJsonFromText(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }

  const direct = parseJsonOrNull(trimmed)
  if (direct !== null) {
    return direct
  }

  for (const candidate of fencedJsonCandidates(trimmed)) {
    const parsed = parseJsonOrNull(candidate.trim())
    if (parsed !== null) {
      return parsed
    }
  }

  for (const candidate of balancedJsonCandidates(trimmed)) {
    const parsed = parseJsonOrNull(candidate)
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

async function generateNativeObject<TSchema extends z.ZodType>(
  input: GenerateStructuredObjectInput<TSchema>,
): Promise<StructuredGenerationResult<z.output<TSchema>>> {
  const result = await generateObject({
    model: input.model,
    schema: input.schema,
    prompt: input.prompt,
    ...(input.system ? { system: input.system } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.schemaName ? { schemaName: input.schemaName } : {}),
    ...(input.schemaDescription ? { schemaDescription: input.schemaDescription } : {}),
    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
  })

  return {
    object: parseWithSchema(input.schema, result.object, 'schema_validation_failed'),
    usage: normalizeLlmUsage(result.usage),
    reasoningContent: result.reasoning,
  }
}

async function generateTextJsonObject<TSchema extends z.ZodType>(
  input: GenerateStructuredObjectInput<TSchema>,
  fallbackReason: StructuredGenerationFallbackReason,
): Promise<StructuredGenerationResult<z.output<TSchema>>> {
  const prompt = `${input.prompt}\n\n${input.jsonInstruction ?? DEFAULT_JSON_INSTRUCTION}`
  const result = await generateText({
    model: input.model,
    prompt,
    ...(input.system ? { system: input.system } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
  })
  const json = extractJsonFromText(result.text ?? '')
  if (json === null) {
    throw new StructuredGenerationError(
      'no_json_found',
      'Structured generation text-json fallback did not contain a JSON object',
    )
  }

  return {
    object: parseWithSchema(input.schema, json, 'schema_validation_failed'),
    usage: normalizeLlmUsage((result as { usage?: LanguageModelUsage }).usage),
    fallbackReason,
    rawText: result.text ?? '',
  }
}

function parseWithSchema<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  reason: StructuredGenerationFallbackReason,
): z.output<TSchema> {
  try {
    return schema.parse(value)
  } catch (error) {
    throw new StructuredGenerationError(reason, 'Structured generation result failed schema validation', {
      cause: error,
    })
  }
}

function classifyNativeObjectError(error: unknown): StructuredGenerationFallbackReason {
  const message = error instanceof Error ? error.message : String(error)
  return /unsupported|not supported|no object|object generation/i.test(message)
    ? 'native_object_unsupported'
    : 'native_object_failed'
}

function toStructuredGenerationError(
  error: unknown,
  reason: StructuredGenerationFallbackReason,
): StructuredGenerationError {
  if (error instanceof StructuredGenerationError) {
    return error
  }
  return new StructuredGenerationError(reason, `Structured generation failed: ${errorMessage(error)}`, {
    cause: error,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseJsonOrNull(raw: string): unknown | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function fencedJsonCandidates(text: string): string[] {
  const matches: string[] = []
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = fenceRe.exec(text)) !== null) {
    matches.push(match[1])
  }
  return matches
}

function balancedJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  for (let start = 0; start < text.length; start++) {
    const char = text[start]
    if (char !== '{' && char !== '[') {
      continue
    }
    const candidate = readBalancedJsonCandidate(text, start)
    if (candidate) {
      candidates.push(candidate)
    }
  }
  return candidates
}

function readBalancedJsonCandidate(text: string, start: number): string | null {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      stack.push('}')
      continue
    }
    if (char === '[') {
      stack.push(']')
      continue
    }
    if (char === '}' || char === ']') {
      const expected = stack.pop()
      if (char !== expected) {
        return null
      }
      if (stack.length === 0) {
        return text.slice(start, index + 1)
      }
    }
  }

  return null
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function hasUsageValue(snapshot: LlmUsageSnapshot): boolean {
  return snapshot.inputTokens !== undefined ||
    snapshot.outputTokens !== undefined ||
    snapshot.totalTokens !== undefined ||
    snapshot.reasoningTokens !== undefined ||
    snapshot.promptCacheHitTokens !== undefined ||
    snapshot.promptCacheMissTokens !== undefined
}
