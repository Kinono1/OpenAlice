import { describe, expect, it } from 'vitest'
import type { AccountConfig } from '../core/config.js'
import { requiredExecutionSidecarAccountIds } from './execution.js'

describe('execution bootstrap sidecar routing', () => {
  it('requires sidecar only for enabled CCXT dispatchers on an order-submission runtime', () => {
    const accounts: AccountConfig[] = [
      account('ccxt-required', 'ccxt'),
      account('ccxt-disabled-account', 'ccxt', { enabled: false }),
      account('ccxt-disabled-dispatcher', 'ccxt', {
        cryptoExecution: {
          mode: 'paper_only',
          enableCryptoDispatcher: false,
          requireDecisionTicket: false,
          ticketTtlMs: 600_000,
          idempotencyTtlMs: 1_800_000,
          killSwitchDefaultPolicy: 'block_new_only',
          killSwitchStatePath: 'data/runtime/kill-switch.sqlite',
          operationTimeoutMs: 30_000,
          admissionDecisionPath: 'data/runtime/admission_decision.v1.json',
        },
      }),
      account('securities-account', 'alpaca'),
    ]

    expect([...requiredExecutionSidecarAccountIds(accounts, runtime(true))])
      .toEqual(['ccxt-required'])
  })

  it('does not require or load sidecar configuration when order submission is disabled', () => {
    expect(requiredExecutionSidecarAccountIds(
      [account('ccxt-research-only', 'ccxt')],
      runtime(false),
    ).size).toBe(0)
  })
})

function account(
  id: string,
  type: string,
  patch: Partial<AccountConfig> = {},
): AccountConfig {
  return {
    id,
    type,
    enabled: true,
    guards: [],
    brokerConfig: {},
    ...patch,
  }
}

function runtime(orderSubmissionPathEnabled: boolean) {
  return {
    capabilities: {
      ownsCron: false,
      initializesAccounts: orderSubmissionPathEnabled,
      orderSubmissionPathEnabled,
      writesPromotion: false,
      writesSharedData: false,
    },
  }
}
