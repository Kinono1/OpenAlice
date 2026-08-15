/**
 * AccountManager — UTA lifecycle management, registry, and aggregation.
 *
 * Owns the full account lifecycle: create → register → reconnect → remove → close.
 * Also provides cross-account operations (aggregated equity, contract search).
 */

import type { Contract, ContractDescription, ContractDetails } from '@traderalice/ibkr'
import type { AccountCapabilities, BrokerHealth, BrokerHealthInfo } from './brokers/types.js'
import { CcxtBroker } from './brokers/ccxt/CcxtBroker.js'
import type {
  CcxtBrokerWriteAssembly,
  CcxtExecutionBridge,
  CcxtExecutionRuntime,
  CryptoExecutionConfig,
} from './brokers/ccxt/CcxtTradingEngineAdapter.js'
import {
  createCcxtExecutionBridge,
  resolveCryptoExecutionConfig,
} from './brokers/ccxt/CcxtTradingEngineAdapter.js'
import { createCcxtProviderTools } from './brokers/ccxt/ccxt-tools.js'
import { createBroker } from './brokers/factory.js'
import { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import { loadGitState, createGitPersister } from './git-persistence.js'
import { readAccountsConfig, type AccountConfig, type StrategyConfig } from '../../core/config.js'
import type { EventLog } from '../../core/event-log.js'
import type { ToolCenter } from '../../core/tool-center.js'
import type { ReconnectResult } from '../../core/types.js'
import type { CryptoClientLike } from '../market-data/client/types.js'
import {
  createEnvironmentExecutionAuthorityProvider,
  type ExecutionAuthorityProvider,
} from './execution-permit.js'
import './contract-ext.js'

// ==================== Account summary ====================

export interface AccountSummary {
  id: string
  label: string
  capabilities: AccountCapabilities
  health: BrokerHealthInfo
}

// ==================== Aggregated equity ====================

export interface AggregatedEquity {
  totalEquity: number
  totalCash: number
  totalUnrealizedPnL: number
  totalRealizedPnL: number
  accounts: Array<{
    id: string
    label: string
    equity: number
    cash: number
    unrealizedPnL: number
    health: BrokerHealth
  }>
}

// ==================== Contract search result ====================

export interface ContractSearchResult {
  accountId: string
  results: ContractDescription[]
}

export interface AccountInitSummary {
  initialized: string[]
  failed: Array<{ id: string; error: string }>
}

// ==================== AccountManager ====================

export interface SnapshotHooks {
  onPostPush?: (accountId: string) => void | Promise<void>
  onPostReject?: (accountId: string) => void | Promise<void>
}

export type CcxtSidecarWriteComponents = Omit<
  Extract<CcxtBrokerWriteAssembly, { route: 'sidecar' }>,
  'route' | 'executionAuthorityProvider'
>

export interface CreateCcxtSidecarWriteComponentsInput {
  accountId: string
  broker: CcxtBroker
  config: CryptoExecutionConfig
  authorityProvider: ExecutionAuthorityProvider
}

export type CreateCcxtSidecarWriteComponents = (
  input: CreateCcxtSidecarWriteComponentsInput,
) => Promise<CcxtSidecarWriteComponents>

export async function assembleCcxtSidecarBrokerWriteRoute(input: {
  accountId: string
  broker: CcxtBroker
  config: CryptoExecutionConfig
  createComponents?: CreateCcxtSidecarWriteComponents
}): Promise<CcxtBrokerWriteAssembly | undefined> {
  if (!input.config.enableCryptoDispatcher || !input.createComponents) return undefined
  if (
    input.config.mode !== 'paper_only'
    || input.broker.meta.exchange !== 'okx'
    || !input.broker.isPaperEnvironment()
  ) {
    throw new Error('SECURITY: execution sidecar MVP requires an OKX paper broker target')
  }
  const authorityProvider = createEnvironmentExecutionAuthorityProvider({
    admissionDecisionPath: input.config.admissionDecisionPath,
  })
  const components = await input.createComponents({
    accountId: input.accountId,
    broker: input.broker,
    config: input.config,
    authorityProvider,
  })
  return {
    ...components,
    route: 'sidecar',
    executionAuthorityProvider: authorityProvider,
  }
}

export class AccountManager {
  private entries = new Map<string, UnifiedTradingAccount>()
  private reconnecting = new Set<string>()
  private initLocks = new Map<string, Promise<UnifiedTradingAccount>>()
  private ccxtExecutionRuntime = new Map<string, CcxtExecutionRuntime>()
  private strategyConfig?: StrategyConfig
  private cryptoClient?: CryptoClientLike
  private createCcxtSidecarWriteComponents?: CreateCcxtSidecarWriteComponents

  private eventLog?: EventLog
  private toolCenter?: ToolCenter
  private _snapshotHooks?: SnapshotHooks

  constructor(deps?: {
    eventLog: EventLog
    toolCenter: ToolCenter
    cryptoClient?: CryptoClientLike
    createCcxtSidecarWriteComponents?: CreateCcxtSidecarWriteComponents
  }) {
    this.eventLog = deps?.eventLog
    this.toolCenter = deps?.toolCenter
    this.cryptoClient = deps?.cryptoClient
    this.createCcxtSidecarWriteComponents = deps?.createCcxtSidecarWriteComponents
  }

  setSnapshotHooks(hooks: SnapshotHooks): void {
    this._snapshotHooks = hooks
  }

  setStrategyConfig(config: StrategyConfig): void {
    this.strategyConfig = config
  }

  setCryptoClient(client: CryptoClientLike): void {
    this.cryptoClient = client
  }

  // ==================== Lifecycle ====================

  /** Create a UTA from account config, register it, and start async broker connection. */
  async initAccount(accCfg: AccountConfig): Promise<UnifiedTradingAccount> {
    const inFlight = this.initLocks.get(accCfg.id)
    if (inFlight) {
      return inFlight
    }

    const promise = this.initAccountUnlocked(accCfg)
    this.initLocks.set(accCfg.id, promise)
    try {
      return await promise
    } finally {
      if (this.initLocks.get(accCfg.id) === promise) {
        this.initLocks.delete(accCfg.id)
      }
    }
  }

  private async initAccountUnlocked(accCfg: AccountConfig): Promise<UnifiedTradingAccount> {
    const broker = createBroker(accCfg)
    const savedState = await loadGitState(accCfg.id)
    let ccxtExecutionBridge: CcxtExecutionBridge | undefined
    let brokerWriteAssembly: CcxtBrokerWriteAssembly | undefined
    if (broker instanceof CcxtBroker) {
      const cryptoExecution = resolveCryptoExecutionConfig(accCfg.cryptoExecution)
      brokerWriteAssembly = await assembleCcxtSidecarBrokerWriteRoute({
        accountId: accCfg.id,
        broker,
        config: cryptoExecution,
        createComponents: this.createCcxtSidecarWriteComponents,
      })
      try {
        ccxtExecutionBridge = await createCcxtExecutionBridge({
          accountId: accCfg.id,
          broker,
          accountManager: this,
          cryptoClient: this.cryptoClient,
          eventLog: this.eventLog,
          cryptoExecution,
          strategyConfig: this.strategyConfig,
          brokerWriteAssembly,
        })
      } catch (error) {
        if (brokerWriteAssembly?.route === 'sidecar') {
          await brokerWriteAssembly.close?.()
        }
        throw error
      }
    }
    let uta: UnifiedTradingAccount
    try {
      uta = new UnifiedTradingAccount(broker, {
        guards: accCfg.guards,
        savedState,
        onCommit: createGitPersister(accCfg.id),
        onHealthChange: (accountId, health) => {
          this.eventLog?.append('account.health', { accountId, ...health })
        },
        onPostPush: this._snapshotHooks?.onPostPush,
        onPostReject: this._snapshotHooks?.onPostReject,
        buildExecuteOperation: ccxtExecutionBridge?.wrapExecuteOperation,
        onClose: ccxtExecutionBridge?.close,
      })
    } catch (error) {
      await ccxtExecutionBridge?.close()
      throw error
    }
    try {
      this.add(uta)
    } catch (error) {
      await uta.close().catch(() => undefined)
      throw error
    }
    if (ccxtExecutionBridge) {
      this.ccxtExecutionRuntime.set(accCfg.id, ccxtExecutionBridge.runtime())
    } else {
      this.ccxtExecutionRuntime.delete(accCfg.id)
    }
    return uta
  }

  async initConfiguredAccounts(accountConfigs: AccountConfig[]): Promise<AccountInitSummary> {
    const summary: AccountInitSummary = { initialized: [], failed: [] }

    for (const accCfg of accountConfigs) {
      if (accCfg.enabled === false) {
        continue
      }
      try {
        await this.initAccount(accCfg)
        summary.initialized.push(accCfg.id)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        summary.failed.push({ id: accCfg.id, error })
        try {
          await this.eventLog?.append('account.init_failed', { accountId: accCfg.id, error })
        } catch {
          // Keep account isolation even if diagnostics cannot be persisted.
        }
      }
    }

    return summary
  }

  /** Reconnect an account: close old → re-read config → create new → verify connection. */
  async reconnectAccount(accountId: string): Promise<ReconnectResult> {
    if (this.reconnecting.has(accountId)) {
      return { success: false, error: 'Reconnect already in progress' }
    }
    this.reconnecting.add(accountId)
    try {
      // Re-read config to pick up credential/guard changes
      const freshAccounts = await readAccountsConfig()

      // Close old account
      await this.removeAccount(accountId)

      const accCfg = freshAccounts.find((a) => a.id === accountId)
      if (!accCfg || accCfg.enabled === false) {
        return { success: true, message: `Account "${accountId}" not found in config (removed or disabled)` }
      }

      const uta = await this.initAccount(accCfg)

      // Wait for broker.init() + broker.getAccount() to verify the connection
      await uta.waitForConnect()

      // Re-register CCXT-specific tools if this is a CCXT account
      if (accCfg.type === 'ccxt') {
        this.toolCenter?.register(
          createCcxtProviderTools(this),
          'trading-ccxt',
        )
      }

      const label = uta.label ?? accountId
      console.log(`reconnect: ${label} online`)
      return { success: true, message: `${label} reconnected` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`reconnect: ${accountId} failed:`, msg)
      return { success: false, error: msg }
    } finally {
      this.reconnecting.delete(accountId)
    }
  }

  /** Close and deregister an account. No-op if account doesn't exist. */
  async removeAccount(accountId: string): Promise<void> {
    const uta = this.entries.get(accountId)
    if (!uta) return
    this.entries.delete(accountId)
    this.ccxtExecutionRuntime.delete(accountId)
    try { await uta.close() } catch { /* best effort */ }
  }

  /** Register CCXT provider tools if any CCXT accounts are present. */
  registerCcxtToolsIfNeeded(): void {
    const hasCcxt = this.resolve().some((uta) => uta.broker instanceof CcxtBroker)
    if (hasCcxt) {
      this.toolCenter?.register(createCcxtProviderTools(this), 'trading-ccxt')
      console.log('ccxt: provider tools registered')
    }
  }

  // ==================== Registration ====================

  add(uta: UnifiedTradingAccount): void {
    if (this.entries.has(uta.id)) {
      throw new Error(`Account "${uta.id}" already registered`)
    }
    this.entries.set(uta.id, uta)
  }

  remove(id: string): void {
    this.entries.delete(id)
  }

  // ==================== Lookups ====================

  get(id: string): UnifiedTradingAccount | undefined {
    return this.entries.get(id)
  }

  listAccounts(): AccountSummary[] {
    return Array.from(this.entries.values()).map((uta) => ({
      id: uta.id,
      label: uta.label,
      capabilities: uta.getCapabilities(),
      health: uta.getHealthInfo(),
    }))
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  get size(): number {
    return this.entries.size
  }

  getExecutionRuntime(accountId: string): CcxtExecutionRuntime | undefined {
    return this.ccxtExecutionRuntime.get(accountId)
  }

  listExecutionRuntime(): Record<string, CcxtExecutionRuntime> {
    return Object.fromEntries(this.ccxtExecutionRuntime.entries())
  }

  // ==================== Source routing ====================

  resolve(source?: string): UnifiedTradingAccount[] {
    if (!source) {
      return Array.from(this.entries.values())
    }
    const byId = this.entries.get(source)
    if (byId) return [byId]
    return []
  }

  resolveOne(source: string): UnifiedTradingAccount {
    const results = this.resolve(source)
    if (results.length === 0) {
      throw new Error(`No account found matching source "${source}". Use listAccounts to see available accounts.`)
    }
    if (results.length > 1) {
      throw new Error(
        `Multiple accounts match source "${source}": ${results.map((r) => r.id).join(', ')}. Use account id for exact match.`,
      )
    }
    return results[0]
  }

  // ==================== Cross-account aggregation ====================

  async getAggregatedEquity(): Promise<AggregatedEquity> {
    const results = await Promise.all(
      Array.from(this.entries.values()).map(async (uta) => {
        if (uta.health !== 'healthy') {
          uta.nudgeRecovery()
          return { id: uta.id, label: uta.label, health: uta.health, info: null }
        }
        try {
          const info = await uta.getAccount()
          return { id: uta.id, label: uta.label, health: uta.health, info }
        } catch {
          return { id: uta.id, label: uta.label, health: uta.health, info: null }
        }
      }),
    )

    let totalEquity = 0
    let totalCash = 0
    let totalUnrealizedPnL = 0
    let totalRealizedPnL = 0
    const accounts: AggregatedEquity['accounts'] = []

    for (const { id, label, health, info } of results) {
      if (info) {
        totalEquity += info.netLiquidation
        totalCash += info.totalCashValue
        totalUnrealizedPnL += info.unrealizedPnL
        totalRealizedPnL += info.realizedPnL ?? 0
      }
      accounts.push({
        id,
        label,
        equity: info?.netLiquidation ?? 0,
        cash: info?.totalCashValue ?? 0,
        unrealizedPnL: info?.unrealizedPnL ?? 0,
        health,
      })
    }

    return { totalEquity, totalCash, totalUnrealizedPnL, totalRealizedPnL, accounts }
  }

  // ==================== Cross-account contract search ====================

  async searchContracts(
    pattern: string,
    accountId?: string,
  ): Promise<ContractSearchResult[]> {
    const targets = accountId
      ? [this.entries.get(accountId)].filter(Boolean) as UnifiedTradingAccount[]
      : Array.from(this.entries.values())

    const results = await Promise.all(
      targets.map(async (uta) => {
        if (uta.health !== 'healthy') {
          uta.nudgeRecovery()
          return { accountId: uta.id, results: [] as ContractDescription[] }
        }
        try {
          const descriptions = await uta.searchContracts(pattern)
          return { accountId: uta.id, results: descriptions }
        } catch {
          return { accountId: uta.id, results: [] as ContractDescription[] }
        }
      }),
    )

    return results.filter((r) => r.results.length > 0)
  }

  async getContractDetails(
    query: Contract,
    accountId: string,
  ): Promise<ContractDetails | null> {
    const uta = this.entries.get(accountId)
    if (!uta) return null
    return uta.getContractDetails(query)
  }

  // ==================== Cleanup ====================

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.entries.values()).map((uta) => uta.close()),
    )
    this.entries.clear()
    this.ccxtExecutionRuntime.clear()
  }
}
