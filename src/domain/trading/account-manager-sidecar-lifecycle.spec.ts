import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../../core/config.js'
import {
  AccountManager,
  type CcxtSidecarWriteComponents,
  type CreateCcxtSidecarWriteComponents,
} from './account-manager.js'

const mocks = vi.hoisted(() => {
  class FakeCcxtBroker {
    readonly id: string
    readonly label: string
    readonly meta: { exchange: string }
    readonly close = vi.fn(async () => {})

    constructor(id: string, exchange = 'okx', private readonly paper = true) {
      this.id = id
      this.label = `${exchange} paper`
      this.meta = { exchange }
    }

    isPaperEnvironment(): boolean {
      return this.paper
    }
  }

  class FakeUnifiedTradingAccount {
    readonly id: string
    readonly label: string
    readonly broker: FakeCcxtBroker
    private readonly onClose?: () => void | Promise<void>

    constructor(broker: FakeCcxtBroker, options: { onClose?: () => void | Promise<void> } = {}) {
      this.id = broker.id
      this.label = broker.label
      this.broker = broker
      this.onClose = options.onClose
    }

    async waitForConnect(): Promise<void> {}

    async close(): Promise<void> {
      await this.onClose?.()
      await this.broker.close()
    }
  }

  return {
    CcxtBroker: FakeCcxtBroker,
    UnifiedTradingAccount: FakeUnifiedTradingAccount,
    createBroker: vi.fn(),
    createBridge: vi.fn(),
    readAccountsConfig: vi.fn(),
    loadGitState: vi.fn(async () => undefined),
    createGitPersister: vi.fn(() => vi.fn()),
    createCcxtProviderTools: vi.fn(() => []),
    createAuthorityProvider: vi.fn(() => async () => ({ allowed: false })),
  }
})

vi.mock('./brokers/ccxt/CcxtBroker.js', () => ({ CcxtBroker: mocks.CcxtBroker }))
vi.mock('./brokers/factory.js', () => ({ createBroker: mocks.createBroker }))
vi.mock('./UnifiedTradingAccount.js', () => ({ UnifiedTradingAccount: mocks.UnifiedTradingAccount }))
vi.mock('./brokers/ccxt/CcxtTradingEngineAdapter.js', () => ({
  resolveCryptoExecutionConfig: (input: Record<string, unknown> = {}) => ({
    mode: 'paper_only',
    enableCryptoDispatcher: true,
    ...input,
  }),
  createCcxtExecutionBridge: mocks.createBridge,
}))
vi.mock('../../core/config.js', () => ({ readAccountsConfig: mocks.readAccountsConfig }))
vi.mock('./git-persistence.js', () => ({
  loadGitState: mocks.loadGitState,
  createGitPersister: mocks.createGitPersister,
}))
vi.mock('./brokers/ccxt/ccxt-tools.js', () => ({ createCcxtProviderTools: mocks.createCcxtProviderTools }))
vi.mock('./execution-permit.js', () => ({
  createEnvironmentExecutionAuthorityProvider: mocks.createAuthorityProvider,
}))

type SidecarAssembly = CcxtSidecarWriteComponents & {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function okxPaperConfig(id = 'okx-paper', enabled = true): AccountConfig {
  return {
    id,
    label: id,
    type: 'ccxt',
    enabled,
    guards: [],
    brokerConfig: { exchange: 'okx', sandbox: true },
    cryptoExecution: {
      mode: 'paper_only',
      enableCryptoDispatcher: true,
      requireDecisionTicket: false,
      ticketTtlMs: 600_000,
      idempotencyTtlMs: 1_800_000,
      killSwitchDefaultPolicy: 'block_new_only',
      killSwitchStatePath: 'data/runtime/kill-switch.sqlite',
      operationTimeoutMs: 30_000,
      admissionDecisionPath: 'data/runtime/admission_decision.v1.json',
    },
  }
}

function newAssembly(): SidecarAssembly {
  return {
    writer: {} as CcxtSidecarWriteComponents['writer'],
    readModel: { async getCommand() { return { found: false as const } } },
    close: vi.fn<() => Promise<void>>(async () => {}),
  }
}

function makeManager(factory: CreateCcxtSidecarWriteComponents): AccountManager {
  return new AccountManager({ createCcxtSidecarWriteComponents: factory } as ConstructorParameters<typeof AccountManager>[0])
}

function installBridgeThatOwnsAssembly(): void {
  mocks.createBridge.mockImplementation(async (input: { brokerWriteAssembly?: { close?: () => Promise<void> } }) => ({
    wrapExecuteOperation: (fallback: unknown) => fallback,
    runtime: () => ({ brokerWriteRoute: 'sidecar' }),
    close: async () => { await input.brokerWriteAssembly?.close?.() },
  }))
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('AccountManager production sidecar lifecycle seam', () => {
  it('assembles the first enabled OKX-paper sidecar, replaces it on reconnect, and releases each assembly once', async () => {
    const config = okxPaperConfig()
    const firstBroker = new mocks.CcxtBroker(config.id)
    const secondBroker = new mocks.CcxtBroker(config.id)
    const firstAssembly = newAssembly()
    const secondAssembly = newAssembly()
    const componentFactory = vi.fn()
      .mockResolvedValueOnce(firstAssembly)
      .mockResolvedValueOnce(secondAssembly)

    mocks.createBroker.mockReturnValueOnce(firstBroker).mockReturnValueOnce(secondBroker)
    mocks.readAccountsConfig.mockResolvedValue([config])
    installBridgeThatOwnsAssembly()

    const manager = makeManager(componentFactory as CreateCcxtSidecarWriteComponents)
    await manager.initAccount(config)

    expect(componentFactory).toHaveBeenCalledTimes(1)
    expect(componentFactory).toHaveBeenCalledWith(expect.objectContaining({
      accountId: config.id,
      broker: firstBroker,
      config: expect.objectContaining({ enableCryptoDispatcher: true, mode: 'paper_only' }),
    }))
    expect(mocks.createBridge).toHaveBeenCalledWith(expect.objectContaining({
      accountId: config.id,
      broker: firstBroker,
      brokerWriteAssembly: expect.objectContaining({
        route: 'sidecar',
        writer: firstAssembly.writer,
        readModel: firstAssembly.readModel,
        close: firstAssembly.close,
      }),
    }))
    expect(manager.has(config.id)).toBe(true)

    await expect(manager.reconnectAccount(config.id)).resolves.toMatchObject({ success: true })

    expect(componentFactory).toHaveBeenCalledTimes(2)
    expect(componentFactory.mock.calls[1]?.[0]?.broker).toBe(secondBroker)
    expect(mocks.createBridge.mock.calls[1]?.[0]?.brokerWriteAssembly).toMatchObject({
      route: 'sidecar',
      writer: secondAssembly.writer,
      readModel: secondAssembly.readModel,
    })
    expect(firstAssembly.close).toHaveBeenCalledTimes(1)
    expect(firstBroker.close).toHaveBeenCalledTimes(1)
    expect(secondAssembly.close).not.toHaveBeenCalled()

    await manager.removeAccount(config.id)
    expect(secondAssembly.close).toHaveBeenCalledTimes(1)
    expect(secondBroker.close).toHaveBeenCalledTimes(1)
    expect(manager.has(config.id)).toBe(false)
  })

  it('removes the old assembly but does not reload sidecar components when fresh reconnect config disables the account', async () => {
    const enabled = okxPaperConfig()
    const disabled = okxPaperConfig(enabled.id, false)
    const broker = new mocks.CcxtBroker(enabled.id)
    const assembly = newAssembly()
    const componentFactory = vi.fn(async () => assembly)

    mocks.createBroker.mockReturnValue(broker)
    mocks.readAccountsConfig.mockResolvedValue([disabled])
    installBridgeThatOwnsAssembly()

    const manager = makeManager(componentFactory as CreateCcxtSidecarWriteComponents)
    await manager.initAccount(enabled)
    await expect(manager.reconnectAccount(enabled.id)).resolves.toMatchObject({ success: true })

    expect(componentFactory).toHaveBeenCalledTimes(1)
    expect(mocks.createBridge).toHaveBeenCalledTimes(1)
    expect(mocks.createBroker).toHaveBeenCalledTimes(1)
    expect(assembly.close).toHaveBeenCalledTimes(1)
    expect(broker.close).toHaveBeenCalledTimes(1)
    expect(manager.has(enabled.id)).toBe(false)
  })

  it('does not register a UTA when component construction fails, and closes a published assembly if bridge construction fails', async () => {
    const config = okxPaperConfig()
    const componentFailureManager = makeManager(
      vi.fn(async () => {
        throw new Error('component factory failed')
      }) as CreateCcxtSidecarWriteComponents,
    )
    mocks.createBroker.mockReturnValue(new mocks.CcxtBroker(config.id))

    await expect(componentFailureManager.initAccount(config)).rejects.toThrow('component factory failed')
    expect(mocks.createBridge).not.toHaveBeenCalled()
    expect(componentFailureManager.has(config.id)).toBe(false)

    vi.clearAllMocks()
    const assembly = newAssembly()
    const bridgeFailureManager = makeManager(
      vi.fn(async () => assembly) as CreateCcxtSidecarWriteComponents,
    )
    mocks.createBroker.mockReturnValue(new mocks.CcxtBroker(config.id))
    mocks.createBridge.mockRejectedValue(new Error('bridge construction failed'))

    await expect(bridgeFailureManager.initAccount(config)).rejects.toThrow('bridge construction failed')
    expect(assembly.close).toHaveBeenCalledTimes(1)
    expect(bridgeFailureManager.has(config.id)).toBe(false)
  })
})
