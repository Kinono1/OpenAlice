import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createHash, createPrivateKey, createPublicKey, KeyObject } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'
import {
  createExecutionPermitV2Signer,
  type ExecutionPermitV2Signer,
} from '../domain/trading/execution-protocol.js'
import type { ExecutionAuthorityProvider } from '../domain/trading/execution-permit.js'
import {
  createExecutionSidecarWriter,
  type ExecutionSidecarTransport,
} from '../domain/trading/execution-sidecar-writer.js'
import type { ExecutionSidecarReadModel } from '../domain/trading/execution-sidecar-read-model.js'
import type {
  ExecutionLifecycleReadModel,
  ExecutionLifecycleReadOptions,
  ExecutionLifecycleReplayRequest,
  ExecutionLifecycleSnapshotRequest,
  ExecutionLifecycleStreamOptions,
  ExecutionLifecycleStreamRequest,
} from '../domain/trading/execution-lifecycle-read-model.js'
import type {
  ExecutionOfflineReceiptReadModel,
  ExecutionOfflineReceiptReadOptions,
  ExecutionOfflineReceiptReadResult,
  ExecutionOfflineReceiptRequest,
} from '../domain/trading/execution-offline-receipt-read-model.js'
import {
  ed25519PublicKeyFingerprintSha256,
  type OfflineExecutionReceiptTrustPolicy,
} from '../domain/trading/offline-execution-receipt.js'
import type { AuthorizedBrokerWriter } from '../domain/trading/broker-write-router.js'
import type { CreateCcxtSidecarWriteComponents } from '../domain/trading/account-manager.js'
import {
  createExecutionGrpcTransport,
  type ExecutionGrpcExpectedIdentity,
  type ExecutionGrpcReadableProbe,
  type ExecutionGrpcReadyProbe,
} from '../sidecar/execution-grpc-transport.js'

const MAX_GRPC_TIMEOUT_MS = 30_000
const MAX_PRIVATE_KEY_FILE_BYTES = 16_384
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,100}$/
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,300}$/
const HASH_RE = /^[a-f0-9]{64}$/

export type ExecutionSidecarMode = 'PAPER_LOCAL' | 'PAPER_EXCHANGE'

export interface ExecutionSidecarEnvironmentConfig {
  readonly mode: ExecutionSidecarMode
  readonly runId: string
  readonly environmentProofHash: string
  readonly schemaHash: string
  readonly keyId: string
  readonly privateKeyPath: string
  readonly socketPath: string
  readonly transportTimeoutMs: number
}

/**
 * Deliberately narrow seam around the UDS client.  The default factory is the
 * gRPC implementation, while tests need no socket, server, or broker.
 */
export type ExecutionSidecarTransportFactory = (input: {
  readonly socketPath: string
  readonly rpcDeadlineMs: number
}) => ExecutionSidecarTransport
  & ExecutionSidecarReadModel
  & ExecutionLifecycleReadModel
  & ExecutionGrpcReadyProbe

export type ExecutionSidecarSocketIdentityVerifier = (socketPath: string) => Promise<void>

export type ExecutionSidecarDiagnosticsTransport = ExecutionSidecarReadModel
  & ExecutionLifecycleReadModel
  & ExecutionOfflineReceiptReadModel
  & ExecutionGrpcReadableProbe
  & { close?: () => void }

export type ExecutionSidecarDiagnosticsTransportFactory = (input: {
  readonly socketPath: string
  readonly rpcDeadlineMs: number
}) => ExecutionSidecarDiagnosticsTransport

export type BoundExecutionOfflineReceiptRequest = Omit<
  ExecutionOfflineReceiptRequest,
  'trustPolicy'
>

export interface BoundExecutionOfflineReceiptReadModel {
  getOfflineExecutionReceipt(
    request: BoundExecutionOfflineReceiptRequest,
    options?: ExecutionOfflineReceiptReadOptions,
  ): Promise<ExecutionOfflineReceiptReadResult>
}

export interface AssembleExecutionSidecarOptions {
  readonly authorityProvider: ExecutionAuthorityProvider
  readonly mode: ExecutionSidecarMode
  readonly runId: string
  readonly environmentProofHash: string
  readonly schemaHash: string
  readonly clientId: string
  readonly keyId: string
  /** Production accepts a protected file only; inline private-key material is intentionally unsupported. */
  readonly privateKeyPath: string
  /** Absolute Unix-domain socket path only; this is never a TCP target. */
  readonly socketPath: string
  /** Per-RPC transport deadline. Must leave headroom beneath the dispatcher deadline. */
  readonly transportTimeoutMs: number
  /** Dispatcher outer timeout for the path that receives this writer. */
  readonly dispatcherOuterTimeoutMs: number
  /** Test-only composition seam; it must not start a sidecar or contact a broker. */
  readonly createTransport?: ExecutionSidecarTransportFactory
  /** Test-only seam for isolated unit tests which do not bind a real UDS. */
  readonly verifySocketIdentity?: ExecutionSidecarSocketIdentityVerifier
}

export interface ExecutionSidecarAssembly {
  readonly signer: ExecutionPermitV2Signer
  readonly writer: AuthorizedBrokerWriter
  readonly transport: ExecutionSidecarTransport
    & ExecutionSidecarReadModel
    & ExecutionLifecycleReadModel
    & ExecutionGrpcReadyProbe
  readonly readModel: ExecutionSidecarReadModel
  /** Read-only diagnostics; lifecycle terminal events are not broker proof. */
  readonly lifecycleReadModel: ExecutionLifecycleReadModel
  readonly close: () => void
}

export interface AssembleExecutionSidecarDiagnosticsOptions {
  readonly mode: 'PAPER_LOCAL'
  readonly runId: string
  readonly environmentProofHash: string
  readonly schemaHash: string
  readonly clientId: string
  readonly socketPath: string
  readonly transportTimeoutMs: number
  readonly offlineReceiptTrustPolicy: OfflineExecutionReceiptTrustPolicy
  /** Test-only composition seam; it must not start a sidecar or contact a broker. */
  readonly createTransport?: ExecutionSidecarDiagnosticsTransportFactory
  /** Test-only seam for isolated unit tests which do not bind a real UDS. */
  readonly verifySocketIdentity?: ExecutionSidecarSocketIdentityVerifier
}

export interface ExecutionSidecarDiagnosticsAssembly {
  readonly readModel: ExecutionSidecarReadModel
  readonly lifecycleReadModel: ExecutionLifecycleReadModel
  readonly offlineReceiptReadModel: BoundExecutionOfflineReceiptReadModel
  readonly close: () => void
}

/**
 * Reads only non-secret routing metadata plus a private-key file path. Every
 * field is mandatory when the production CCXT write path exists; there is no
 * enabled/native-fallback switch and no inline private-key variable.
 */
export function resolveExecutionSidecarEnvironmentConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionSidecarEnvironmentConfig {
  const mode = requiredEnvironmentValue(env.OPENALICE_EXECUTION_SIDECAR_MODE)
  const runId = requiredEnvironmentValue(env.OPENALICE_EXECUTION_SIDECAR_RUN_ID)
  const environmentProofHash = requiredEnvironmentValue(
    env.OPENALICE_EXECUTION_SIDECAR_ENVIRONMENT_PROOF_HASH,
  )
  const schemaHash = requiredEnvironmentValue(env.OPENALICE_EXECUTION_SIDECAR_SCHEMA_HASH)
  const keyId = requiredEnvironmentValue(env.OPENALICE_EXECUTION_SIDECAR_KEY_ID)
  const privateKeyPath = requiredEnvironmentValue(
    env.OPENALICE_EXECUTION_SIDECAR_PRIVATE_KEY_FILE,
  )
  const socketPath = requiredEnvironmentValue(env.OPENALICE_EXECUTION_SIDECAR_SOCKET_PATH)
  const timeoutRaw = requiredEnvironmentValue(
    env.OPENALICE_EXECUTION_SIDECAR_TRANSPORT_TIMEOUT_MS,
  )
  if (!/^[1-9][0-9]*$/.test(timeoutRaw)) {
    throw stableError('execution_sidecar_bootstrap_environment_invalid')
  }
  return {
    mode: assertMode(mode),
    runId: assertRunId(runId),
    environmentProofHash: assertHash(environmentProofHash, 'environment_proof'),
    schemaHash: assertHash(schemaHash, 'schema'),
    keyId: assertKeyId(keyId),
    privateKeyPath: assertAbsoluteUnixSocketPath(privateKeyPath, 'private_key'),
    socketPath: assertAbsoluteUnixSocketPath(socketPath, 'socket'),
    transportTimeoutMs: assertTransportTimeout(Number(timeoutRaw)),
  }
}

/** Creates the AccountManager injection while keeping route selection fixed to sidecar. */
export function createCcxtSidecarWriteComponentsFactory(
  environment: ExecutionSidecarEnvironmentConfig,
  options: {
    createTransport?: ExecutionSidecarTransportFactory
    verifySocketIdentity?: ExecutionSidecarSocketIdentityVerifier
  } = {},
): CreateCcxtSidecarWriteComponents {
  return async input => {
    const assembly = await assembleExecutionSidecar({
      authorityProvider: input.authorityProvider,
      mode: environment.mode,
      runId: environment.runId,
      environmentProofHash: environment.environmentProofHash,
      schemaHash: environment.schemaHash,
      clientId: deriveExecutionSidecarClientId(input.accountId),
      keyId: environment.keyId,
      privateKeyPath: environment.privateKeyPath,
      socketPath: environment.socketPath,
      transportTimeoutMs: environment.transportTimeoutMs,
      dispatcherOuterTimeoutMs: input.config.operationTimeoutMs,
      createTransport: options.createTransport,
      verifySocketIdentity: options.verifySocketIdentity,
    })
    return {
      writer: assembly.writer,
      readModel: assembly.readModel,
      lifecycleReadModel: assembly.lifecycleReadModel,
      close: assembly.close,
    }
  }
}

/**
 * Composes the paper-only sidecar client.  This function performs no RPC,
 * does not start a service, and has no broker capability.
 */
export async function assembleExecutionSidecar(
  options: AssembleExecutionSidecarOptions,
): Promise<ExecutionSidecarAssembly> {
  if (!options || typeof options !== 'object') {
    throw stableError('execution_sidecar_bootstrap_options_invalid')
  }
  if (typeof options.authorityProvider !== 'function') {
    throw stableError('execution_sidecar_bootstrap_authority_provider_invalid')
  }
  const mode = assertMode(options.mode)
  const runId = assertRunId(options.runId)
  const environmentProofHash = assertHash(options.environmentProofHash, 'environment_proof')
  const schemaHash = assertHash(options.schemaHash, 'schema')
  const clientId = assertClientId(options.clientId)
  const keyId = assertKeyId(options.keyId)
  const socketPath = assertAbsoluteUnixSocketPath(options.socketPath, 'socket')
  const transportTimeoutMs = assertTransportTimeout(options.transportTimeoutMs)
  const dispatcherOuterTimeoutMs = assertDispatcherTimeout(options.dispatcherOuterTimeoutMs)
  if (transportTimeoutMs >= dispatcherOuterTimeoutMs) {
    throw stableError('execution_sidecar_bootstrap_transport_timeout_not_less_than_dispatcher_timeout')
  }

  const verifySocketIdentity = options.verifySocketIdentity
    ?? verifyOwnerOnlyExecutionSidecarSocket
  try {
    await verifySocketIdentity(socketPath)
  } catch (error) {
    if (isStableError(error)) throw error
    throw stableError('execution_sidecar_bootstrap_socket_unavailable')
  }

  const factory = options.createTransport ?? defaultTransportFactory
  let transport: ExecutionSidecarTransport
    & ExecutionSidecarReadModel
    & ExecutionLifecycleReadModel
    & ExecutionGrpcReadyProbe
  try {
    transport = factory({ socketPath, rpcDeadlineMs: transportTimeoutMs })
  } catch {
    throw stableError('execution_sidecar_bootstrap_transport_creation_failed')
  }
  if (
    !transport
    || typeof transport.execute !== 'function'
    || typeof transport.getCommand !== 'function'
    || typeof transport.getSnapshot !== 'function'
    || typeof transport.replayEvents !== 'function'
    || typeof transport.streamEvents !== 'function'
    || typeof transport.verifyReady !== 'function'
  ) {
    if (transport) closeTransport(transport)
    throw stableError('execution_sidecar_bootstrap_transport_contract_invalid')
  }

  const expectedIdentity: ExecutionGrpcExpectedIdentity = {
    clientId,
    mode,
    runId,
    environmentProofHash,
    schemaHash,
  }
  try {
    await transport.verifyReady(expectedIdentity)
  } catch {
    closeTransport(transport)
    throw stableError('execution_sidecar_bootstrap_preflight_failed')
  }

  let privateKey: KeyObject
  try {
    privateKey = await loadOwnerOnlyEd25519PrivateKey(options.privateKeyPath)
  } catch (error) {
    closeTransport(transport)
    throw error
  }
  let signer: ExecutionPermitV2Signer
  try {
    signer = createExecutionPermitV2Signer({
      authorityProvider: options.authorityProvider,
      mode,
      keyId,
      privateKey,
    })
  } catch {
    closeTransport(transport)
    throw stableError('execution_sidecar_bootstrap_signer_creation_failed')
  }

  let writer: AuthorizedBrokerWriter
  try {
    writer = createExecutionSidecarWriter({ mode, signer, transport, transportTimeoutMs })
  } catch {
    closeTransport(transport)
    throw stableError('execution_sidecar_bootstrap_writer_creation_failed')
  }
  let closed = false
  return {
    signer,
    writer,
    transport,
    readModel: transport,
    lifecycleReadModel: transport,
    close() {
      if (closed) return
      closed = true
      closeTransport(transport)
    },
  }
}

/**
 * Attach a read-only diagnostic facade to an already WRITE_DISARMED peer.
 * This path loads no permit private key and exposes no Execute method.
 */
export async function assembleExecutionSidecarDiagnostics(
  options: AssembleExecutionSidecarDiagnosticsOptions,
): Promise<ExecutionSidecarDiagnosticsAssembly> {
  if (!options || typeof options !== 'object') {
    throw stableError('execution_sidecar_diagnostics_options_invalid')
  }
  if (options.mode !== 'PAPER_LOCAL') {
    throw stableError('execution_sidecar_diagnostics_mode_invalid')
  }
  const runId = assertRunId(options.runId)
  const environmentProofHash = assertHash(
    options.environmentProofHash,
    'environment_proof',
  )
  const schemaHash = assertHash(options.schemaHash, 'schema')
  const clientId = assertClientId(options.clientId)
  const socketPath = assertAbsoluteUnixSocketPath(options.socketPath, 'socket')
  const transportTimeoutMs = assertTransportTimeout(options.transportTimeoutMs)
  const trustPolicy = freezeOfflineReceiptTrustPolicy(
    options.offlineReceiptTrustPolicy,
  )

  const verifySocketIdentity = options.verifySocketIdentity
    ?? verifyOwnerOnlyExecutionSidecarSocket
  try {
    await verifySocketIdentity(socketPath)
  } catch (error) {
    if (isStableError(error)) throw error
    throw stableError('execution_sidecar_diagnostics_socket_unavailable')
  }

  const factory = options.createTransport ?? defaultDiagnosticsTransportFactory
  let transport: ExecutionSidecarDiagnosticsTransport
  try {
    transport = factory({ socketPath, rpcDeadlineMs: transportTimeoutMs })
  } catch {
    throw stableError('execution_sidecar_diagnostics_transport_creation_failed')
  }
  if (
    !transport
    || typeof transport.verifyReadable !== 'function'
    || typeof transport.getCommand !== 'function'
    || typeof transport.getOfflineExecutionReceipt !== 'function'
    || typeof transport.getSnapshot !== 'function'
    || typeof transport.replayEvents !== 'function'
    || typeof transport.streamEvents !== 'function'
  ) {
    if (transport) closeTransport(transport)
    throw stableError('execution_sidecar_diagnostics_transport_contract_invalid')
  }

  const expectedIdentity: ExecutionGrpcExpectedIdentity = {
    clientId,
    mode: 'PAPER_LOCAL',
    runId,
    environmentProofHash,
    schemaHash,
  }
  try {
    await transport.verifyReadable(expectedIdentity)
  } catch {
    closeTransport(transport)
    throw stableError('execution_sidecar_diagnostics_preflight_failed')
  }

  const readModel: ExecutionSidecarReadModel = Object.freeze({
    getCommand: (commandId: string) => transport.getCommand(commandId),
  })
  const lifecycleReadModel: ExecutionLifecycleReadModel = Object.freeze({
    getSnapshot: (
      request: ExecutionLifecycleSnapshotRequest,
      readOptions?: ExecutionLifecycleReadOptions,
    ) => transport.getSnapshot(request, readOptions),
    replayEvents: (
      request: ExecutionLifecycleReplayRequest,
      readOptions?: ExecutionLifecycleReadOptions,
    ) => transport.replayEvents(request, readOptions),
    streamEvents: (
      request: ExecutionLifecycleStreamRequest,
      streamOptions: ExecutionLifecycleStreamOptions,
    ) => transport.streamEvents(request, streamOptions),
  })
  const offlineReceiptReadModel: BoundExecutionOfflineReceiptReadModel = Object.freeze({
    getOfflineExecutionReceipt: (
      request: BoundExecutionOfflineReceiptRequest,
      readOptions?: ExecutionOfflineReceiptReadOptions,
    ) => (
      transport.getOfflineExecutionReceipt(
        { ...request, trustPolicy },
        readOptions,
      )
    ),
  })
  let closed = false
  return Object.freeze({
    readModel,
    lifecycleReadModel,
    offlineReceiptReadModel,
    close() {
      if (closed) return
      closed = true
      closeTransport(transport)
    },
  })
}

/**
 * Reads only a protected key file.  It never accepts inline key material and
 * maps all filesystem and crypto errors to fixed, non-sensitive error codes.
 */
export async function loadOwnerOnlyEd25519PrivateKey(privateKeyPath: string): Promise<KeyObject> {
  const path = assertAbsoluteUnixSocketPath(privateKeyPath, 'private_key')
  await verifyOwnerOnlyParentDirectory(path, 'private_key')
  let initial
  try {
    initial = await lstat(path)
  } catch {
    throw stableError('execution_sidecar_bootstrap_private_key_file_unavailable')
  }
  if (initial.isSymbolicLink()) {
    throw stableError('execution_sidecar_bootstrap_private_key_file_symlink_forbidden')
  }
  if (!initial.isFile()) {
    throw stableError('execution_sidecar_bootstrap_private_key_file_not_regular')
  }

  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw stableError('execution_sidecar_bootstrap_private_key_file_unavailable')
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw stableError('execution_sidecar_bootstrap_private_key_file_not_regular')
    }
    if (metadata.uid !== currentProcessUid('private_key')) {
      throw stableError('execution_sidecar_bootstrap_private_key_file_owner_invalid')
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw stableError('execution_sidecar_bootstrap_private_key_file_permissions_invalid')
    }
    if (metadata.size <= 0 || metadata.size > MAX_PRIVATE_KEY_FILE_BYTES) {
      throw stableError('execution_sidecar_bootstrap_private_key_file_size_invalid')
    }
    const pemOrDer = await handle.readFile()
    let privateKey: KeyObject
    try {
      privateKey = createPrivateKey(pemOrDer)
    } catch {
      throw stableError('execution_sidecar_bootstrap_private_key_file_invalid')
    } finally {
      pemOrDer.fill(0)
    }
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
      throw stableError('execution_sidecar_bootstrap_private_key_type_invalid')
    }
    return privateKey
  } catch (error) {
    if (isStableError(error)) throw error
    throw stableError('execution_sidecar_bootstrap_private_key_file_unavailable')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function verifyOwnerOnlyExecutionSidecarSocket(socketPath: string): Promise<void> {
  const path = assertAbsoluteUnixSocketPath(socketPath, 'socket')
  await verifyOwnerOnlyParentDirectory(path, 'socket')
  let metadata
  try {
    metadata = await lstat(path)
  } catch {
    throw stableError('execution_sidecar_bootstrap_socket_unavailable')
  }
  if (metadata.isSymbolicLink()) {
    throw stableError('execution_sidecar_bootstrap_socket_symlink_forbidden')
  }
  if (!metadata.isSocket()) {
    throw stableError('execution_sidecar_bootstrap_socket_not_unix_socket')
  }
  if (metadata.uid !== currentProcessUid('socket')) {
    throw stableError('execution_sidecar_bootstrap_socket_owner_invalid')
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw stableError('execution_sidecar_bootstrap_socket_permissions_invalid')
  }
}

async function verifyOwnerOnlyParentDirectory(
  targetPath: string,
  subject: 'socket' | 'private_key',
): Promise<void> {
  let metadata
  try {
    metadata = await lstat(dirname(targetPath))
  } catch {
    throw stableError(`execution_sidecar_bootstrap_${subject}_parent_directory_unavailable`)
  }
  if (metadata.isSymbolicLink()) {
    throw stableError(`execution_sidecar_bootstrap_${subject}_parent_directory_symlink_forbidden`)
  }
  if (!metadata.isDirectory()) {
    throw stableError(`execution_sidecar_bootstrap_${subject}_parent_directory_invalid`)
  }
  if (metadata.uid !== currentProcessUid(subject)) {
    throw stableError(`execution_sidecar_bootstrap_${subject}_parent_directory_owner_invalid`)
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw stableError(`execution_sidecar_bootstrap_${subject}_parent_directory_permissions_invalid`)
  }
}

function defaultTransportFactory(input: {
  readonly socketPath: string
  readonly rpcDeadlineMs: number
}): ExecutionSidecarTransport
  & ExecutionSidecarReadModel
  & ExecutionLifecycleReadModel
  & ExecutionGrpcReadyProbe {
  return createExecutionGrpcTransport(input)
}

function defaultDiagnosticsTransportFactory(input: {
  readonly socketPath: string
  readonly rpcDeadlineMs: number
}): ExecutionSidecarDiagnosticsTransport {
  return createExecutionGrpcTransport(input)
}

function freezeOfflineReceiptTrustPolicy(
  value: unknown,
): OfflineExecutionReceiptTrustPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw stableError('execution_sidecar_diagnostics_trust_policy_invalid')
  }
  const policy = value as Partial<OfflineExecutionReceiptTrustPolicy>
  let publicKey: KeyObject
  try {
    const suppliedKey = policy.publicKey as KeyObject | string | Buffer
    publicKey = suppliedKey instanceof KeyObject && suppliedKey.type === 'public'
      ? suppliedKey
      : createPublicKey(suppliedKey)
  } catch {
    throw stableError('execution_sidecar_diagnostics_trust_policy_invalid')
  }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw stableError('execution_sidecar_diagnostics_trust_policy_invalid')
  }
  const keyId = assertKeyId(policy.keyId)
  const adapterId = assertCanonicalBoundedText(policy.adapterId, 200)
  const adapterBuildHash = assertHash(policy.adapterBuildHash, 'adapter_build')
  const adapterConfigHash = assertHash(policy.adapterConfigHash, 'adapter_config')
  const adapterRunId = assertCanonicalBoundedText(policy.adapterRunId, 300)
  if (
    !Array.isArray(policy.permitAuthorityKeyIds)
    || policy.permitAuthorityKeyIds.length === 0
    || !Array.isArray(policy.permitAuthorityPublicKeyFingerprints)
    || policy.permitAuthorityPublicKeyFingerprints.length === 0
  ) {
    throw stableError('execution_sidecar_diagnostics_trust_policy_invalid')
  }
  let permitAuthorityKeyIds: readonly string[]
  let permitAuthorityPublicKeyFingerprints: readonly string[]
  try {
    permitAuthorityKeyIds = Object.freeze(
      policy.permitAuthorityKeyIds.map(assertKeyId),
    )
    permitAuthorityPublicKeyFingerprints = Object.freeze(
      policy.permitAuthorityPublicKeyFingerprints.map(value => (
        assertHash(value, 'permit_authority_public_key')
      )),
    )
  } catch {
    throw stableError('execution_sidecar_diagnostics_trust_policy_invalid')
  }
  const receiptFingerprint = ed25519PublicKeyFingerprintSha256(publicKey)
  if (
    new Set(permitAuthorityKeyIds).size !== permitAuthorityKeyIds.length
    || new Set(permitAuthorityPublicKeyFingerprints).size
      !== permitAuthorityPublicKeyFingerprints.length
    || permitAuthorityKeyIds.includes(keyId)
    || permitAuthorityPublicKeyFingerprints.includes(receiptFingerprint)
  ) {
    throw stableError('execution_sidecar_diagnostics_trust_policy_invalid')
  }
  return Object.freeze({
    keyId,
    adapterId,
    adapterBuildHash,
    adapterConfigHash,
    adapterRunId,
    permitAuthorityKeyIds,
    permitAuthorityPublicKeyFingerprints,
    publicKey,
  })
}

export function deriveExecutionSidecarClientId(accountId: string): string {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw stableError('execution_sidecar_bootstrap_account_id_invalid')
  }
  const digest = createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 32)
  return `openalice.account:${digest}`
}

function assertMode(value: unknown): ExecutionSidecarMode {
  if (value !== 'PAPER_LOCAL' && value !== 'PAPER_EXCHANGE') {
    throw stableError('execution_sidecar_bootstrap_mode_invalid')
  }
  return value
}

function assertKeyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID_RE.test(value)) {
    throw stableError('execution_sidecar_bootstrap_key_id_invalid')
  }
  return value
}

function assertRunId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID_RE.test(value)) {
    throw stableError('execution_sidecar_bootstrap_run_id_invalid')
  }
  return value
}

function assertCanonicalBoundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > maximum
  ) {
    throw stableError('execution_sidecar_diagnostics_trust_policy_invalid')
  }
  return value
}

function assertHash(
  value: unknown,
  subject:
    | 'environment_proof'
    | 'schema'
    | 'adapter_build'
    | 'adapter_config'
    | 'permit_authority_public_key',
): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw stableError(`execution_sidecar_bootstrap_${subject}_hash_invalid`)
  }
  return value
}

function assertClientId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw stableError('execution_sidecar_bootstrap_client_id_invalid')
  }
  return value
}

function assertAbsoluteUnixSocketPath(value: unknown, subject: 'socket' | 'private_key'): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !isAbsolute(value)
    || value.startsWith('//')
    || value.startsWith('unix:')
    || value.includes('://')
  ) {
    throw stableError(`execution_sidecar_bootstrap_${subject}_path_invalid`)
  }
  return value
}

function assertTransportTimeout(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_GRPC_TIMEOUT_MS
  ) {
    throw stableError('execution_sidecar_bootstrap_transport_timeout_invalid')
  }
  return value
}

function assertDispatcherTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw stableError('execution_sidecar_bootstrap_dispatcher_timeout_invalid')
  }
  return value
}

function stableError(code: string): Error {
  return new Error(code)
}

function isStableError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('execution_sidecar_bootstrap_')
}

function currentProcessUid(subject: 'socket' | 'private_key'): number {
  const getuid = process.getuid
  if (typeof getuid !== 'function') {
    throw stableError(`execution_sidecar_bootstrap_${subject}_owner_invalid`)
  }
  return getuid.call(process)
}

function requiredEnvironmentValue(value: string | undefined): string {
  const normalized = value?.trim() ?? ''
  if (!normalized) {
    throw stableError('execution_sidecar_bootstrap_environment_missing')
  }
  return normalized
}

function closeTransport(transport: unknown): void {
  if (!transport || (typeof transport !== 'object' && typeof transport !== 'function')) return
  const close = (transport as { close?: () => void }).close
  if (typeof close !== 'function') return
  try {
    close.call(transport)
  } catch {
    // Cleanup cannot replace the stable bootstrap error that triggered it.
  }
}
