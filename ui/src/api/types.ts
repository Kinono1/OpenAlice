// ==================== Channels ====================

export interface VercelAiSdkOverride {
  provider: string
  model: string
  baseUrl?: string
  apiKey?: string
}

export type LoginMethod = 'api-key' | 'claudeai'

export interface AgentSdkOverride {
  model?: string
  baseUrl?: string
  apiKey?: string
  loginMethod?: LoginMethod
}

export interface WebChannel {
  id: string
  label: string
  systemPrompt?: string
  provider?: 'claude-code' | 'vercel-ai-sdk' | 'agent-sdk'
  vercelAiSdk?: VercelAiSdkOverride
  agentSdk?: AgentSdkOverride
  disabledTools?: string[]
}

// ==================== Chat ====================

export interface ChatMessage {
  role: 'user' | 'assistant' | 'notification'
  text: string
  timestamp?: string | null
}

export interface ChatResponse {
  text: string
  media: Array<{ type: 'image'; url: string }>
}

export interface ToolCall {
  name: string
  input: string
  result?: string
}

export interface StreamingToolCall {
  id: string
  name: string
  input: unknown
  status: 'running' | 'done'
  result?: string
}

export type ChatHistoryItem =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string; timestamp?: string; metadata?: Record<string, unknown>; media?: Array<{ type: string; url: string }> }
  | { kind: 'tool_calls'; calls: ToolCall[]; timestamp?: string }

// ==================== Config ====================

export interface AIProviderConfig {
  backend: string
  provider: string
  model: string
  baseUrl?: string
  loginMethod?: LoginMethod
  apiKeys: { anthropic?: string; openai?: string; google?: string }
}

export interface AppConfig {
  aiProvider: AIProviderConfig
  engine: Record<string, unknown>
  agent: { evolutionMode: boolean; claudeCode: Record<string, unknown> }
  compaction: { maxContextTokens: number; maxOutputTokens: number }
  strategy?: StrategyConfig
  heartbeat: {
    enabled: boolean
    every: string
    prompt: string
    activeHours: { start: string; end: string; timezone: string } | null
  }
  snapshot: {
    enabled: boolean
    every: string
  }
  connectors: ConnectorsConfig
  [key: string]: unknown
}

export interface ConnectorsConfig {
  web: { port: number }
  mcp: { port: number }
  mcpAsk: { enabled: boolean; port?: number }
  telegram: {
    enabled: boolean
    botToken?: string
    botUsername?: string
    chatIds: number[]
  }
}

// ==================== News Collector ====================

export interface NewsCollectorFeed {
  name: string
  url: string
  source: string
  categories?: string[]
}

export interface NewsCollectorConfig {
  enabled: boolean
  intervalMinutes: number
  maxInMemory: number
  retentionDays: number
  feeds: NewsCollectorFeed[]
}

// ==================== Events ====================

export interface EventLogEntry {
  seq: number
  ts: number
  type: string
  payload: unknown
}

// ==================== Cron ====================

export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; every: string }
  | { kind: 'cron'; cron: string }

export interface CronJobState {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: 'ok' | 'error' | null
  consecutiveErrors: number
}

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  schedule: CronSchedule
  payload: string
  state: CronJobState
  createdAt: number
}

// ==================== Trading ====================

export type BrokerHealth = 'healthy' | 'degraded' | 'offline'

export interface BrokerHealthInfo {
  status: BrokerHealth
  consecutiveFailures: number
  lastError?: string
  lastSuccessAt?: string
  lastFailureAt?: string
  recovering: boolean
  disabled: boolean
}

export interface AccountSummary {
  id: string
  label: string
  capabilities: { supportedSecTypes: string[]; supportedOrderTypes: string[] }
  health: BrokerHealthInfo
}

export interface TradingAccount {
  id: string
  provider: string
  label: string
}

export interface AccountInfo {
  netLiquidation: number
  totalCashValue: number
  unrealizedPnL: number
  realizedPnL: number
  buyingPower?: number
  initMarginReq?: number
  maintMarginReq?: number
}

export interface Position {
  contract: {
    aliceId?: string
    symbol?: string
    secType?: string
    exchange?: string
    currency?: string
    lastTradeDateOrContractMonth?: string
    strike?: number
    right?: string
    multiplier?: number
    localSymbol?: string
  }
  side: 'long' | 'short'
  quantity: string // Decimal serialized as string
  avgCost: number
  marketPrice: number
  marketValue: number
  unrealizedPnL: number
  realizedPnL: number
}

export interface WalletCommitLog {
  hash: string
  message: string
  operations: Array<{ symbol: string; action: string; change: string; status: string }>
  timestamp: string
  round?: number
}

export interface ReconnectResult {
  success: boolean
  error?: string
  message?: string
}

export type CryptoExecutionMode = 'paper_only'
export type KillSwitchDefaultPolicy = 'block_new_only' | 'block_all'

export interface CryptoExecutionConfig {
  mode: CryptoExecutionMode
  enableCryptoDispatcher: boolean
  requireDecisionTicket: boolean
  ticketTtlMs: number
  idempotencyTtlMs: number
  killSwitchDefaultPolicy: KillSwitchDefaultPolicy
}

export interface CryptoExecutionRuntime {
  enabled: boolean
  mode: CryptoExecutionMode
  requireDecisionTicket: boolean
  ticketTtlMs: number
  idempotencyTtlMs: number
  killSwitchDefaultPolicy: KillSwitchDefaultPolicy
  exchangeId: string
  bridgeActive: boolean
  intentLedgerPath: string
  idempotencyStorePath: string
}

export interface ProcessHealthSummary {
  status: 'ok'
  uptime: number
}

export interface WebReadinessSummary {
  status: 'ready' | 'not-ready'
  ready: boolean
  checks: Record<string, { ok: boolean; detail?: string }>
}

export interface SignalReadinessSummary {
  status: 'ready' | 'not-ready'
  ready: boolean
  mode: 'paper_only'
  authEnforced: boolean
  authConfigured: boolean
  supportedSymbols: string[]
  tradingReady: boolean
  reasons: string[]
}

export interface TradingRuntimeAccount {
  id: string
  label: string
  type: string
  enabled: boolean
  health?: BrokerHealthInfo
  cryptoExecution?: CryptoExecutionConfig
  cryptoExecutionRuntime?: CryptoExecutionRuntime
}

export interface TradingRuntimeSummary {
  process: ProcessHealthSummary
  webReadiness: WebReadinessSummary
  signalReadiness: SignalReadinessSummary
  accounts: TradingRuntimeAccount[]
}

export interface StrategyMacroEvent {
  name: string
  releaseTimeUtc: number
  severity: 'high' | 'medium' | 'low'
  marketScope: Array<'crypto' | 'a-share'>
  freezeRule: {
    preFreezeHours: number
    postFreezeHours: number
    maxActionDuringFreeze: 'reduce' | 'exit' | 'no-trade' | 'hold'
  }
}

export interface StrategyConfig {
  enabled: boolean
  governance: {
    useGovernanceGate: boolean
    staleDataCapsExecution: boolean
    preferReduceOnWeakSignal: boolean
  }
  runtime: {
    marketScope: 'crypto' | 'a-share'
    runtimeIntegrationEnabled: boolean
  }
  eventCalendar: {
    enabled: boolean
    events: StrategyMacroEvent[]
  }
  factors: {
    fundingRate: { enabled: boolean; weight: number }
    basis: { enabled: boolean; weight: number }
    volumeSurge: { enabled: boolean; weight: number }
    momentumComposite: { enabled: boolean; weight: number }
  }
  positionSizing: {
    enabled: boolean
    method: 'fixed' | 'kelly' | 'volTarget'
    defaultAssetLayer: 'core' | 'extended' | 'watch-only'
    targetVolPct: number
    maxPctOfEquity: number
    kellyFraction: number
    layerConfigs: Array<{
      layer: 'core' | 'extended' | 'watch-only'
      maxPositions: number
      maxPositionPctOfEquity: number
      minActionStatusToTrade: 'attack' | 'attack-lite' | 'probe' | 'hold' | 'reduce' | 'exit' | 'no-trade'
      requiresCoreNotRiskOff: boolean
    }>
  }
}

export interface StrategyRuntimeSummary {
  enabled: boolean
  governance: StrategyConfig['governance']
  runtime: StrategyConfig['runtime']
  eventCalendar: {
    enabled: boolean
    configuredEventCount: number
    active: {
      active: boolean
      marketScope: 'crypto' | 'a-share'
      maxActionDuringFreeze?: 'reduce' | 'exit' | 'no-trade' | 'hold'
      activeWindows: Array<{
        startsAtUtc: number
        endsAtUtc: number
        event: StrategyMacroEvent
      }>
    }
  }
  factors: Array<{
    name: string
    enabled: boolean
    weight: number
  }>
  positionSizing: StrategyConfig['positionSizing']
  readiness: {
    governanceReady: boolean
    factorLayerReady: boolean
    dataIntegrationReady: boolean
    runtimeIntegrationReady: boolean
    notes: string[]
  }
}

export interface StrategyEvaluationSnapshot {
  symbol: string
  factorSignals: Array<{
    name: string
    value: number
    confidence: number
    sourceTier: 'L1' | 'L2' | 'L3' | 'L4' | 'L5'
    decisionStrength: 'D1' | 'D2' | 'D3' | 'D4' | 'D5'
    metadata: Record<string, number>
  }>
  governance: {
    actionStatus: string
    baseActionStatus: string
    cappedByEventWindow: boolean
    breakdown: {
      totalScore: number
      sourceQualityScore: number
      marketStructureScore: number
      eventSafetyScore: number
      sentimentAlignmentScore: number
      executionClarityScore: number
    }
  }
  ensemble: {
    weights: Record<string, number>
    aggregateValue: number
    aggregateConfidence: number
    consensusScore: number
    decisionStrength: string
  }
  freeze: {
    active: boolean
    marketScope: 'crypto' | 'a-share'
    maxActionDuringFreeze?: string
    activeWindows: Array<{
      startsAtUtc: number
      endsAtUtc: number
      event: StrategyMacroEvent
    }>
  }
  derivedMetrics: {
    return1hPct: number
    return6hPct: number
    return24hPct: number
    return7dPct: number
    currentPrice: number
    currentVolume: number
    averageVolume: number
    realizedVolPct: number
    openInterest: number | null
    openInterestValue: number | null
    liquidationCount24h: number | null
    liquidationNotional24h: number | null
  }
  dataProvenance?: {
    candles: {
      source: 'input' | 'market-data' | 'account-broker' | 'public-ccxt' | 'derived' | 'unavailable'
      status: 'resolved' | 'fallback' | 'missing'
      detail?: string
      accountId?: string
      exchangeId?: string
    }
    fundingRate: {
      source: 'input' | 'market-data' | 'account-broker' | 'public-ccxt' | 'derived' | 'unavailable'
      status: 'resolved' | 'fallback' | 'missing'
      detail?: string
      accountId?: string
      exchangeId?: string
    }
    basis: {
      source: 'input' | 'market-data' | 'account-broker' | 'public-ccxt' | 'derived' | 'unavailable'
      status: 'resolved' | 'fallback' | 'missing'
      detail?: string
      accountId?: string
      exchangeId?: string
    }
    openInterest: {
      source: 'input' | 'market-data' | 'account-broker' | 'public-ccxt' | 'derived' | 'unavailable'
      status: 'resolved' | 'fallback' | 'missing'
      detail?: string
      accountId?: string
      exchangeId?: string
    }
    liquidation: {
      source: 'input' | 'market-data' | 'account-broker' | 'public-ccxt' | 'derived' | 'unavailable'
      status: 'resolved' | 'fallback' | 'missing'
      detail?: string
      accountId?: string
      exchangeId?: string
    }
    equity: {
      source: 'input' | 'market-data' | 'account-broker' | 'public-ccxt' | 'derived' | 'unavailable'
      status: 'resolved' | 'fallback' | 'missing'
      detail?: string
      accountId?: string
      exchangeId?: string
    }
    referencePrice: {
      source: 'input' | 'market-data' | 'account-broker' | 'public-ccxt' | 'derived' | 'unavailable'
      status: 'resolved' | 'fallback' | 'missing'
      detail?: string
      accountId?: string
      exchangeId?: string
    }
    completeness: 'full' | 'partial' | 'minimal'
  }
  executionPreview?: {
    mode: 'applied' | 'pass-through' | 'blocked' | 'fallback'
    actionStatus: string
    requestedNotionalUsd: number | null
    recommendedNotionalUsd: number | null
    effectiveSize: number | null
    effectiveUsdSize: number | null
    effectiveNotionalUsd: number | null
    assetLayer: 'core' | 'extended' | 'watch-only'
    fallbackReason?: string
    blockReason?: string
    reasons: string[]
    freeze: {
      active: boolean
      maxActionDuringFreeze?: string
      activeEvents: string[]
    }
  }
  positionSizing: {
    allowed: boolean
    maxPositionPctOfEquity: number
    recommendedPctOfEquity: number
    requestedPctOfEquity: number
    recommendedNotionalUsd: number | null
    assetLayer: 'core' | 'extended' | 'watch-only'
    equity: number | null
    method: 'fixed' | 'kelly' | 'volTarget'
    reasons: string[]
  }
}

// ==================== Wallet Status / Push ====================

export interface WalletOperation {
  action: 'placeOrder' | 'modifyOrder' | 'closePosition' | 'cancelOrder' | 'syncOrders'
  contract?: { aliceId?: string; symbol?: string; localSymbol?: string }
  order?: { action?: string; orderType?: string; totalQuantity?: number | string; cashQty?: number | string; lmtPrice?: number | string; auxPrice?: number | string }
  orderId?: string
  quantity?: string
  [key: string]: unknown
}

export interface WalletStatus {
  staged: WalletOperation[]
  pendingMessage: string | null
  head: string | null
  commitCount: number
}

export interface WalletRejectResult {
  hash: string
  message: string
  operationCount: number
}

export interface WalletPushResult {
  hash: string
  message: string
  operationCount: number
  submitted: Array<{ action: string; success: boolean; orderId?: string; status: string; error?: string }>
  rejected: Array<{ action: string; success: boolean; error?: string; status: string }>
}

// ==================== Tool Call Log ====================

export interface ToolCallRecord {
  seq: number
  id: string
  sessionId: string
  name: string
  input: unknown
  output: string
  status: 'ok' | 'error'
  durationMs: number
  timestamp: number
}

// ==================== Trading Config ====================

export interface AccountConfig {
  id: string
  label?: string
  type: string
  enabled: boolean
  guards: GuardEntry[]
  brokerConfig: Record<string, unknown>
  cryptoExecution?: CryptoExecutionConfig
}

// ==================== Broker Type Metadata (from /broker-types endpoint) ====================

export interface BrokerConfigField {
  name: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select'
  label: string
  placeholder?: string
  default?: unknown
  required?: boolean
  options?: Array<{ value: string; label: string }>
  description?: string
  sensitive?: boolean
}

export interface SubtitleField {
  field: string
  label?: string
  falseLabel?: string
  prefix?: string
}

export interface BrokerTypeInfo {
  type: string
  name: string
  description: string
  badge: string
  badgeColor: string
  fields: BrokerConfigField[]
  subtitleFields: SubtitleField[]
  guardCategory: 'crypto' | 'securities'
}

export interface GuardEntry {
  type: string
  options: Record<string, unknown>
}

export interface TestConnectionResult {
  success: boolean
  error?: string
  account?: unknown
}

// ==================== Snapshots ====================

export interface UTASnapshotSummary {
  accountId: string
  timestamp: string
  trigger: string
  account: {
    netLiquidation: string
    totalCashValue: string
    unrealizedPnL: string
    realizedPnL: string
    buyingPower?: string
    initMarginReq?: string
    maintMarginReq?: string
  }
  positions: Array<{
    aliceId: string
    side: 'long' | 'short'
    quantity: string
    avgCost: string
    marketPrice: string
    marketValue: string
    unrealizedPnL: string
    realizedPnL: string
  }>
  openOrders: Array<{
    orderId: string
    aliceId: string
    action: string
    orderType: string
    totalQuantity: string
    status: string
  }>
  health: string
}

export interface EquityCurvePoint {
  timestamp: string
  equity: string
  accounts: Record<string, string>
}
