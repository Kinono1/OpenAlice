import { join } from 'node:path'
import type { Config } from '../core/config.js'
import {
  buildRouteMap,
  getSDKExecutor,
  SDKCryptoClient,
  SDKCurrencyClient,
  SDKEquityClient,
} from '../domain/market-data/client/typebb/index.js'
import type {
  CryptoClientLike,
  CurrencyClientLike,
  EquityClientLike,
} from '../domain/market-data/client/types.js'
import { buildSDKCredentials } from '../domain/market-data/credential-map.js'
import { OpenBBEquityClient } from '../domain/market-data/client/openbb-api/equity-client.js'
import { OpenBBCryptoClient } from '../domain/market-data/client/openbb-api/crypto-client.js'
import { OpenBBCurrencyClient } from '../domain/market-data/client/openbb-api/currency-client.js'
import { SymbolIndex } from '../domain/market-data/equity/index.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'

export interface MarketDataAssembly {
  equityClient: EquityClientLike
  cryptoClient: CryptoClientLike
  currencyClient: CurrencyClientLike
  symbolIndex: SymbolIndex
}

export async function assembleMarketData(
  config: Config,
  runtime: RuntimePaths,
): Promise<MarketDataAssembly> {
  const { providers } = config.marketData
  let equityClient: EquityClientLike
  let cryptoClient: CryptoClientLike
  let currencyClient: CurrencyClientLike

  if (config.marketData.backend === 'openbb-api') {
    const url = config.marketData.apiUrl
    const keys = config.marketData.providerKeys
    equityClient = new OpenBBEquityClient(url, providers.equity, keys)
    cryptoClient = new OpenBBCryptoClient(url, providers.crypto, keys)
    currencyClient = new OpenBBCurrencyClient(url, providers.currency, keys)
  } else {
    const executor = getSDKExecutor()
    const routeMap = buildRouteMap()
    const credentials = buildSDKCredentials(config.marketData.providerKeys)
    equityClient = new SDKEquityClient(executor, 'equity', providers.equity, credentials, routeMap)
    cryptoClient = new SDKCryptoClient(executor, 'crypto', providers.crypto, credentials, routeMap)
    currencyClient = new SDKCurrencyClient(executor, 'currency', providers.currency, credentials, routeMap)
  }

  const symbolIndex = new SymbolIndex({
    cacheFile: join(runtime.sharedDataInputDir, 'cache', 'equity', 'symbols.json'),
    allowNetwork: runtime.role === 'primary',
    writeCache: runtime.role === 'primary',
  })
  await symbolIndex.load(equityClient)
  return { equityClient, cryptoClient, currencyClient, symbolIndex }
}
