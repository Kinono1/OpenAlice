import { AccountManager, createSnapshotService, type SnapshotService } from '../domain/trading/index.js'
import type { CryptoClientLike } from '../domain/market-data/client/types.js'
import type { AccountConfig, Config } from '../core/config.js'
import { readAccountsConfig } from '../core/config.js'
import type { EventLog } from '../core/event-log.js'
import type { ToolCenter } from '../core/tool-center.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'
import { resolveCryptoExecutionConfig } from '../domain/trading/brokers/ccxt/CcxtTradingEngineAdapter.js'
import {
  createCcxtSidecarWriteComponentsFactory,
  resolveExecutionSidecarEnvironmentConfig,
} from './execution-sidecar.js'

export interface ExecutionAssembly {
  accountManager: AccountManager
  snapshotService: SnapshotService
}

export function requiredExecutionSidecarAccountIds(
  accountConfigs: readonly AccountConfig[],
  runtime: Pick<RuntimePaths, 'capabilities'>,
): Set<string> {
  if (!runtime.capabilities.orderSubmissionPathEnabled) return new Set()
  return new Set(accountConfigs
    .filter(account => (
      account.enabled !== false
      && account.type === 'ccxt'
      && resolveCryptoExecutionConfig(account.cryptoExecution).enableCryptoDispatcher
    ))
    .map(account => account.id))
}

export async function assembleExecution(input: {
  config: Config
  runtime: RuntimePaths
  eventLog: EventLog
  toolCenter: ToolCenter
  cryptoClient: CryptoClientLike
}): Promise<ExecutionAssembly> {
  const { config, runtime, eventLog, toolCenter, cryptoClient } = input
  const accountConfigs = runtime.capabilities.initializesAccounts
    ? await readAccountsConfig()
    : []
  const sidecarRequiredAccountIds = requiredExecutionSidecarAccountIds(accountConfigs, runtime)
  const createCcxtSidecarWriteComponents = sidecarRequiredAccountIds.size > 0
    ? createCcxtSidecarWriteComponentsFactory(
        resolveExecutionSidecarEnvironmentConfig(),
      )
    : undefined
  const accountManager = new AccountManager({
    eventLog,
    toolCenter,
    cryptoClient,
    createCcxtSidecarWriteComponents,
  })
  accountManager.setStrategyConfig(config.strategy)

  const accountInit = await accountManager.initConfiguredAccounts(accountConfigs)
  if (accountInit.failed.some(failure => sidecarRequiredAccountIds.has(failure.id))) {
    await accountManager.closeAll()
    throw new Error('SECURITY: required execution sidecar account initialization failed')
  }
  for (const failure of accountInit.failed) {
    console.error(`account init failed: ${failure.id}: ${failure.error}`)
  }
  if (runtime.capabilities.orderSubmissionPathEnabled) {
    accountManager.registerCcxtToolsIfNeeded()
  }

  const snapshotService = createSnapshotService({ accountManager, eventLog })
  accountManager.setSnapshotHooks({
    onPostPush: (id) => { snapshotService.takeSnapshot(id, 'post-push') },
    onPostReject: (id) => { snapshotService.takeSnapshot(id, 'post-reject') },
  })
  return { accountManager, snapshotService }
}
