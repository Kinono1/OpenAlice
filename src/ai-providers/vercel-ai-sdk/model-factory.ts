import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { LanguageModel } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'

interface ModelConfig {
  provider: string
  model: string
  apiKeyEnv?: string
  apiKey?: string
  baseURL?: string
  codexConfigPath?: string
  codexProvider?: string
}

interface CodexProviderConfig {
  provider: string
  model: string
  baseUrl: string
  bearerToken: string
}

/** Create a Vercel AI SDK model from OpenAlice model config. */
export async function createConfiguredModel(model: ModelConfig): Promise<LanguageModel> {
  const provider = model.provider.trim().toLowerCase()

  if (provider === 'anthropic') {
    return anthropic(model.model)
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
        `Model provider "${model.provider}" requires an API key. Set "${envName}" or model.apiKey in data/config/model.json.`,
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
    `Unsupported model provider "${model.provider}". Supported: anthropic | gmn | openai | openai-compatible.`,
  )
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
    throw new Error(`Missing model id in data/config/model.json and Codex config ${configPath}`)
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
