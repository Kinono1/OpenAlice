import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { readAIProviderConfig } from '../../core/config.js'

type ModelConfig = {
  provider: string
  model: string
  baseURL?: string
  apiKey?: string
  apiKeyEnv?: string
  codexConfigPath?: string
  codexProvider?: string
}

interface CodexProviderConfig {
  provider: string
  model: string
  baseUrl: string
  bearerToken: string
}

export interface ModelFromConfig {
  model: LanguageModel
  key: string
}

export interface ModelOverride {
  provider: string
  model: string
  baseUrl?: string
  baseURL?: string
  apiKey?: string
  apiKeyEnv?: string
  codexConfigPath?: string
  codexProvider?: string
}

/** Create a Vercel AI SDK model from OpenAlice config. */
export async function createConfiguredModel(model: ModelConfig): Promise<LanguageModel> {
  const provider = model.provider.trim().toLowerCase()

  if (provider === 'anthropic') {
    const client = createAnthropic({
      apiKey: model.apiKey,
      baseURL: model.baseURL,
    })
    return client(model.model)
  }

  if (provider === 'google') {
    const client = createGoogleGenerativeAI({
      apiKey: model.apiKey,
      baseURL: model.baseURL,
    })
    return client(model.model)
  }

  if (provider === 'gmn') {
    const codex = await readCodexProviderConfig(model)
    const openai = createOpenAI({
      baseURL: codex.baseUrl,
      apiKey: codex.bearerToken,
      name: codex.provider,
    })
    return openai(codex.model)
  }

  if (provider === 'openai' || provider === 'openai-compatible') {
    const envName = model.apiKeyEnv ?? 'OPENAI_API_KEY'
    const apiKey = model.apiKey ?? process.env[envName]
    if (!apiKey) {
      throw new Error(
        `Model provider "${model.provider}" requires an API key. Set "${envName}" or model.apiKey in data/config/ai-provider-manager.json.`,
      )
    }

    const openai = createOpenAI({
      baseURL: model.baseURL,
      apiKey,
      name: provider === 'openai-compatible' ? 'openai-compatible' : undefined,
    })
    return openai(model.model)
  }

  throw new Error(
    `Unsupported model provider "${model.provider}". Supported: anthropic | gmn | google | openai | openai-compatible.`,
  )
}

export async function createModelFromConfig(override?: ModelOverride): Promise<ModelFromConfig> {
  const config = await readAIProviderConfig()
  const provider = (override?.provider ?? config.provider).trim().toLowerCase()
  const model = override?.model ?? config.model
  const baseURL = override?.baseUrl ?? override?.baseURL ?? config.baseUrl
  const apiKey = resolveLegacyApiKey(provider, override?.apiKey, config.apiKeys)
  const configuredModel = await createConfiguredModel({
    provider,
    model,
    baseURL,
    apiKey,
    apiKeyEnv: override?.apiKeyEnv,
    codexConfigPath: override?.codexConfigPath,
    codexProvider: override?.codexProvider,
  })

  return {
    model: configuredModel,
    key: `${provider}:${model}:${baseURL ?? ''}`,
  }
}

function resolveLegacyApiKey(
  provider: string,
  overrideApiKey: string | undefined,
  apiKeys: Record<string, string | undefined>,
): string | undefined {
  if (overrideApiKey) return overrideApiKey
  return apiKeys[provider]
}

async function readCodexProviderConfig(model: ModelConfig): Promise<CodexProviderConfig> {
  const configPath = model.codexConfigPath
    ?? process.env.CODEX_CONFIG_PATH
    ?? resolve(homedir(), '.codex/config.toml')
  const raw = await readFile(configPath, 'utf-8')

  const provider = model.codexProvider ?? readTomlString(raw, 'model_provider')
  if (!provider) {
    throw new Error(`Missing "model_provider" in Codex config: ${configPath}`)
  }

  const providerSection = readTomlSection(raw, `model_providers.${provider}`)
  const baseUrl = readTomlString(providerSection, 'base_url')
  const bearerToken = readTomlString(providerSection, 'experimental_bearer_token')
  const fallbackModel = readTomlString(raw, 'model')
  const selectedModel = model.model?.trim() ? model.model : fallbackModel

  if (!baseUrl) {
    throw new Error(`Missing "base_url" under [model_providers.${provider}] in ${configPath}`)
  }
  if (!bearerToken) {
    throw new Error(`Missing "experimental_bearer_token" under [model_providers.${provider}] in ${configPath}`)
  }
  if (!selectedModel) {
    throw new Error(`Missing model id in data/config/ai-provider-manager.json and Codex config ${configPath}`)
  }

  return {
    provider,
    model: selectedModel,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    bearerToken,
  }
}

function readTomlString(toml: string, key: string): string | undefined {
  const lines = toml.split(/\r?\n/)
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('[')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const k = t.slice(0, eq).trim()
    if (k !== key) continue

    const rawValue = t.slice(eq + 1).trim()
    const quoted = rawValue.match(/^"([^"]*)"/)
    if (quoted) return quoted[1]

    const plain = rawValue.split('#')[0]?.trim()
    return plain || undefined
  }
  return undefined
}

function readTomlSection(toml: string, section: string): string {
  const lines = toml.split(/\r?\n/)
  const target = `[${section}]`
  const out: string[] = []
  let inTarget = false

  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('[') && t.endsWith(']')) {
      if (t === target) {
        inTarget = true
        continue
      }
      if (inTarget) break
    }
    if (inTarget) out.push(line)
  }

  return out.join('\n')
}
