import { describe, expect, it, vi } from 'vitest'
import type { CcxtBroker } from './brokers/ccxt/CcxtBroker.js'
import { DEFAULT_CRYPTO_EXECUTION_CONFIG } from './brokers/ccxt/CcxtTradingEngineAdapter.js'
import {
  assembleCcxtSidecarBrokerWriteRoute,
  type CreateCcxtSidecarWriteComponents,
  type CcxtSidecarWriteComponents,
} from './account-manager.js'

describe('AccountManager CCXT sidecar assembly', () => {
  it('binds the exact same authority provider to the component factory and bridge assembly', async () => {
    let observedProvider: unknown
    const components = makeComponents()
    const createComponents: CreateCcxtSidecarWriteComponents = vi.fn(async input => {
      observedProvider = input.authorityProvider
      expect(input.accountId).toBe('paper-main')
      expect(input.config.admissionDecisionPath).toBe('/private/tmp/admission.json')
      return components
    })

    const assembly = await assembleCcxtSidecarBrokerWriteRoute({
      accountId: 'paper-main',
      broker: paperBroker('okx'),
      config: {
        ...DEFAULT_CRYPTO_EXECUTION_CONFIG,
        admissionDecisionPath: '/private/tmp/admission.json',
      },
      createComponents,
    })

    expect(assembly).toMatchObject({
      route: 'sidecar',
      writer: components.writer,
      readModel: components.readModel,
      close: components.close,
    })
    expect(assembly?.route === 'sidecar' && assembly.executionAuthorityProvider)
      .toBe(observedProvider)
  })

  it.each([
    ['non-OKX venue', paperBroker('bybit'), DEFAULT_CRYPTO_EXECUTION_CONFIG],
    ['non-paper broker', paperBroker('okx', false), DEFAULT_CRYPTO_EXECUTION_CONFIG],
    ['live mode', paperBroker('okx'), { ...DEFAULT_CRYPTO_EXECUTION_CONFIG, mode: 'live_guarded' as const }],
  ])('rejects %s before key/transport component creation', async (_label, broker, config) => {
    const createComponents = vi.fn(async () => makeComponents())
    await expect(assembleCcxtSidecarBrokerWriteRoute({
      accountId: 'blocked', broker, config, createComponents,
    })).rejects.toThrow('execution sidecar MVP requires an OKX paper broker target')
    expect(createComponents).not.toHaveBeenCalled()
  })

  it('does not create sidecar components when the dispatcher is explicitly disabled', async () => {
    const createComponents = vi.fn(async () => makeComponents())
    await expect(assembleCcxtSidecarBrokerWriteRoute({
      accountId: 'disabled',
      broker: paperBroker('okx'),
      config: { ...DEFAULT_CRYPTO_EXECUTION_CONFIG, enableCryptoDispatcher: false },
      createComponents,
    })).resolves.toBeUndefined()
    expect(createComponents).not.toHaveBeenCalled()
  })

  it('cannot be redirected to native by extra runtime properties from a factory', async () => {
    let observedProvider: unknown
    const createComponents = vi.fn(async input => {
      observedProvider = input.authorityProvider
      return {
        ...makeComponents(),
        route: 'native',
        executionAuthorityProvider: async () => { throw new Error('foreign_provider') },
      } as unknown as CcxtSidecarWriteComponents
    })
    const assembly = await assembleCcxtSidecarBrokerWriteRoute({
      accountId: 'paper-main',
      broker: paperBroker('okx'),
      config: DEFAULT_CRYPTO_EXECUTION_CONFIG,
      createComponents,
    })
    expect(assembly?.route).toBe('sidecar')
    expect(assembly?.route === 'sidecar' && assembly.executionAuthorityProvider)
      .toBe(observedProvider)
  })
})

function paperBroker(exchange: string, paper = true): CcxtBroker {
  return {
    meta: { exchange },
    isPaperEnvironment: () => paper,
  } as CcxtBroker
}

function makeComponents(): CcxtSidecarWriteComponents {
  return {
    writer: {} as CcxtSidecarWriteComponents['writer'],
    readModel: { async getCommand() { return { found: false } } },
    close: vi.fn(),
  }
}
