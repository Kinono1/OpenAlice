import ccxt from 'ccxt'
import type { Exchange } from 'ccxt'
import { Contract } from '@traderalice/ibkr'
import type { OhlcvData } from '../analysis/indicator/types.js'
import type { CryptoClientLike } from '../market-data/client/types.js'
import type { AccountManager } from '../trading/account-manager.js'
import { CcxtBroker } from '../trading/brokers/ccxt/CcxtBroker.js'
import {
  normalizeOpenInterestPayload,
  summarizeLiquidationRows,
} from '../trading/brokers/ccxt/ccxt-normalizers.js'
import { readStrategyConfig } from '../../core/config.js'
import { buildStrategyExecutionDecision } from './execution.js'
import { evaluateRuntimeFactorSnapshot } from './runtime-evaluator.js'
import {
  createUnavailableStrategyDataProvenance,
  type StrategyDataProvenance,
  type StrategyDataSourceStatus,
  type StrategyExecutionDecision,
} from './runtime-types.js'
import type {
  SentimentCrowding,
  SourceTier,
  UseType,
} from './governance/index.js'

export interface RuntimeStrategySnapshotRequest {
  symbol: string
  interval?: string
  source?: string
  exchangeId?: string
  sourceTier?: SourceTier
  useType?: UseType
  sentiment?: SentimentCrowding
  fundingRatePct?: number
  openInterest?: number
  openInterestValue?: number
  liquidationCount24h?: number
  liquidationNotional24h?: number
  basisInput?: {
    futuresPrice: number
    spotPrice: number
    daysToExpiry?: number
  }
  equity?: number
  assetLayer?: 'core' | 'extended' | 'watch-only'
  winRate?: number
  avgWinLossRatio?: number
  side?: 'buy' | 'sell'
  requestedSize?: number
  requestedUsdSize?: number
  price?: number
  reduceOnly?: boolean
}

export interface RuntimeStrategySnapshotResponse
  extends ReturnType<typeof evaluateRuntimeFactorSnapshot> {
  executionPreview?: StrategyExecutionDecision
}

interface ResolvedDerivativesData {
  fundingRatePct?: number
  openInterest?: number
  openInterestValue?: number
  liquidationCount24h?: number
  liquidationNotional24h?: number
  basisInput?: {
    futuresPrice: number
    spotPrice: number
    daysToExpiry?: number
  }
  dataProvenance: StrategyDataProvenance
}

const publicExchangeCache = new Map<string, Promise<Exchange>>()

function normalizeOhlcv(data: Record<string, unknown>[]): OhlcvData[] {
  return data
    .filter((row) =>
      typeof row.date === 'string'
      && typeof row.open === 'number'
      && typeof row.high === 'number'
      && typeof row.low === 'number'
      && typeof row.close === 'number',
    )
    .map((row) => ({
      date: row.date as string,
      open: row.open as number,
      high: row.high as number,
      low: row.low as number,
      close: row.close as number,
      volume: typeof row.volume === 'number' ? row.volume : null,
    }))
}

function makeSourceStatus(
  source: StrategyDataSourceStatus['source'],
  status: StrategyDataSourceStatus['status'],
  detail: string,
  extra: Partial<StrategyDataSourceStatus> = {},
): StrategyDataSourceStatus {
  return {
    source,
    status,
    detail,
    ...extra,
  }
}

function finalizeProvenance(provenance: StrategyDataProvenance): StrategyDataProvenance {
  const resolvedCount = [
    provenance.candles,
    provenance.fundingRate,
    provenance.basis,
    provenance.openInterest,
    provenance.liquidation,
    provenance.equity,
    provenance.referencePrice,
  ].filter((item) => item.status !== 'missing').length

  return {
    ...provenance,
    completeness:
      resolvedCount >= 6
        ? 'full'
        : resolvedCount >= 3
          ? 'partial'
          : 'minimal',
  }
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value === 'string') {
    const parsedNumber = Number(value)
    if (Number.isFinite(parsedNumber)) {
      return parsedNumber > 1_000_000_000_000 ? parsedNumber : parsedNumber * 1000
    }
    const parsedDate = Date.parse(value)
    return Number.isFinite(parsedDate) ? parsedDate : null
  }
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : null
  }
  return null
}

function resolveCandleTimestampMs(candles: OhlcvData[]): number | null {
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const timestamp = parseTimestampMs(candles[index]?.timestamp ?? candles[index]?.date)
    if (timestamp != null) return timestamp
  }
  return null
}

function inferIntervalMs(interval?: string): number {
  const value = interval ?? '1h'
  const match = /^(\d+)(m|h|d|w)$/i.exec(value.trim())
  if (!match) return 60 * 60_000
  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  const base = unit === 'm'
    ? 60_000
    : unit === 'h'
      ? 60 * 60_000
      : unit === 'd'
        ? 24 * 60 * 60_000
        : 7 * 24 * 60 * 60_000
  return amount * base
}

function detectStaleRuntimeInputs(input: {
  candles: OhlcvData[]
  interval?: string
  nowUtcMs: number
  request: RuntimeStrategySnapshotRequest
}): boolean {
  const candleTimestamp = resolveCandleTimestampMs(input.candles)
  if (candleTimestamp == null) return true
  const expectedIntervalMs = inferIntervalMs(input.interval)
  const candleAgeMs = Math.max(0, input.nowUtcMs - candleTimestamp)
  const candleStale = candleAgeMs > expectedIntervalMs * 2.5
  const derivativesMissing = (
    input.request.fundingRatePct == null
    && input.request.openInterest == null
    && input.request.openInterestValue == null
    && input.request.liquidationCount24h == null
    && input.request.liquidationNotional24h == null
    && input.request.basisInput == null
  )
  return candleStale || derivativesMissing
}
function resolveSingleCcxtTarget(
  manager: AccountManager,
  source?: string,
): { accountId: string; broker: CcxtBroker } | null {
  const targets = manager.resolve(source)
    .filter((uta): uta is typeof uta & { broker: CcxtBroker } => uta.broker instanceof CcxtBroker)
  if (targets.length !== 1) {
    return null
  }
  return {
    accountId: targets[0].id,
    broker: targets[0].broker,
  }
}

function countLayerPositions(
  positions: Array<{ contract: Contract }>,
  symbol: string,
): number {
  return positions.filter((position) => position.contract.symbol === symbol).length
}

function parseExchangeSymbolCandidates(symbol: string): string[] {
  const candidates = [symbol]
  const withoutSuffix = symbol.replace(/:.+$/, '')
  if (withoutSuffix !== symbol) {
    candidates.push(withoutSuffix)
  }
  if (withoutSuffix.includes('/')) {
    candidates.push(withoutSuffix.replace('/', '-'))
    candidates.push(withoutSuffix.replace('/', ''))
  }
  return Array.from(new Set(candidates.filter(Boolean)))
}

async function getPublicCcxtExchange(exchangeId: string): Promise<Exchange> {
  let exchangePromise = publicExchangeCache.get(exchangeId)
  if (!exchangePromise) {
    const exchanges = ccxt as unknown as Record<string, new (opts: Record<string, unknown>) => Exchange>
    const ExchangeClass = exchanges[exchangeId]
    if (!ExchangeClass) {
      throw new Error(`Unknown public CCXT exchange ${exchangeId}`)
    }

    exchangePromise = (async () => {
      const exchange = new ExchangeClass({
        enableRateLimit: true,
        options: {
          fetchMarkets: { types: ['spot', 'linear', 'inverse'] },
        },
      })
      await exchange.loadMarkets()
      return exchange
    })()
    publicExchangeCache.set(exchangeId, exchangePromise)
  }
  return exchangePromise
}

async function fetchPublicTicker(
  exchangeId: string,
  symbol: string,
): Promise<{ last: number; symbol: string } | null> {
  const exchange = await getPublicCcxtExchange(exchangeId)
  for (const candidate of parseExchangeSymbolCandidates(symbol)) {
    try {
      const ticker = await exchange.fetchTicker(candidate)
      const last = Number(ticker.last)
      if (Number.isFinite(last) && last > 0) {
        return { last, symbol: candidate }
      }
    } catch {
      // Try next symbol candidate.
    }
  }
  return null
}

async function fetchPublicFundingRate(
  exchangeId: string,
  symbol: string,
): Promise<{ fundingRatePct: number; symbol: string } | null> {
  const exchange = await getPublicCcxtExchange(exchangeId)
  const exchangeAny = exchange as Exchange & {
    fetchFundingRate?: (
      symbol: string,
      params?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>
  }
  if (typeof exchangeAny.fetchFundingRate !== 'function') {
    return null
  }

  for (const candidate of parseExchangeSymbolCandidates(symbol)) {
    try {
      const payload = await exchangeAny.fetchFundingRate(candidate, {})
      const fundingRate = Number(payload.fundingRate)
      if (Number.isFinite(fundingRate)) {
        return {
          fundingRatePct: fundingRate * 100,
          symbol: candidate,
        }
      }
    } catch {
      // Try next symbol candidate.
    }
  }
  return null
}

async function fetchPublicOpenInterest(
  exchangeId: string,
  symbol: string,
): Promise<{
  openInterest: number
  openInterestValue?: number
  symbol: string
} | null> {
  const exchange = await getPublicCcxtExchange(exchangeId)
  const exchangeAny = exchange as Exchange & {
    fetchOpenInterest?: (
      symbol: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>
  }
  if (typeof exchangeAny.fetchOpenInterest !== 'function') {
    return null
  }

  for (const candidate of parseExchangeSymbolCandidates(symbol)) {
    try {
      const payload = normalizeOpenInterestPayload(
        await exchangeAny.fetchOpenInterest(candidate, {}),
      )
      if (payload.openInterest > 0) {
        return {
          openInterest: payload.openInterest,
          openInterestValue: payload.openInterestValue,
          symbol: candidate,
        }
      }
    } catch {
      // Try next symbol candidate.
    }
  }
  return null
}

async function fetchPublicLiquidationSummary(
  exchangeId: string,
  symbol: string,
  sinceMs: number,
  limit: number,
): Promise<{
  count: number
  totalNotional?: number
  symbol: string
} | null> {
  const exchange = await getPublicCcxtExchange(exchangeId)
  const exchangeAny = exchange as Exchange & {
    fetchLiquidations?: (
      symbol: string,
      since?: number,
      limit?: number,
      params?: Record<string, unknown>,
    ) => Promise<unknown[]>
  }
  if (typeof exchangeAny.fetchLiquidations !== 'function') {
    return null
  }

  for (const candidate of parseExchangeSymbolCandidates(symbol)) {
    try {
      const summary = summarizeLiquidationRows(
        await exchangeAny.fetchLiquidations(candidate, sinceMs, limit, {}),
      )
      return {
        count: summary.count,
        totalNotional: summary.totalNotional,
        symbol: candidate,
      }
    } catch {
      // Try next symbol candidate.
    }
  }
  return null
}

async function resolveDerivativesData(input: {
  accountManager?: AccountManager
  request: RuntimeStrategySnapshotRequest
}): Promise<ResolvedDerivativesData> {
  const { request } = input
  const provenance = createUnavailableStrategyDataProvenance()
  const accountTarget = input.accountManager
    ? resolveSingleCcxtTarget(input.accountManager, request.source)
    : null
  const exchangeId = request.exchangeId ?? accountTarget?.broker.meta.exchange

  let fundingRatePct = request.fundingRatePct
  let openInterest = request.openInterest
  let openInterestValue = request.openInterestValue
  let liquidationCount24h = request.liquidationCount24h
  let liquidationNotional24h = request.liquidationNotional24h
  let basisInput = request.basisInput

  provenance.fundingRate = fundingRatePct != null
    ? makeSourceStatus('input', 'resolved', 'request override')
    : makeSourceStatus('unavailable', 'missing', 'funding rate not resolved', {
        accountId: accountTarget?.accountId,
        exchangeId,
      })

  provenance.basis = basisInput
    ? makeSourceStatus('input', 'resolved', 'request override')
    : makeSourceStatus('unavailable', 'missing', 'basis inputs not resolved', {
        accountId: accountTarget?.accountId,
        exchangeId,
      })

  provenance.openInterest = openInterest != null
    ? makeSourceStatus('input', 'resolved', 'request override')
    : makeSourceStatus('unavailable', 'missing', 'open interest not resolved', {
        accountId: accountTarget?.accountId,
        exchangeId,
      })

  provenance.liquidation = liquidationCount24h != null || liquidationNotional24h != null
    ? makeSourceStatus('input', 'resolved', 'request override')
    : makeSourceStatus('unavailable', 'missing', 'liquidation summary not resolved', {
        accountId: accountTarget?.accountId,
        exchangeId,
      })

  if (accountTarget) {
    const { accountId, broker } = accountTarget
    const contract = new Contract()
    contract.aliceId = request.symbol
    contract.localSymbol = request.symbol
    contract.symbol = request.symbol

    if (fundingRatePct == null) {
      const funding = await broker.getFundingRate(contract).catch(() => null)
      if (funding?.fundingRate != null) {
        fundingRatePct = funding.fundingRate * 100
        provenance.fundingRate = makeSourceStatus(
          'account-broker',
          'resolved',
          'resolved via broker funding rate',
          {
            accountId,
            exchangeId: broker.meta.exchange,
          },
        )
      }
    }

    if (openInterest == null) {
      const snapshot = await broker.getOpenInterest(contract).catch(() => null)
      if (snapshot?.openInterest != null) {
        openInterest = snapshot.openInterest
        openInterestValue = snapshot.openInterestValue
        provenance.openInterest = makeSourceStatus(
          'account-broker',
          'resolved',
          'resolved via broker open interest',
          {
            accountId,
            exchangeId: broker.meta.exchange,
          },
        )
      }
    }

    if (liquidationCount24h == null || liquidationNotional24h == null) {
      const summary = await broker.getLiquidationSummary(
        contract,
        Date.now() - 24 * 3600_000,
        200,
      ).catch(() => null)
      if (summary) {
        liquidationCount24h = summary.count
        liquidationNotional24h = summary.totalNotional
        provenance.liquidation = makeSourceStatus(
          'account-broker',
          'resolved',
          'resolved via broker liquidation feed',
          {
            accountId,
            exchangeId: broker.meta.exchange,
          },
        )
      }
    }

    if (!basisInput && request.symbol.includes(':')) {
      const futuresQuote = await broker.getQuote(contract).catch(() => null)
      const spotSymbol = request.symbol.replace(/:.+$/, '')
      const spotContract = broker.resolveNativeKey(spotSymbol)
      const spotQuote = await broker.getQuote(spotContract).catch(() => null)
      const futuresPrice = Number(futuresQuote?.last)
      const spotPrice = Number(spotQuote?.last)
      if (Number.isFinite(futuresPrice) && futuresPrice > 0 && Number.isFinite(spotPrice) && spotPrice > 0) {
        basisInput = {
          futuresPrice,
          spotPrice,
        }
        provenance.basis = makeSourceStatus(
          'derived',
          'resolved',
          'derived from broker futures and spot quotes',
          {
            accountId,
            exchangeId: broker.meta.exchange,
          },
        )
      }
    }
  }

  if (exchangeId) {
    if (fundingRatePct == null) {
      const funding = await fetchPublicFundingRate(exchangeId, request.symbol).catch(() => null)
      if (funding) {
        fundingRatePct = funding.fundingRatePct
        provenance.fundingRate = makeSourceStatus(
          'public-ccxt',
          'fallback',
          `resolved via public CCXT funding rate (${funding.symbol})`,
          { exchangeId },
        )
      }
    }

    if (openInterest == null) {
      const snapshot = await fetchPublicOpenInterest(exchangeId, request.symbol).catch(() => null)
      if (snapshot) {
        openInterest = snapshot.openInterest
        openInterestValue = snapshot.openInterestValue
        provenance.openInterest = makeSourceStatus(
          'public-ccxt',
          'fallback',
          `resolved via public CCXT open interest (${snapshot.symbol})`,
          { exchangeId },
        )
      }
    }

    if (liquidationCount24h == null || liquidationNotional24h == null) {
      const summary = await fetchPublicLiquidationSummary(
        exchangeId,
        request.symbol,
        Date.now() - 24 * 3600_000,
        200,
      ).catch(() => null)
      if (summary) {
        liquidationCount24h = summary.count
        liquidationNotional24h = summary.totalNotional
        provenance.liquidation = makeSourceStatus(
          'public-ccxt',
          'fallback',
          `resolved via public CCXT liquidations (${summary.symbol})`,
          { exchangeId },
        )
      }
    }

    if (!basisInput && request.symbol.includes(':')) {
      const futuresQuote = await fetchPublicTicker(exchangeId, request.symbol).catch(() => null)
      const spotQuote = await fetchPublicTicker(
        exchangeId,
        request.symbol.replace(/:.+$/, ''),
      ).catch(() => null)
      if (futuresQuote && spotQuote) {
        basisInput = {
          futuresPrice: futuresQuote.last,
          spotPrice: spotQuote.last,
        }
        provenance.basis = makeSourceStatus(
          'derived',
          'fallback',
          `derived from public CCXT futures (${futuresQuote.symbol}) and spot (${spotQuote.symbol}) quotes`,
          { exchangeId },
        )
      }
    }
  }

  return {
    fundingRatePct,
    openInterest,
    openInterestValue,
    liquidationCount24h,
    liquidationNotional24h,
    basisInput,
    dataProvenance: finalizeProvenance(provenance),
  }
}

export async function evaluateRuntimeStrategySnapshotFromSources(input: {
  accountManager?: AccountManager
  cryptoClient: CryptoClientLike
  request: RuntimeStrategySnapshotRequest
}): Promise<RuntimeStrategySnapshotResponse> {
  const { request } = input
  const raw = await input.cryptoClient.getHistorical({
    symbol: request.symbol,
    interval: request.interval ?? '1h',
    start_date: new Date(Date.now() - 8 * 24 * 3600_000).toISOString().slice(0, 10),
  })
  const candles = normalizeOhlcv(raw)
  if (candles.length < 24) {
    throw new Error(
      `Not enough historical candles for ${request.symbol}; expected at least 24, got ${candles.length}.`,
    )
  }

  const derivatives = await resolveDerivativesData({
    accountManager: input.accountManager,
    request,
  })

  let resolvedEquity = request.equity
  let currentOpenPositions = 0
  let currentLayerOpenPositions = 0
  let isNewOpen = !request.reduceOnly
  const nowUtcMs = Date.now()

  if (resolvedEquity != null) {
    derivatives.dataProvenance.equity = makeSourceStatus(
      'input',
      'resolved',
      'request override',
    )
  }

  if (input.accountManager && request.source) {
    const targets = input.accountManager.resolve(request.source)
    if (targets.length === 1) {
      const account = await targets[0].getAccount().catch(() => null)
      const positions = await targets[0].getPositions().catch(() => [])
      if (resolvedEquity == null && account?.netLiquidation != null) {
        resolvedEquity = account.netLiquidation
        derivatives.dataProvenance.equity = makeSourceStatus(
          'account-broker',
          'resolved',
          'resolved via account equity',
          { accountId: targets[0].id },
        )
      }
      currentOpenPositions = positions.length
      currentLayerOpenPositions = countLayerPositions(positions, request.symbol)
      if (!request.reduceOnly) {
        isNewOpen = !positions.some((position) => position.contract.symbol === request.symbol)
      }
    }
  }

  if (!derivatives.dataProvenance.equity.source) {
    derivatives.dataProvenance.equity = makeSourceStatus(
      'unavailable',
      'missing',
      'equity not resolved',
    )
  }

  const staleData = detectStaleRuntimeInputs({
    candles,
    interval: request.interval,
    nowUtcMs,
    request: {
      ...request,
      fundingRatePct: derivatives.fundingRatePct,
      openInterest: derivatives.openInterest,
      openInterestValue: derivatives.openInterestValue,
      liquidationCount24h: derivatives.liquidationCount24h,
      liquidationNotional24h: derivatives.liquidationNotional24h,
      basisInput: derivatives.basisInput,
    },
  })

  const strategyConfig = await readStrategyConfig()
  const snapshot = evaluateRuntimeFactorSnapshot({
    symbol: request.symbol,
    candles,
    strategyConfig,
    sourceTier: request.sourceTier ?? 'L2',
    useType: request.useType ?? 'U1',
    sentiment: request.sentiment ?? 'S0',
    fundingRatePct: derivatives.fundingRatePct,
    openInterest: derivatives.openInterest,
    openInterestValue: derivatives.openInterestValue,
    liquidationCount24h: derivatives.liquidationCount24h,
    liquidationNotional24h: derivatives.liquidationNotional24h,
    basisInput: derivatives.basisInput,
    dataProvenance: {
      ...derivatives.dataProvenance,
      candles: makeSourceStatus(
        'market-data',
        'resolved',
        'resolved via crypto historical client',
      ),
    },
    equity: resolvedEquity,
    currentOpenPositions,
    currentLayerOpenPositions,
    staleData,
    winRate: request.winRate,
    avgWinLossRatio: request.avgWinLossRatio,
  })

  if (request.side && (request.requestedSize != null || request.requestedUsdSize != null)) {
    const referencePrice =
      typeof request.price === 'number' && request.price > 0
        ? request.price
        : candles[candles.length - 1]?.close
    snapshot.dataProvenance.referencePrice =
      typeof request.price === 'number' && request.price > 0
        ? makeSourceStatus('input', 'resolved', 'request price supplied for execution preview')
        : typeof referencePrice === 'number' && Number.isFinite(referencePrice) && referencePrice > 0
          ? makeSourceStatus('market-data', 'fallback', 'latest candle close used as preview reference price')
          : makeSourceStatus('unavailable', 'missing', 'reference price unavailable for execution preview')

    const executionPreview = buildStrategyExecutionDecision({
      snapshot,
      request: {
        symbol: request.symbol,
        side: request.side,
        type: request.price != null ? 'limit' : 'market',
        size: request.requestedSize,
        usd_size: request.requestedUsdSize,
        price: request.price,
        reduceOnly: request.reduceOnly,
      },
      isNewOpen,
      referencePrice,
    })
    return {
      ...snapshot,
      executionPreview,
    }
  }

  return snapshot
}
