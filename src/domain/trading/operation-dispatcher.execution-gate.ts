import { z } from 'zod'
import { sha256Canonical } from '../../sidecar/contracts.js'
import {
  issueAndVerifyExecutionPermit,
  type ExecutionPermitAction,
  type ExecutionPermitV1,
} from './execution-permit.js'
import type {
  CryptoOperationDispatcherOptions,
  ICryptoTradingEngine,
} from './operation-dispatcher.types.js'

export interface BrokerWriteAuthorizationInput {
  intentId: string
  action: ExecutionPermitAction
  riskReducing: boolean
  symbol: string
  side?: 'buy' | 'sell'
  notionalUsd?: number
  ticketId: string
  idempotencyKey: string
  completedChecks: string[]
}

export type BrokerWriteAuthorization =
  | { allowed: true; permit: ExecutionPermitV1 | null }
  | { allowed: false; reasonCodes: string[] }

export const executionReceiptV1Schema = z.object({
  schemaVersion: z.literal('execution_receipt.v1'),
  receiptId: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
  status: z.enum(['permitted', 'rejected', 'broker_succeeded', 'broker_failed']),
  action: z.enum(['open', 'reduce', 'close', 'cancel', 'adjust_leverage', 'sync']),
  riskReducing: z.boolean(),
  accountId: z.string().trim().min(1),
  accountMode: z.enum(['paper_only', 'live_guarded']),
  symbol: z.string().trim().min(1),
  intentId: z.string().trim().min(1),
  ticketId: z.string(),
  idempotencyKey: z.string(),
  decisionId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  permitId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  releaseManifestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  reasonCodes: z.array(z.string().trim().min(1)),
}).strict()

export type ExecutionReceiptV1 = z.infer<typeof executionReceiptV1Schema>

export async function authorizeBrokerWrite(
  engine: ICryptoTradingEngine,
  options: CryptoOperationDispatcherOptions,
  input: BrokerWriteAuthorizationInput,
): Promise<BrokerWriteAuthorization> {
  if (options.allowTestExecutionPermitBypass && process.env.NODE_ENV === 'test') {
    return { allowed: true, permit: null }
  }
  if (!options.executionAuthorityProvider) {
    const reasonCodes = ['execution_authority_provider_missing']
    await recordExecutionReceipt(options, input, 'rejected', reasonCodes)
    return { allowed: false, reasonCodes }
  }
  if (!options.accountId || !options.accountMode) {
    const reasonCodes = ['execution_account_context_missing']
    await recordExecutionReceipt(options, input, 'rejected', reasonCodes)
    return { allowed: false, reasonCodes }
  }

  const freshness = await verifyFreshExecutionState(engine, input.symbol, {
    now: new Date(),
    maxMarketDataAgeMs: options.maxExecutionMarketDataAgeMs,
  })
  if (!freshness.ok) {
    await recordExecutionReceipt(options, input, 'rejected', freshness.reasonCodes)
    return { allowed: false, reasonCodes: freshness.reasonCodes }
  }

  const decision = await issueAndVerifyExecutionPermit(
    options.executionAuthorityProvider,
    {
      intentId: input.intentId,
      action: input.action,
      riskReducing: input.riskReducing,
      accountId: options.accountId,
      accountMode: options.accountMode,
      symbol: input.symbol,
      side: input.side,
      notionalUsd: input.notionalUsd,
      ticketId: input.ticketId,
      idempotencyKey: input.idempotencyKey,
      completedChecks: sortedUnique([
        ...input.completedChecks,
        'account_fresh',
        'authority_fresh',
        'market_data_fresh',
        'positions_fresh',
      ]),
      ttlMs: options.executionPermitTtlMs,
    },
  )
  if (!decision.allowed) {
    await recordExecutionReceipt(options, input, 'rejected', decision.reasonCodes)
    return decision
  }
  await recordExecutionReceipt(options, input, 'permitted', [], decision.permit)
  return { allowed: true, permit: decision.permit }
}

export async function recordExecutionReceipt(
  options: CryptoOperationDispatcherOptions,
  input: BrokerWriteAuthorizationInput,
  status: ExecutionReceiptV1['status'],
  reasonCodes: string[],
  permit?: ExecutionPermitV1 | null,
): Promise<ExecutionReceiptV1> {
  const generatedAt = new Date().toISOString()
  const core = {
    generatedAt,
    status,
    action: input.action,
    riskReducing: input.riskReducing,
    accountId: options.accountId ?? 'unknown-account',
    accountMode: options.accountMode ?? 'paper_only',
    symbol: input.symbol,
    intentId: input.intentId,
    ticketId: input.ticketId,
    idempotencyKey: input.idempotencyKey,
    decisionId: permit?.decisionId ?? null,
    permitId: permit?.permitId ?? null,
    sourceCommit: permit?.sourceCommit ?? null,
    releaseManifestHash: permit?.releaseManifestHash ?? null,
    reasonCodes: sortedUnique(reasonCodes),
  }
  const receipt = executionReceiptV1Schema.parse({
    schemaVersion: 'execution_receipt.v1',
    receiptId: sha256Canonical(core),
    ...core,
  })
  await options.eventLog?.append('execution.receipt', receipt).catch(() => undefined)
  await options.executionReceiptSink?.(receipt).catch(() => undefined)
  return receipt
}

async function verifyFreshExecutionState(
  engine: ICryptoTradingEngine,
  symbol: string,
  options: { now: Date; maxMarketDataAgeMs?: number },
): Promise<
  | { ok: true; referencePrice: number }
  | { ok: false; reasonCodes: string[] }
> {
  let account
  let positions
  let ticker
  try {
    ;[account, positions, ticker] = await Promise.all([
      engine.getAccount(),
      engine.getPositions(),
      engine.getTicker(symbol),
    ])
  } catch (error) {
    return {
      ok: false,
      reasonCodes: [`execution_state_read_failed:${error instanceof Error ? error.message : String(error)}`],
    }
  }
  const reasons: string[] = []
  if (
    !Number.isFinite(account.balance)
    || !Number.isFinite(account.equity)
    || account.balance < 0
    || account.equity < 0
  ) {
    reasons.push('account_state_invalid')
  }
  if (!Array.isArray(positions) || positions.some((position) => (
    !position.symbol
    || !Number.isFinite(position.size)
    || position.size < 0
  ))) {
    reasons.push('position_state_invalid')
  }
  const tickerAt = ticker.timestamp instanceof Date
    ? ticker.timestamp.getTime()
    : Number.NaN
  const ageMs = options.now.getTime() - tickerAt
  const maxAgeMs = options.maxMarketDataAgeMs ?? 60_000
  if (
    ticker.symbol !== symbol
    || !Number.isFinite(ticker.last)
    || ticker.last <= 0
    || !Number.isFinite(ticker.bid)
    || ticker.bid <= 0
    || !Number.isFinite(ticker.ask)
    || ticker.ask <= 0
  ) {
    reasons.push('market_data_invalid')
  }
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs || ageMs < -30_000) {
    reasons.push('market_data_stale')
  }
  return reasons.length > 0
    ? { ok: false, reasonCodes: sortedUnique(reasons) }
    : { ok: true, referencePrice: ticker.last }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}
