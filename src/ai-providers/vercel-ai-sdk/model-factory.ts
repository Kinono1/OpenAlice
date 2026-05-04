/**
 * Model factory — creates Vercel AI SDK LanguageModel instances from a resolved profile.
 *
 * Uses dynamic imports so unused provider packages don't prevent startup.
 */

import type { LanguageModel } from 'ai'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ResolvedProfile } from '../../core/config.js'

/** Result includes the model plus a cache key for change detection. */
export interface ModelFromConfig {
  model: LanguageModel
  /** Stable fingerprint of provider/model/baseUrl/API-key presence and value. */
  key: string
}

export async function createModelFromProfile(profile: ResolvedProfile): Promise<ModelFromConfig> {
  const p = profile.provider ?? 'anthropic'
  const m = profile.model
  const url = profile.baseUrl
  const apiKey = profile.apiKey
  const key = modelConfigCacheKey({ provider: p, model: m, baseUrl: url, apiKey })

  switch (p) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const client = createAnthropic({ apiKey: apiKey || undefined, baseURL: url || undefined })
      return { model: client(m), key }
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      const client = createOpenAI({ apiKey: apiKey || undefined, baseURL: url || undefined })
      return { model: client(m), key }
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const client = createGoogleGenerativeAI({ apiKey: apiKey || undefined, baseURL: url || undefined })
      return { model: client(m), key }
    }
    default:
      throw new Error(`Unsupported model provider: "${p}". Supported: anthropic, openai, google`)
  }
}

export function modelConfigCacheKey(input: {
  provider: string
  model: string
  baseUrl?: string
  apiKey?: string
}): string {
  const apiKeyFingerprint = input.apiKey
    ? createHash('sha256').update(input.apiKey, 'utf-8').digest('hex').slice(0, 16)
    : 'none'
  return [
    input.provider,
    input.model,
    input.baseUrl ?? '',
    `apiKey:${apiKeyFingerprint}`,
  ].join(':')
}

export interface ConfiguredModelSpec {
  provider: 'openai-compatible' | 'gmn'
  model: string
  baseURL?: string
  apiKeyEnv?: string
  codexConfigPath?: string
}

function readTomlString(content: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm')
  return pattern.exec(content)?.[1]
}

function readTomlSection(content: string, section: string): string {
  const start = content.indexOf(`[${section}]`)
  if (start < 0) return ''
  const rest = content.slice(start)
  const next = rest.slice(1).search(/^\s*\[/m)
  return next >= 0 ? rest.slice(0, next + 1) : rest
}

export async function createConfiguredModel(spec: ConfiguredModelSpec): Promise<LanguageModel> {
  if (spec.provider === 'openai-compatible') {
    const apiKey = spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : undefined
    if (!apiKey) {
      throw new Error('openai-compatible provider requires an API key')
    }
    const { createOpenAI } = await import('@ai-sdk/openai')
    const client = createOpenAI({
      baseURL: spec.baseURL,
      apiKey,
      name: 'openai-compatible',
    })
    return client(spec.model)
  }

  const configPath = spec.codexConfigPath
  if (!configPath) {
    throw new Error('gmn provider requires codexConfigPath')
  }
  const content = await readFile(configPath, 'utf-8')
  const providerName = readTomlString(content, 'model_provider') ?? 'default'
  const model = spec.model || readTomlString(content, 'model') || 'gpt-4o-mini'
  const section = readTomlSection(content, `model_providers.${providerName}`)
  const baseURL = readTomlString(section, 'base_url')?.replace(/\/+$/, '')
  const apiKey = readTomlString(section, 'experimental_bearer_token')
  if (!apiKey) {
    throw new Error(`gmn provider "${providerName}" requires experimental_bearer_token`)
  }
  const { createOpenAI } = await import('@ai-sdk/openai')
  const client = createOpenAI({ baseURL, apiKey, name: providerName })
  return client(model)
}
