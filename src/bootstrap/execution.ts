import { AccountManager, createSnapshotService, type SnapshotService } from '../domain/trading/index.js'
import type { CryptoClientLike } from '../domain/market-data/client/types.js'
import type { Config } from '../core/config.js'
import { readAccountsConfig } from '../core/config.js'
import type { EventLog } from '../core/event-log.js'
import type { ToolCenter } from '../core/tool-center.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'

export interface ExecutionAssembly {
  accountManager: AccountManager
  snapshotService: SnapshotService
}

export async function assembleExecution(input: {
  config: Config
  runtime: RuntimePaths
  eventLog: EventLog
  toolCenter: ToolCenter
  cryptoClient: CryptoClientLike
}): Promise<ExecutionAssembly> {
  const { config, runtime, eventLog, toolCenter, cryptoClient } = input
  const accountManager = new AccountManager({ eventLog, toolCenter, cryptoClient })
  accountManager.setStrategyConfig(config.strategy)

  const accountConfigs = runtime.capabilities.initializesAccounts
    ? await readAccountsConfig()
    : []
  const accountInit = await accountManager.initConfiguredAccounts(accountConfigs)
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
