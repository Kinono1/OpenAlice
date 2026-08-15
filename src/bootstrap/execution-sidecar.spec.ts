import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionAuthoritySnapshot } from '../domain/trading/execution-permit.js'
import type { ExecutionSidecarTransport } from '../domain/trading/execution-sidecar-writer.js'
import type { ExecutionSidecarReadModel } from '../domain/trading/execution-sidecar-read-model.js'
import type { ExecutionLifecycleReadModel } from '../domain/trading/execution-lifecycle-read-model.js'
import type { ExecutionGrpcReadyProbe } from '../sidecar/execution-grpc-transport.js'
import type { OfflineExecutionReceiptTrustPolicy } from '../domain/trading/offline-execution-receipt.js'
import {
  assembleExecutionSidecar,
  assembleExecutionSidecarDiagnostics,
  createCcxtSidecarWriteComponentsFactory,
  deriveExecutionSidecarClientId,
  loadOwnerOnlyEd25519PrivateKey,
  resolveExecutionSidecarEnvironmentConfig,
  verifyOwnerOnlyExecutionSidecarSocket,
  type AssembleExecutionSidecarOptions,
  type ExecutionSidecarDiagnosticsTransport,
} from './execution-sidecar.js'

// RFC 8032 test vector 1; this is public, non-production test material.
const TEST_ED25519_PRIVATE_KEY_PEM = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'hex',
  ),
  format: 'der',
  type: 'pkcs8',
}).export({ format: 'pem', type: 'pkcs8' }).toString()

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('execution sidecar bootstrap', () => {
  it.each([
    ['relative socket', { socketPath: 'run/sidecar.sock' }, 'execution_sidecar_bootstrap_socket_path_invalid'],
    ['TCP socket', { socketPath: 'tcp://127.0.0.1:50051' }, 'execution_sidecar_bootstrap_socket_path_invalid'],
    ['bad mode', { mode: 'LIVE' }, 'execution_sidecar_bootstrap_mode_invalid'],
    ['bad run ID', { runId: 'bad run' }, 'execution_sidecar_bootstrap_run_id_invalid'],
    ['bad proof hash', { environmentProofHash: 'A'.repeat(64) }, 'execution_sidecar_bootstrap_environment_proof_hash_invalid'],
    ['bad key id', { keyId: '../key' }, 'execution_sidecar_bootstrap_key_id_invalid'],
    ['bad timeout relation', { transportTimeoutMs: 1_000, dispatcherOuterTimeoutMs: 1_000 }, 'execution_sidecar_bootstrap_transport_timeout_not_less_than_dispatcher_timeout'],
  ] as const)('fails closed for %s without invoking the transport factory', async (_label, patch, code) => {
    const keyPath = await writeTestKey()
    const factory = vi.fn(makeTransport)
    await expect(assembleExecutionSidecar({
      ...baseOptions(keyPath),
      ...patch,
      createTransport: factory,
    } as unknown as AssembleExecutionSidecarOptions))
      .rejects.toThrow(code)
    expect(factory).not.toHaveBeenCalled()
  })

  it('rejects symlink, non-private permissions, wrong owner, and non-Ed25519 files with stable codes', async () => {
    const keyPath = await writeTestKey()
    const linkPath = join(await testDir(), 'key-link')
    await symlink(keyPath, linkPath)
    await expect(loadOwnerOnlyEd25519PrivateKey(linkPath))
      .rejects.toThrow('execution_sidecar_bootstrap_private_key_file_symlink_forbidden')

    await chmod(keyPath, 0o640)
    await expect(loadOwnerOnlyEd25519PrivateKey(keyPath))
      .rejects.toThrow('execution_sidecar_bootstrap_private_key_file_permissions_invalid')

    await chmod(keyPath, 0o600)
    const getuid = process.getuid
    if (typeof getuid !== 'function') throw new Error('test_requires_posix_uid')
    vi.spyOn(process, 'getuid').mockReturnValue(getuid.call(process) + 1)
    await expect(loadOwnerOnlyEd25519PrivateKey(keyPath))
      .rejects.toThrow('execution_sidecar_bootstrap_private_key_parent_directory_owner_invalid')
    vi.restoreAllMocks()

    const rsaPath = join(await testDir(), 'not-ed25519.pem')
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    await writeFile(rsaPath, rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    await chmod(rsaPath, 0o600)
    await expect(loadOwnerOnlyEd25519PrivateKey(rsaPath))
      .rejects.toThrow('execution_sidecar_bootstrap_private_key_type_invalid')

    const oversizedPath = join(await testDir(), 'oversized-key.pem')
    await writeFile(oversizedPath, Buffer.alloc(16_385, 0x41), { mode: 0o600 })
    await chmod(oversizedPath, 0o600)
    await expect(loadOwnerOnlyEd25519PrivateKey(oversizedPath))
      .rejects.toThrow('execution_sidecar_bootstrap_private_key_file_size_invalid')
  })

  it('rejects missing, symlinked, and non-socket UDS identities before creating a client', async () => {
    const directory = await testDir()
    const regularPath = join(directory, 'regular-file')
    await writeFile(regularPath, 'not-a-socket', { mode: 0o600 })
    await expect(verifyOwnerOnlyExecutionSidecarSocket(join(directory, 'missing.sock')))
      .rejects.toThrow('execution_sidecar_bootstrap_socket_unavailable')
    await expect(verifyOwnerOnlyExecutionSidecarSocket(regularPath))
      .rejects.toThrow('execution_sidecar_bootstrap_socket_not_unix_socket')
    const linkPath = join(directory, 'socket-link')
    await symlink(regularPath, linkPath)
    await expect(verifyOwnerOnlyExecutionSidecarSocket(linkPath))
      .rejects.toThrow('execution_sidecar_bootstrap_socket_symlink_forbidden')
  })

  it('rejects group/world-writable parent directories for socket and key paths', async () => {
    const directory = await testDir()
    const keyPath = join(directory, 'key.pem')
    await writeFile(keyPath, TEST_ED25519_PRIVATE_KEY_PEM, { mode: 0o600 })
    await chmod(directory, 0o770)
    await expect(verifyOwnerOnlyExecutionSidecarSocket(join(directory, 'sidecar.sock')))
      .rejects.toThrow('execution_sidecar_bootstrap_socket_parent_directory_permissions_invalid')
    await expect(loadOwnerOnlyEd25519PrivateKey(keyPath))
      .rejects.toThrow('execution_sidecar_bootstrap_private_key_parent_directory_permissions_invalid')
  })

  it('rejects a missing authority provider before reading key material or constructing transport', async () => {
    const factory = vi.fn(makeTransport)
    await expect(assembleExecutionSidecar({
      ...baseOptions('/private/path/that/must/not/be/read'),
      authorityProvider: undefined as unknown as AssembleExecutionSidecarOptions['authorityProvider'],
      createTransport: factory,
    })).rejects.toThrow('execution_sidecar_bootstrap_authority_provider_invalid')
    expect(factory).not.toHaveBeenCalled()
  })

  it('constructs signer, sidecar writer, and UDS transport/read-model without a network call', async () => {
    const keyPath = await writeTestKey()
    const transport = makeTransport()
    const factory = vi.fn(() => transport)
    const assembly = await assembleExecutionSidecar({
      ...baseOptions(keyPath),
      createTransport: factory,
    })

    expect(assembly.signer.sign).toBeTypeOf('function')
    expect(assembly.writer.placeOrder).toBeTypeOf('function')
    expect(assembly.transport).toBe(transport)
    expect(assembly.readModel).toBe(transport)
    expect(assembly.lifecycleReadModel).toBe(transport)
    expect(factory).toHaveBeenCalledWith({
      socketPath: '/private/tmp/openalice-execution-sidecar.sock',
      rpcDeadlineMs: 1_000,
    })
    expect(transport.verifyReady).toHaveBeenCalledWith({
      clientId: 'openalice.account:test',
      mode: 'PAPER_LOCAL',
      runId: 'paper-sidecar-test-run',
      environmentProofHash: 'b'.repeat(64),
      schemaHash: 'a'.repeat(64),
    })
    assembly.close()
    assembly.close()
  })

  it('requires an explicit, canonical environment configuration and no inline key material', () => {
    expect(() => resolveExecutionSidecarEnvironmentConfig({
      OPENALICE_EXECUTION_SIDECAR_PRIVATE_KEY: TEST_ED25519_PRIVATE_KEY_PEM,
    })).toThrow('execution_sidecar_bootstrap_environment_missing')
    expect(() => resolveExecutionSidecarEnvironmentConfig({
      ...environmentConfig(),
      OPENALICE_EXECUTION_SIDECAR_TRANSPORT_TIMEOUT_MS: '01000',
    })).toThrow('execution_sidecar_bootstrap_environment_invalid')
    expect(resolveExecutionSidecarEnvironmentConfig(environmentConfig())).toEqual({
      mode: 'PAPER_EXCHANGE',
      runId: 'paper-sidecar-production-run',
      environmentProofHash: 'b'.repeat(64),
      schemaHash: 'a'.repeat(64),
      keyId: 'paper-key-1',
      privateKeyPath: '/private/tmp/openalice-sidecar-key.pem',
      socketPath: '/private/tmp/openalice-sidecar.sock',
      transportTimeoutMs: 1_000,
    })
  })

  it('builds AccountManager sidecar components with the account dispatcher timeout', async () => {
    const keyPath = await writeTestKey()
    const transport = makeTransport()
    const factory = createCcxtSidecarWriteComponentsFactory({
      mode: 'PAPER_LOCAL', runId: 'paper-sidecar-test-run',
      environmentProofHash: 'b'.repeat(64), schemaHash: 'a'.repeat(64),
      keyId: 'paper-key-1', privateKeyPath: keyPath,
      socketPath: '/private/tmp/openalice-sidecar.sock', transportTimeoutMs: 1_000,
    }, {
      createTransport: () => transport,
      verifySocketIdentity: async () => {},
    })
    const components = await factory({
      accountId: 'paper-main',
      broker: {} as never,
      config: { operationTimeoutMs: 2_000 } as never,
      authorityProvider: async () => { throw new Error('not_called') },
    })
    expect(components.writer.placeOrder).toBeTypeOf('function')
    expect(components.readModel).toBe(transport)
    expect(components.lifecycleReadModel).toBe(transport)
    expect(transport.verifyReady).toHaveBeenCalledWith(expect.objectContaining({
      clientId: deriveExecutionSidecarClientId('paper-main'),
      mode: 'PAPER_LOCAL',
    }))
    await components.close?.()
  })

  it('closes transport and does not read the signing key when startup preflight fails', async () => {
    const close = vi.fn()
    const transport = {
      ...makeTransport(),
      verifyReady: vi.fn(async () => { throw new Error('untrusted_or_unready_peer') }),
      close,
    }
    await expect(assembleExecutionSidecar({
      ...baseOptions('/private/path/that/must/not/be/read'),
      createTransport: () => transport,
    })).rejects.toThrow('execution_sidecar_bootstrap_preflight_failed')
    expect(close).toHaveBeenCalledOnce()
  })

  it('assembles a frozen PAPER_LOCAL read-only facade without exposing Execute or key material', async () => {
    const transport = makeDiagnosticsTransport()
    const factory = vi.fn(() => transport)
    const policy = makeReceiptTrustPolicy()
    const mutableKeyIds = policy.permitAuthorityKeyIds as string[]
    const mutableFingerprints = policy.permitAuthorityPublicKeyFingerprints as string[]
    const assembly = await assembleExecutionSidecarDiagnostics({
      ...diagnosticsOptions(policy),
      createTransport: factory,
    })

    expect(Object.keys(assembly).sort()).toEqual([
      'close',
      'lifecycleReadModel',
      'offlineReceiptReadModel',
      'readModel',
    ])
    expect('transport' in assembly).toBe(false)
    expect('writer' in assembly).toBe(false)
    expect('signer' in assembly).toBe(false)
    expect('execute' in assembly).toBe(false)
    expect(Object.isFrozen(assembly)).toBe(true)
    expect(transport.verifyReadable).toHaveBeenCalledWith({
      clientId: 'openalice.diagnostics:test',
      mode: 'PAPER_LOCAL',
      runId: 'paper-sidecar-test-run',
      environmentProofHash: 'b'.repeat(64),
      schemaHash: 'a'.repeat(64),
    })

    await expect(assembly.readModel.getCommand('1')).resolves.toEqual({ found: false })
    await expect(assembly.lifecycleReadModel.getSnapshot({
      accountId: 'paper-main',
      canonicalSymbol: 'BTC/USDT',
    })).resolves.toEqual({ found: false })
    await expect(assembly.lifecycleReadModel.replayEvents({
      afterSequence: '0',
      limit: 10,
    })).resolves.toEqual([])

    mutableKeyIds[0] = 'mutated-key'
    mutableFingerprints[0] = 'f'.repeat(64)
    await expect(assembly.offlineReceiptReadModel.getOfflineExecutionReceipt({
      receiptId: 'd'.repeat(64),
      expected: {} as never,
    })).resolves.toEqual({ found: false })
    const receiptRequest = vi.mocked(transport.getOfflineExecutionReceipt).mock.calls[0]?.[0]
    expect(receiptRequest?.trustPolicy).not.toBe(policy)
    expect(receiptRequest?.trustPolicy.permitAuthorityKeyIds).toEqual(['permit-key-1'])
    expect(receiptRequest?.trustPolicy.permitAuthorityPublicKeyFingerprints)
      .toEqual(['e'.repeat(64)])
    expect(Object.isFrozen(receiptRequest?.trustPolicy)).toBe(true)
    expect(Object.isFrozen(receiptRequest?.trustPolicy.permitAuthorityKeyIds)).toBe(true)
    expect(Object.isFrozen(receiptRequest?.trustPolicy.permitAuthorityPublicKeyFingerprints))
      .toBe(true)

    assembly.close()
    assembly.close()
    expect(transport.close).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledWith({
      socketPath: '/private/tmp/openalice-execution-sidecar.sock',
      rpcDeadlineMs: 1_000,
    })
  })

  it('fails closed and closes a diagnostics transport with an incomplete read contract', async () => {
    const close = vi.fn()
    const transport = {
      ...makeDiagnosticsTransport(),
      getOfflineExecutionReceipt: undefined,
      close,
    }
    await expect(assembleExecutionSidecarDiagnostics({
      ...diagnosticsOptions(makeReceiptTrustPolicy()),
      createTransport: () => transport as unknown as ExecutionSidecarDiagnosticsTransport,
    })).rejects.toThrow('execution_sidecar_diagnostics_transport_contract_invalid')
    expect(close).toHaveBeenCalledOnce()
  })

  it('validates and freezes receipt authority before touching the diagnostics socket or client', async () => {
    const policy = makeReceiptTrustPolicy()
    const verifySocketIdentity = vi.fn(async () => {})
    const factory = vi.fn(makeDiagnosticsTransport)
    await expect(assembleExecutionSidecarDiagnostics({
      ...diagnosticsOptions({
        ...policy,
        permitAuthorityKeyIds: [policy.keyId],
      }),
      verifySocketIdentity,
      createTransport: factory,
    })).rejects.toThrow('execution_sidecar_diagnostics_trust_policy_invalid')
    expect(verifySocketIdentity).not.toHaveBeenCalled()
    expect(factory).not.toHaveBeenCalled()
  })

  it('closes a diagnostics transport when READ_ONLY identity preflight fails', async () => {
    const close = vi.fn()
    const transport = {
      ...makeDiagnosticsTransport(),
      verifyReadable: vi.fn(async () => {
        throw new Error('execution_grpc_health_identity_mismatch')
      }),
      close,
    }
    await expect(assembleExecutionSidecarDiagnostics({
      ...diagnosticsOptions(makeReceiptTrustPolicy()),
      createTransport: () => transport,
    })).rejects.toThrow('execution_sidecar_diagnostics_preflight_failed')
    expect(close).toHaveBeenCalledOnce()
  })
})

function baseOptions(privateKeyPath: string): AssembleExecutionSidecarOptions {
  return {
    authorityProvider: async (): Promise<ExecutionAuthoritySnapshot> => {
      throw new Error('not_called_during_bootstrap')
    },
    mode: 'PAPER_LOCAL',
    runId: 'paper-sidecar-test-run',
    environmentProofHash: 'b'.repeat(64),
    schemaHash: 'a'.repeat(64),
    clientId: 'openalice.account:test',
    keyId: 'rfc8032-test-1',
    privateKeyPath,
    socketPath: '/private/tmp/openalice-execution-sidecar.sock',
    transportTimeoutMs: 1_000,
    dispatcherOuterTimeoutMs: 2_000,
    verifySocketIdentity: async () => {},
  }
}

function makeTransport(): ExecutionSidecarTransport
  & ExecutionSidecarReadModel
  & ExecutionLifecycleReadModel
  & ExecutionGrpcReadyProbe {
  return {
    verifyReady: vi.fn(async () => ({
      protocolVersion: 'openalice.execution.v1' as const,
      serviceId: 'openalice.nautilus_paper.durable_admission' as const,
      mode: 'PAPER_LOCAL' as const,
      runId: 'paper-sidecar-test-run',
      environmentProofHash: 'b'.repeat(64),
      schemaHash: 'a'.repeat(64),
      writerEpoch: '1',
      latestSequence: '0',
    })),
    async execute() {
      throw new Error('not_called_during_bootstrap')
    },
    async getCommand() {
      throw new Error('not_called_during_bootstrap')
    },
    async getSnapshot() {
      throw new Error('not_called_during_bootstrap')
    },
    async replayEvents() {
      throw new Error('not_called_during_bootstrap')
    },
    streamEvents() {
      throw new Error('not_called_during_bootstrap')
    },
  }
}

function makeDiagnosticsTransport(): ExecutionSidecarDiagnosticsTransport {
  return {
    verifyReadable: vi.fn(async () => ({
      protocolVersion: 'openalice.execution.v1' as const,
      serviceId: 'openalice.nautilus_paper.durable_admission' as const,
      mode: 'PAPER_LOCAL' as const,
      runId: 'paper-sidecar-test-run',
      environmentProofHash: 'b'.repeat(64),
      schemaHash: 'a'.repeat(64),
      writerEpoch: '1',
      latestSequence: '0',
    })),
    getCommand: vi.fn(async () => ({ found: false as const })),
    getOfflineExecutionReceipt: vi.fn(async () => ({ found: false as const })),
    getSnapshot: vi.fn(async () => ({ found: false as const })),
    replayEvents: vi.fn(async () => []),
    streamEvents: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        // Empty diagnostic stream fixture.
      },
    })),
    close: vi.fn(),
  }
}

function diagnosticsOptions(
  offlineReceiptTrustPolicy: OfflineExecutionReceiptTrustPolicy,
) {
  return {
    mode: 'PAPER_LOCAL' as const,
    runId: 'paper-sidecar-test-run',
    environmentProofHash: 'b'.repeat(64),
    schemaHash: 'a'.repeat(64),
    clientId: 'openalice.diagnostics:test',
    socketPath: '/private/tmp/openalice-execution-sidecar.sock',
    transportTimeoutMs: 1_000,
    offlineReceiptTrustPolicy,
    verifySocketIdentity: async () => {},
  }
}

function makeReceiptTrustPolicy(): OfflineExecutionReceiptTrustPolicy {
  const { publicKey } = generateKeyPairSync('ed25519')
  return {
    keyId: 'receipt-key-1',
    adapterId: 'openalice.offline_simulator',
    adapterBuildHash: 'c'.repeat(64),
    adapterConfigHash: 'd'.repeat(64),
    adapterRunId: 'offline-simulator-test-run',
    permitAuthorityKeyIds: ['permit-key-1'],
    permitAuthorityPublicKeyFingerprints: ['e'.repeat(64)],
    publicKey,
  }
}

function environmentConfig(): NodeJS.ProcessEnv {
  return {
    OPENALICE_EXECUTION_SIDECAR_MODE: 'PAPER_EXCHANGE',
    OPENALICE_EXECUTION_SIDECAR_RUN_ID: 'paper-sidecar-production-run',
    OPENALICE_EXECUTION_SIDECAR_ENVIRONMENT_PROOF_HASH: 'b'.repeat(64),
    OPENALICE_EXECUTION_SIDECAR_SCHEMA_HASH: 'a'.repeat(64),
    OPENALICE_EXECUTION_SIDECAR_KEY_ID: 'paper-key-1',
    OPENALICE_EXECUTION_SIDECAR_PRIVATE_KEY_FILE: '/private/tmp/openalice-sidecar-key.pem',
    OPENALICE_EXECUTION_SIDECAR_SOCKET_PATH: '/private/tmp/openalice-sidecar.sock',
    OPENALICE_EXECUTION_SIDECAR_TRANSPORT_TIMEOUT_MS: '1000',
  }
}

async function writeTestKey(): Promise<string> {
  const path = join(await testDir(), 'ed25519-test-key.pem')
  await writeFile(path, TEST_ED25519_PRIVATE_KEY_PEM, { mode: 0o600 })
  await chmod(path, 0o600)
  return path
}

async function testDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'openalice-execution-sidecar-bootstrap-'))
  temporaryPaths.push(path)
  return path
}
