import type { Config } from '../core/config.js'
import type { ToolCenter } from '../core/tool-center.js'
import type { Brain } from '../domain/brain/index.js'
import type { AccountManager } from '../domain/trading/index.js'
import type {
  CryptoClientLike,
  CurrencyClientLike,
  EquityClientLike,
} from '../domain/market-data/client/types.js'
import type { SymbolIndex } from '../domain/market-data/equity/index.js'
import type { CronEngine } from '../task/cron/index.js'
import type { NewsCollectorStore } from '../domain/news/index.js'
import { createThinkingTools } from '../tool/thinking.js'
import { createTradingTools } from '../tool/trading.js'
import { createBrainTools } from '../tool/brain.js'
import { createBrowserTools } from '../tool/browser.js'
import { createCronTools } from '../task/cron/index.js'
import { createMarketSearchTools } from '../tool/market.js'
import { createEquityTools } from '../tool/equity.js'
import { createNewsArchiveTools } from '../tool/news.js'
import { createAnalysisTools } from '../tool/analysis.js'
import { createStrategyTools } from '../tool/strategy.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'

export function registerApplicationTools(input: {
  config: Config
  runtime: RuntimePaths
  toolCenter: ToolCenter
  brain: Brain
  accountManager: AccountManager
  cronEngine: CronEngine
  symbolIndex: SymbolIndex
  equityClient: EquityClientLike
  cryptoClient: CryptoClientLike
  currencyClient: CurrencyClientLike
  newsStore: NewsCollectorStore
}): void {
  const {
    config,
    runtime,
    toolCenter,
    brain,
    accountManager,
    cronEngine,
    symbolIndex,
    equityClient,
    cryptoClient,
    currencyClient,
    newsStore,
  } = input

  toolCenter.register(createThinkingTools(), 'thinking')
  toolCenter.register(createBrainTools(brain), 'brain')
  toolCenter.register(createMarketSearchTools(symbolIndex, cryptoClient, currencyClient), 'market-search')
  toolCenter.register(createEquityTools(equityClient), 'equity')
  toolCenter.register(createAnalysisTools(equityClient, cryptoClient, currencyClient), 'analysis')
  if (config.news.enabled) {
    toolCenter.register(createNewsArchiveTools(newsStore), 'news')
  }

  if (runtime.role === 'primary') {
    toolCenter.register(createTradingTools(accountManager), 'trading')
    toolCenter.register(createBrowserTools(), 'browser')
    toolCenter.register(createCronTools(cronEngine), 'cron')
    toolCenter.register(createStrategyTools(accountManager, cryptoClient), 'strategy')
  }
  console.log(
    `tool-center: ${toolCenter.list().length} tools registered (role=${runtime.role})`,
  )
}
