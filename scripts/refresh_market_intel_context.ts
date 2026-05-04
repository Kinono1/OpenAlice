/**
 * Refresh the single effective MarketIntelContext.
 *
 * This is a file-protocol bridge between RSS/news, SystemFuse, Pro/Flash-style
 * model governance, and paper strategies. It does not place orders.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createModelFromConfig } from '../src/ai-providers/vercel-ai-sdk/model-factory.js'
import type { NewsRecord } from '../src/domain/news/types.js'
import {
  BLOCKED_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE,
  DEFAULT_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE,
  DEFAULT_MARKET_INTEL_CONTEXT_PATH,
  DEFAULT_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE,
  DEFAULT_PRO_RISK_POLICY_PATH,
  FLASH_MAX_FALLBACK_AGE_MS,
  MARKET_INTEL_LANES,
  MIN_FLASH_INTERVAL_MS,
  ZERO_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE,
  type MarketIntelLane,
} from '../src/runtime/market_intel_constants.js'
import {
  createBootstrapMarketIntelContext,
  nextMarketIntelContext,
  normalizeAllowNewPositionsByLane,
  normalizeBannedSymbols,
  normalizeExposureMultiplierByLane,
  normalizeFlashConfidenceByLane,
  normalizeRuleThresholdByLane,
  readMarketIntelContext,
  writeMarketIntelContext,
  type MarketIntelContext,
} from '../src/runtime/market_intel_context.js'
import {
  isProRiskPolicyActive,
  readProRiskPolicy,
  type ProRiskPolicy,
} from '../src/runtime/pro_risk_policy.js'
import { readSystemFuse } from '../src/runtime/system_fuse.js'
import { createInflightCall, isInflightCallCurrent } from '../src/runtime/inflight_call.js'
import { appendJsonlSync } from '../src/runtime/runtime_events.js'
import { describeQuantLlmModel, resolveQuantLlmModel, type QuantLlmLane } from '../src/runtime/llm_model_routing.js'
import {
  generateZodJsonObject,
  type LlmUsageSnapshot,
} from '../src/runtime/llm_json_generation.js'

const NEWS_LOG_PATH = 'data/news-collector/news.jsonl'
const FLASH_CALL_LOG_DIR = 'data/runtime'
const TTL_REFRESH_MS = 5 * 60_000

const LlmConfidenceIntervalSchema = z.object({
  confidence: z.number().min(0).max(1),
  confidenceLow: z.number().min(0).max(1),
  confidenceHigh: z.number().min(0).max(1),
})

const LlmLaneBooleanMapSchema = z.object({
  cross_sectional: z.boolean(),
  volume_breakout_1x: z.boolean(),
  volume_breakout_3x: z.boolean(),
  microstructure_10x: z.boolean(),
  microstructure_100x: z.boolean(),
}).strict()

const LlmLaneExposureMapSchema = z.object({
  cross_sectional: z.number().min(0).max(1),
  volume_breakout_1x: z.number().min(0).max(1),
  volume_breakout_3x: z.number().min(0).max(1),
  microstructure_10x: z.number().min(0).max(1),
  microstructure_100x: z.number().min(0).max(1),
}).strict()

const LlmLaneConfidenceMapSchema = z.object({
  cross_sectional: LlmConfidenceIntervalSchema,
  volume_breakout_1x: LlmConfidenceIntervalSchema,
  volume_breakout_3x: LlmConfidenceIntervalSchema,
  microstructure_10x: LlmConfidenceIntervalSchema,
  microstructure_100x: LlmConfidenceIntervalSchema,
}).strict()

const MarketIntelLlmSchema = z.object({
  riskMode: z.enum(['risk_on', 'risk_reduced', 'risk_off']),
  newsRiskRegime: z.enum(['normal', 'elevated', 'severe']),
  allowNewPositionsByLane: LlmLaneBooleanMapSchema,
  exposureMultiplierByLane: LlmLaneExposureMapSchema,
  bannedSymbols: z.array(z.string()),
  flashConfidenceByLane: LlmLaneConfidenceMapSchema,
  reasoning: z.string().max(600),
})

type MarketIntelLlmOutput = z.infer<typeof MarketIntelLlmSchema>

interface NewsDeltaSummary {
  records: NewsRecord[]
  maxSeq: number
  trigger: 'none' | 'ttl' | 'event'
  reasons: string[]
  severe: boolean
  collectorRoundId: string | null
}

interface CliArgs {
  dryRun: boolean
}

export function loadNewsRecords(path = NEWS_LOG_PATH): NewsRecord[] {
  if (!existsSync(path)) return []
  const out: NewsRecord[] = []
  const raw = readFileSync(path, 'utf-8')
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as NewsRecord)
    } catch {
      // Ignore malformed JSONL rows.
    }
  }
  return out.sort((a, b) => a.seq - b.seq)
}

export function summarizeNewsDelta(records: NewsRecord[], context: MarketIntelContext): NewsDeltaSummary {
  const lastSeq = context.sourceEpoch.newsEpoch
  const maxSeq = records.reduce((max, record) => Math.max(max, record.seq), lastSeq)
  if (lastSeq === 0 && context.bootstrap) {
    return {
      records: [],
      maxSeq,
      trigger: 'none',
      reasons: records.length > 0 ? [`bootstrap_news_baseline:${records.length}`] : [],
      severe: false,
      collectorRoundId: null,
    }
  }
  const delta = records.filter(record => record.seq > lastSeq)
  const severe = delta.some(record => hasSevereKeyword(`${record.title} ${record.content}`))
  const roundCounts = new Map<string, number>()
  for (const record of delta) {
    const roundId = record.metadata.collectorRoundId
    if (!roundId) continue
    roundCounts.set(roundId, (roundCounts.get(roundId) ?? 0) + 1)
  }
  const batch = [...roundCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null
  const reasons: string[] = []
  if (severe) reasons.push('severe_news_keyword')
  if (batch && batch[1] >= 3) reasons.push(`rss_batch_delta:${batch[1]}`)
  if (delta.length > 0) reasons.push(`news_delta:${delta.length}`)

  return {
    records: delta,
    maxSeq,
    trigger: severe || (batch && batch[1] >= 3) ? 'event' : 'none',
    reasons,
    severe,
    collectorRoundId: batch?.[0] ?? null,
  }
}

export function shouldCallLlm(input: {
  context: MarketIntelContext
  news: NewsDeltaSummary
  nowMs: number
}): { lane: QuantLlmLane | null; trigger: 'none' | 'ttl' | 'event'; reason: string } {
  const lastFlash = input.context.sourceEpoch.flashEpoch
  if (lastFlash > 0 && input.nowMs - lastFlash < MIN_FLASH_INTERVAL_MS) {
    return { lane: null, trigger: 'none', reason: 'rate_limited' }
  }
  if (input.news.trigger === 'event') return { lane: 'event', trigger: 'event', reason: input.news.reasons.join(';') }
  const flashAge = lastFlash > 0 ? input.nowMs - lastFlash : Number.POSITIVE_INFINITY
  if (flashAge >= TTL_REFRESH_MS) return { lane: 'ttl', trigger: 'ttl', reason: `ttl_expired:${flashAge}` }
  return { lane: null, trigger: 'none', reason: 'no_trigger' }
}

export function buildLocalContext(input: {
  previous: MarketIntelContext
  news: NewsDeltaSummary
  fuseRiskOff: boolean
  proRiskPolicy: ProRiskPolicy
  now: Date
  llm?: MarketIntelLlmOutput
  trigger: string
  modelLane: string
  model: string
  reasons: string[]
}): MarketIntelContext {
  const previous = input.previous
  const nowIso = input.now.toISOString()
  const fallbackTooOld = previous.sourceEpoch.flashEpoch > 0 &&
    input.now.getTime() - previous.sourceEpoch.flashEpoch > FLASH_MAX_FALLBACK_AGE_MS
  const hardRiskOff = input.fuseRiskOff || input.news.severe || fallbackTooOld
  const coldStart = Math.max(0, previous.coldStartRoundsRemaining - 1)
  const llm = input.llm
  const allowBase = hardRiskOff || coldStart > 0
    ? BLOCKED_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE
    : DEFAULT_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE
  const llmAllow = llm
    ? normalizeAllowNewPositionsByLane(llm.allowNewPositionsByLane, BLOCKED_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE)
    : null
  const llmExposure = llm
    ? normalizeExposureMultiplierByLane(llm.exposureMultiplierByLane, ZERO_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE)
    : null
  const llmConfidence = llm
    ? normalizeFlashConfidenceByLane(llm.flashConfidenceByLane)
    : null
  const allowMerged = hardRiskOff
    ? { ...BLOCKED_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE }
    : { ...(llmAllow ?? allowBase) }
  const exposureMerged = hardRiskOff
    ? { ...ZERO_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE }
    : { ...(llmExposure ?? DEFAULT_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE) }
  const proPolicyActive = isProRiskPolicyActive(input.proRiskPolicy, input.now.getTime())
  const proReasons: string[] = []
  if (proPolicyActive) {
    proReasons.push(`pro_policy:${input.proRiskPolicy.verdict}`)
    for (const [lane, pause] of Object.entries(input.proRiskPolicy.pauseLaneRecommendations)) {
      if (!pause) continue
      proReasons.push(`pro_pause_lane:${lane}`)
      if (!isMarketIntelLane(lane)) continue
      allowMerged[lane] = false
      exposureMerged[lane] = 0
    }
    for (const symbol of input.proRiskPolicy.symbolBlocks) {
      proReasons.push(`pro_symbol_block:${symbol}`)
    }
  }
  const bannedSymbols = normalizeBannedSymbols([
    ...(hardRiskOff ? inferBannedSymbols(input.news.records) : llm?.bannedSymbols ?? []),
    ...(proPolicyActive ? input.proRiskPolicy.symbolBlocks : []),
  ])
  const suggestedRuleThresholdByLane = proPolicyActive
    ? normalizeRuleThresholdByLane(input.proRiskPolicy.suggestedRuleThresholdByLane)
    : {}

  return nextMarketIntelContext(previous, {
    generatedAt: nowIso,
    validUntil: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
    riskMode: hardRiskOff
      ? 'risk_off'
      : llm?.riskMode ?? (coldStart > 0 ? 'risk_off' : 'risk_reduced'),
    newsRiskRegime: input.news.severe
      ? 'severe'
      : llm?.newsRiskRegime ?? (input.news.records.length > 0 ? 'elevated' : 'normal'),
    allowNewPositionsByLane: allowMerged,
    exposureMultiplierByLane: exposureMerged,
    bannedSymbols,
    suggestedRuleThresholdByLane,
    coldStartRoundsRemaining: coldStart,
    flashConfidenceByLane: llmConfidence ?? previous.flashConfidenceByLane,
    semanticValidation: validateSemantic({
      riskMode: hardRiskOff ? 'risk_off' : llm?.riskMode ?? previous.riskMode,
      allowNewPositionsByLane: allowMerged,
    }),
    sourceEpoch: {
      ...previous.sourceEpoch,
      newsEpoch: Math.max(previous.sourceEpoch.newsEpoch, input.news.maxSeq),
      flashEpoch: llm ? input.now.getTime() : previous.sourceEpoch.flashEpoch,
      proEpoch: proPolicyActive ? input.proRiskPolicy.proEpoch : 0,
    },
    bootstrap: false,
    trigger: input.trigger,
    modelLane: llm ? input.modelLane : previous.modelLane ?? input.modelLane,
    model: llm ? input.model : previous.model ?? input.model,
    reasons: [...input.reasons, ...proReasons],
  })
}

function isMarketIntelLane(value: string): value is MarketIntelLane {
  return (MARKET_INTEL_LANES as readonly string[]).includes(value)
}

async function runLlm(input: {
  lane: QuantLlmLane
  trigger: 'ttl' | 'event'
  context: MarketIntelContext
  news: NewsDeltaSummary
}): Promise<{
  output: MarketIntelLlmOutput | null
  model: string
  modelLane: QuantLlmLane
  superseded: boolean
  error: string | null
}> {
  const spec = resolveQuantLlmModel(input.lane)
  const modelInfo = describeQuantLlmModel(spec)
  const inflight = createInflightCall({
    trigger: input.trigger,
    priority: input.trigger === 'event' ? 'high' : 'low',
  })
  const startedAt = Date.now()

  if (input.lane === 'ttl' && !hasDirectApiKey(spec)) {
    return runEventFallbackLlm({
      input,
      inflightCallId: inflight.callId,
      startedAt,
      primaryError: `ttl_primary_unconfigured:${spec.apiKeyEnv ?? spec.provider}_missing`,
    })
  }

  try {
    const { model, providerName } = await createModelFromConfig(spec)
    let usage: LlmUsageSnapshot | undefined
    const output = await generateZodJsonObject({
      model,
      schema: MarketIntelLlmSchema,
      modelOverride: spec,
      providerName,
      temperature: 0.1,
      prompt: buildLlmPrompt(input.context, input.news),
      jsonInstruction: marketIntelJsonInstruction(),
      onUsage: snapshot => {
        usage = snapshot
      },
    })
    const superseded = !isInflightCallCurrent(inflight.callId)
    logFlashCall({
      callId: inflight.callId,
      trigger: input.trigger,
      modelLane: input.lane,
      model: modelInfo.model,
      latencyMs: Date.now() - startedAt,
      riskModeOut: output.riskMode,
      newsRiskRegimeOut: output.newsRiskRegime,
      fallbackUsed: false,
      superseded,
      error: null,
      usage,
    })
    return { output: superseded ? null : output, model: modelInfo.model, modelLane: input.lane, superseded, error: null }
  } catch (error) {
    if (input.lane === 'ttl') {
      return runEventFallbackLlm({
        input,
        inflightCallId: inflight.callId,
        startedAt,
        primaryError: `ttl_primary_failed:${error instanceof Error ? error.message : String(error)}`,
      })
    }
    logFlashCall({
      callId: inflight.callId,
      trigger: input.trigger,
      modelLane: input.lane,
      model: modelInfo.model,
      latencyMs: Date.now() - startedAt,
      riskModeOut: null,
      newsRiskRegimeOut: null,
      fallbackUsed: true,
      superseded: !isInflightCallCurrent(inflight.callId),
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      output: null,
      model: modelInfo.model,
      modelLane: input.lane,
      superseded: !isInflightCallCurrent(inflight.callId),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runEventFallbackLlm(input: {
  input: {
    lane: QuantLlmLane
    trigger: 'ttl' | 'event'
    context: MarketIntelContext
    news: NewsDeltaSummary
  }
  inflightCallId: string
  startedAt: number
  primaryError: string
}): Promise<{
  output: MarketIntelLlmOutput | null
  model: string
  modelLane: QuantLlmLane
  superseded: boolean
  error: string | null
}> {
  try {
    const fallbackSpec = resolveQuantLlmModel('event')
    const fallbackInfo = describeQuantLlmModel(fallbackSpec)
    const { model, providerName } = await createModelFromConfig(fallbackSpec)
    let usage: LlmUsageSnapshot | undefined
    const output = await generateZodJsonObject({
      model,
      schema: MarketIntelLlmSchema,
      modelOverride: fallbackSpec,
      providerName,
      temperature: 0.1,
      prompt: buildLlmPrompt(input.input.context, input.input.news),
      jsonInstruction: marketIntelJsonInstruction(),
      onUsage: snapshot => {
        usage = snapshot
      },
    })
    const superseded = !isInflightCallCurrent(input.inflightCallId)
    logFlashCall({
      callId: input.inflightCallId,
      trigger: input.input.trigger,
      modelLane: 'event',
      model: fallbackInfo.model,
      latencyMs: Date.now() - input.startedAt,
      riskModeOut: output.riskMode,
      newsRiskRegimeOut: output.newsRiskRegime,
      fallbackUsed: true,
      superseded,
      error: input.primaryError,
      usage,
    })
    return { output: superseded ? null : output, model: fallbackInfo.model, modelLane: 'event', superseded, error: null }
  } catch (fallbackError) {
    const fallbackSpec = resolveQuantLlmModel('event')
    const fallbackInfo = describeQuantLlmModel(fallbackSpec)
    const superseded = !isInflightCallCurrent(input.inflightCallId)
    logFlashCall({
      callId: input.inflightCallId,
      trigger: input.input.trigger,
      modelLane: 'event',
      model: fallbackInfo.model,
      latencyMs: Date.now() - input.startedAt,
      riskModeOut: null,
      newsRiskRegimeOut: null,
      fallbackUsed: true,
      superseded,
      error: `${input.primaryError};event_fallback_failed:${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
    })
    return {
      output: null,
      model: fallbackInfo.model,
      modelLane: 'event',
      superseded,
      error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
    }
  }
}

function hasDirectApiKey(spec: ReturnType<typeof resolveQuantLlmModel>): boolean {
  if (spec.apiKey?.trim()) return true
  const provider = spec.provider.trim().toLowerCase()
  const envName = spec.apiKeyEnv ?? defaultApiKeyEnvForProvider(provider)
  return envName ? Boolean(process.env[envName]?.trim()) : true
}

function defaultApiKeyEnvForProvider(provider: string): string | null {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY'
  if (provider === 'google') return 'GOOGLE_GENERATIVE_AI_API_KEY'
  if (provider === 'openai' || provider === 'openai-compatible') return 'OPENAI_API_KEY'
  return null
}

function marketIntelJsonInstruction(): string {
  const laneShape = MARKET_INTEL_LANES.map(lane => `    "${lane}": <value>`).join(',\n')
  return `Return exactly one JSON object. All lane maps must contain exactly these five keys and no generic keys like "spot" or "perpetual":
${MARKET_INTEL_LANES.join(', ')}

{
  "riskMode": "risk_on" | "risk_reduced" | "risk_off",
  "newsRiskRegime": "normal" | "elevated" | "severe",
  "allowNewPositionsByLane": {
${laneShape.replaceAll('<value>', 'boolean')}
  },
  "exposureMultiplierByLane": {
${laneShape.replaceAll('<value>', 'number between 0 and 1')}
  },
  "bannedSymbols": string[],
  "flashConfidenceByLane": {
${laneShape.replaceAll('<value>', '{ "confidence": number, "confidenceLow": number, "confidenceHigh": number }')}
  },
  "reasoning": string
}`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) {
    const previous = readMarketIntelContext(DEFAULT_MARKET_INTEL_CONTEXT_PATH)
    const news = summarizeNewsDelta(loadNewsRecords(), previous)
    const decision = shouldCallLlm({ context: previous, news, nowMs: Date.now() })
    console.log(JSON.stringify({
      family: 'market_intel',
      command: 'refresh_market_intel_context',
      executionMode: {
        dryRun: true,
        writesMarketIntelContext: false,
        writesRefreshReport: false,
        callsLlm: false,
        placesOrders: false,
      },
      current: {
        contextGeneration: previous.contextGeneration,
        riskMode: previous.riskMode,
        newsRiskRegime: previous.newsRiskRegime,
      },
      news: {
        trigger: news.trigger,
        reasons: news.reasons,
        maxSeq: news.maxSeq,
      },
      llmDecision: decision,
      optIn: {
        refreshContext: '--dryRun false',
      },
    }, null, 2))
    return
  }

  let previous = readMarketIntelContext(DEFAULT_MARKET_INTEL_CONTEXT_PATH)
  if (previous.contextGeneration === 0 && previous.bootstrap) {
    writeMarketIntelContext(previous, { path: DEFAULT_MARKET_INTEL_CONTEXT_PATH })
  }

  const now = new Date()
  const records = loadNewsRecords()
  const news = summarizeNewsDelta(records, previous)
  const fuse = readSystemFuse()
  const proRiskPolicy = readProRiskPolicy(DEFAULT_PRO_RISK_POLICY_PATH)
  const fuseRiskOff = fuse.status === 'risk_off'
  const decision = shouldCallLlm({ context: previous, news, nowMs: now.getTime() })
  let llm: MarketIntelLlmOutput | null = null
  let model = 'local'
  let modelLane = 'local'
  const reasons = [...news.reasons]

  if (fuseRiskOff) reasons.push(`system_fuse:${fuse.reason ?? 'risk_off'}`)

  if (decision.lane) {
    const result = await runLlm({
      lane: decision.lane,
      trigger: decision.trigger === 'event' ? 'event' : 'ttl',
      context: previous,
      news,
    })
    llm = result.output
    model = result.model
    modelLane = result.modelLane
    if (result.error) reasons.push(`llm_error:${result.error.slice(0, 120)}`)
    if (result.superseded) reasons.push('llm_superseded')
  } else {
    reasons.push(decision.reason)
  }

  previous = readMarketIntelContext(DEFAULT_MARKET_INTEL_CONTEXT_PATH)
  const next = buildLocalContext({
    previous,
    news,
    fuseRiskOff,
    proRiskPolicy,
    now,
    llm: llm ?? undefined,
    trigger: decision.trigger,
    modelLane,
    model,
    reasons,
  })
  writeMarketIntelContext(next, {
    path: DEFAULT_MARKET_INTEL_CONTEXT_PATH,
    expectedGeneration: previous.contextGeneration,
  })
  await saveLatestReport(next)
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    dryRun: parseBoolArg(raw.get('dryRun'), true),
  }
}

function buildLlmPrompt(context: MarketIntelContext, news: NewsDeltaSummary): string {
  const headlines = news.records.slice(-8).map(record => ({
    title: record.title,
    source: record.metadata.source,
    collectorRoundId: record.metadata.collectorRoundId,
    feedBatchId: record.metadata.feedBatchId,
  }))
  return `You are a conservative crypto paper-trading market-intelligence governor.
You do not place orders. You only decide whether local paper strategy lanes may open new positions.

Current effective context:
${JSON.stringify({
  riskMode: context.riskMode,
  newsRiskRegime: context.newsRiskRegime,
  coldStartRoundsRemaining: context.coldStartRoundsRemaining,
  sourceEpoch: context.sourceEpoch,
}, null, 2)}

Recent compressed news features:
${JSON.stringify(headlines, null, 2)}

Rules:
- Be more conservative for microstructure_10x and microstructure_100x.
- Use confidenceLow below the point estimate when uncertain.
- If security incidents, exchange outages, sanctions, insolvency, or severe hacks appear, set risk_off or ban affected symbols.
- Never increase exposure above 1.`
}

function hasSevereKeyword(text: string): boolean {
  return [
    /\bhack(ed|er|ing)?\b/i,
    /\bexploit(ed)?\b/i,
    /\bbreach\b/i,
    /\binsolvenc(y|ies)\b/i,
    /\bhalt(ed|s)?\b/i,
    /\boutage\b/i,
    /\bsanction(s|ed)?\b/i,
    /\bsec lawsuit\b/i,
  ].some(pattern => pattern.test(text))
}

function inferBannedSymbols(records: NewsRecord[]): string[] {
  const symbols = new Set<string>()
  const patterns: Array<[string, RegExp]> = [
    ['BTC', /\b(bitcoin|btc)\b/i],
    ['ETH', /\b(ethereum|eth)\b/i],
    ['SOL', /\b(solana|sol)\b/i],
    ['BNB', /\b(bnb|binance)\b/i],
    ['XRP', /\b(xrp|ripple)\b/i],
    ['DOGE', /\b(doge|dogecoin)\b/i],
    ['ADA', /\b(ada|cardano)\b/i],
  ]
  for (const record of records) {
    const text = `${record.title} ${record.content}`
    for (const [symbol, pattern] of patterns) {
      if (pattern.test(text)) symbols.add(symbol)
    }
  }
  return [...symbols]
}

function validateSemantic(input: {
  riskMode: MarketIntelContext['riskMode']
  allowNewPositionsByLane: Record<string, boolean>
}): MarketIntelContext['semanticValidation'] {
  const violations: MarketIntelContext['semanticValidation']['violations'] = []
  if (input.riskMode === 'risk_off') {
    for (const [lane, allow] of Object.entries(input.allowNewPositionsByLane)) {
      if (allow) {
        violations.push({
          rule: 'risk_off_but_allow_open',
          field: `allowNewPositionsByLane.${lane}`,
          action: 'block',
        })
      }
    }
  }
  return { passed: violations.length === 0, violations }
}

function logFlashCall(event: Record<string, unknown>): void {
  const day = new Date().toISOString().slice(0, 10)
  appendJsonlSync(join(FLASH_CALL_LOG_DIR, `flash_calls_${day}.jsonl`), {
    ts: new Date().toISOString(),
    ...event,
  })
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const withoutPrefix = token.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(withoutPrefix, next)
      index += 1
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${raw}`)
}

async function saveLatestReport(context: MarketIntelContext): Promise<void> {
  const path = 'data/runtime/market_intel_context.refresh.latest.json'
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(context, null, 2)}\n`, 'utf-8')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export {
  parseArgs,
}
