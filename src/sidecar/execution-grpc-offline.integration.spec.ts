import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildExecutionCommandV1, deriveOkxClientOrderId, executionPermitV2Id,
  type ExecutionCommandV1, type ExecutionPermitV2,
} from '../domain/trading/execution-protocol.js'
import {
  deriveOfflineExecutionAttemptId, ed25519PublicKeyFingerprintSha256,
  type OfflineExecutionReceiptExpectedBinding, type OfflineExecutionReceiptTrustPolicy,
} from '../domain/trading/offline-execution-receipt.js'
import type { ExecutionSidecarTransportRequest } from '../domain/trading/execution-sidecar-writer.js'
import { stableStringify } from './contracts.js'
import { ExecutionGrpcTransport } from './execution-grpc-transport.js'

const python = process.env.OPENALICE_SIDECAR_TEST_PYTHON?.trim()
const offlineIt = python ? it : it.skip
const gateMode = process.env.OPENALICE_D1_RELEASE_GATE === '1'
const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '../..')
const RUN_ID = 'paper-local-uds-contract-test'
const SCHEMA_HASH = 'a'.repeat(64)
const PROOF_HASH = 'eb4aff560c8dcc790ce03a22c51840bc3dc654cab74bcaf1bf2d6c445e5cb4f8'
const PERMIT_PRIVATE_KEY = privateKey('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
const RECEIPT_PUBLIC_KEY = createPublicKey(privateKey('bb'.repeat(32)))

interface StopResult {
  readonly status: 'stopped'
  readonly executionCommandCount: number
  readonly offlineReceiptCount: number
  readonly simulatorEffectCount: number
}

describe('ExecutionGrpcTransport PAPER_LOCAL Node-Python UDS integration', () => {
  if (gateMode && !python) {
    it('fails synchronously when D1 gate did not supply the runtime Python', () => {
      throw new Error('d1_release_gate_runtime_python_missing')
    })
  }

  offlineIt('persists and replays one signed local-only simulator receipt across restart', async () => {
    const temporary = await mkdtemp('/private/tmp/oa-local-uds-')
    await chmod(temporary, 0o700)
    const paths = {
      socketPath: resolve(temporary, 'sidecar.sock'), ledgerPath: resolve(temporary, 'ledger.sqlite3'),
      simulatorPath: resolve(temporary, 'simulator.sqlite3'), resultPath: resolve(temporary, 'stop-result.json'),
    }
    const item = paperLocalItem()
    const request = requestFor(item)
    let first: ChildProcess | undefined
    let second: ChildProcess | undefined
    let transport: ExecutionGrpcTransport | undefined
    try {
      first = startServer(paths)
      await waitForReady(first, paths.socketPath, 5_000)
      transport = new ExecutionGrpcTransport({ socketPath: paths.socketPath, rpcDeadlineMs: 1_500 })
      await expect(transport.verifyReady(expectedIdentity())).resolves.toMatchObject({
        mode: 'PAPER_LOCAL', runId: RUN_ID, environmentProofHash: PROOF_HASH,
        schemaHash: SCHEMA_HASH, writerEpoch: '1', latestSequence: '0',
      })
      await expect(transport.execute(request, { signal: new AbortController().signal })).resolves.toEqual({
        commandId: item.command.commandId, disposition: 'accepted', acceptedSequence: '1',
      })
      await expect(transport.execute(request, { signal: new AbortController().signal })).resolves.toEqual({
        commandId: item.command.commandId, disposition: 'duplicate', acceptedSequence: '1',
      })
      const evidence = await waitForEvidence(transport, item.command.commandId, 5_000)
      expect(evidence.event.evidenceReceiptId).toMatch(/^[a-f0-9]{64}$/)
      const receipt = await transport.getOfflineExecutionReceipt({
        receiptId: evidence.event.evidenceReceiptId,
        trustPolicy: receiptTrustPolicy(), expected: expectedReceipt(item, evidence.event.sequence),
        now: new Date('2026-08-15T00:00:02.000Z'),
      })
      expect(receipt).toMatchObject({
        found: true, finalizationEligible: false,
        receipt: { receiptId: evidence.event.evidenceReceiptId, commandId: item.command.commandId },
        lifecycleEvent: evidence.event,
      })
      transport.close()
      transport = undefined
      await stopWithSigterm(first, 3_000)
      first = undefined
      expect(await readStopResult(paths.resultPath)).toEqual({
        status: 'stopped', executionCommandCount: 1, offlineReceiptCount: 1, simulatorEffectCount: 1,
      })

      second = startServer(paths)
      await waitForReady(second, paths.socketPath, 5_000)
      transport = new ExecutionGrpcTransport({ socketPath: paths.socketPath, rpcDeadlineMs: 1_500 })
      await transport.verifyReady(expectedIdentity())
      const replayed = await transport.replayEvents({ afterSequence: '0', limit: 10 })
      const restartedEvidence = replayed.find(event => event.schemaVersion === 'openalice_execution_event.v2')
      expect(restartedEvidence).toEqual(evidence.event)
      const restartedReceipt = await transport.getOfflineExecutionReceipt({
        receiptId: evidence.event.evidenceReceiptId,
        trustPolicy: receiptTrustPolicy(), expected: expectedReceipt(item, evidence.event.sequence),
        now: new Date('2026-08-15T00:00:02.000Z'),
      })
      expect(restartedReceipt).toMatchObject({ found: true, finalizationEligible: false })
      await expect(transport.execute(request, { signal: new AbortController().signal })).resolves.toEqual({
        commandId: item.command.commandId, disposition: 'duplicate', acceptedSequence: '1',
      })
      transport.close()
      transport = undefined
      await stopWithSigterm(second, 3_000)
      second = undefined
      expect(await readStopResult(paths.resultPath)).toEqual({
        status: 'stopped', executionCommandCount: 1, offlineReceiptCount: 1, simulatorEffectCount: 1,
      })
    } finally {
      transport?.close()
      if (first) await stopWithSigterm(first, 3_000)
      if (second) await stopWithSigterm(second, 3_000)
      await rm(temporary, { recursive: true, force: true })
    }
  }, 20_000)

  offlineIt('keeps an old missing-effect dispatch read-only without a Node-side write', async () => {
    const temporary = await mkdtemp('/private/tmp/oa-local-uds-readonly-')
    await chmod(temporary, 0o700)
    const paths = {
      socketPath: resolve(temporary, 'sidecar.sock'), ledgerPath: resolve(temporary, 'ledger.sqlite3'),
      simulatorPath: resolve(temporary, 'simulator.sqlite3'), resultPath: resolve(temporary, 'stop-result.json'),
    }
    let child: ChildProcess | undefined
    let transport: ExecutionGrpcTransport | undefined
    try {
      child = startServer(paths, { seedMissingEffect: true })
      const ready = await waitForReady(child, paths.socketPath, 5_000)
      expect(ready.seedCommandId).toMatch(/^[a-f0-9]{64}$/)
      transport = new ExecutionGrpcTransport({ socketPath: paths.socketPath, rpcDeadlineMs: 1_500 })
      await expect(transport.verifyReady(expectedIdentity())).rejects.toThrow()
      await expect(transport.verifyReadable(expectedIdentity())).resolves.toMatchObject({
        mode: 'PAPER_LOCAL', runId: RUN_ID, environmentProofHash: PROOF_HASH, schemaHash: SCHEMA_HASH,
        writerEpoch: '2',
      })
      await expect(transport.getCommand(ready.seedCommandId!)).resolves.toMatchObject({ found: true, commandId: ready.seedCommandId })
      await expect(transport.execute(requestFor(paperLocalItem()), { signal: new AbortController().signal }))
        .rejects.toThrow('execution_grpc_ready_not_verified')
      await expect(transport.getOfflineExecutionReceipt({
        receiptId: 'f'.repeat(64), trustPolicy: receiptTrustPolicy(),
        expected: expectedReceipt(paperLocalItem(), '2'), now: new Date('2026-08-15T00:00:02.000Z'),
      })).resolves.toEqual({ found: false })
      transport.close()
      transport = undefined
      await stopWithSigterm(child, 3_000)
      child = undefined
      expect(await readStopResult(paths.resultPath)).toEqual({
        status: 'stopped', executionCommandCount: 1, offlineReceiptCount: 0, simulatorEffectCount: 0,
      })
    } finally {
      transport?.close()
      if (child) await stopWithSigterm(child, 3_000)
      await rm(temporary, { recursive: true, force: true })
    }
  }, 15_000)
})

function privateKey(seedHex: string) {
  return createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seedHex}`, 'hex'), format: 'der', type: 'pkcs8' })
}

function expectedIdentity() {
  return { clientId: 'openalice.paper-local-node-python-test', mode: 'PAPER_LOCAL' as const,
    runId: RUN_ID, environmentProofHash: PROOF_HASH, schemaHash: SCHEMA_HASH }
}

function paperLocalItem(): { command: ExecutionCommandV1, permit: ExecutionPermitV2 } {
  const idempotencyKey = 'paper-local-uds-node-python-1'
  const command = buildExecutionCommandV1({
    schemaVersion: 'openalice_execution_command_payload.v1', accountId: 'paper-main', canonicalSymbol: 'BTC/USDT',
    venue: 'OKX', venueInstrumentId: 'BTC-USDT', idempotencyKey, mode: 'PAPER_LOCAL', kind: 'submit',
    clientOrderId: deriveOkxClientOrderId(idempotencyKey), side: 'buy', orderType: 'limit', quantity: '0.0005',
    price: '100000.5', timeInForce: 'GTC', reduceOnly: false, maxNotionalUsd: '50.00025',
  })
  const core = {
    schemaVersion: 'openalice_execution_permit.v2' as const, decisionId: '5'.repeat(64), candidateId: 'paper-local-uds',
    intentId: idempotencyKey, ticketId: 'ticket-local-uds', commandHash: command.commandId, action: 'submit' as const,
    authorityAction: 'open' as const, riskReducing: false as const, scope: 'paper_only' as const,
    accountId: command.payload.accountId, canonicalSymbol: command.payload.canonicalSymbol,
    venueInstrumentId: command.payload.venueInstrumentId, idempotencyKey, side: 'buy' as const,
    authorizedNotionalUsd: '50.00025', mode: 'PAPER_LOCAL' as const, sourceCommit: '6'.repeat(40),
    releaseManifestHash: '7'.repeat(64), authoritySnapshotHash: '8'.repeat(64), requiredChecks: ['offline_contract_test'],
    approvalRefs: [], issuedAt: '2026-08-15T00:00:00.000Z', expiresAt: '2026-08-15T00:00:30.000Z', keyId: 'rfc8032-test-1',
  }
  const permitId = executionPermitV2Id(core)
  const unsigned = { ...core, permitId }
  return { command, permit: { ...unsigned, signature: sign(null, Buffer.from(stableStringify(unsigned), 'utf8'), PERMIT_PRIVATE_KEY).toString('base64') } }
}

function requestFor(item: { command: ExecutionCommandV1, permit: ExecutionPermitV2 }): ExecutionSidecarTransportRequest {
  return { command: item.command, permit: item.permit,
    canonicalPayloadJsonUtf8: Buffer.from(stableStringify(item.command.payload), 'utf8'),
    permitJsonUtf8: Buffer.from(stableStringify(item.permit), 'utf8') }
}

function receiptTrustPolicy(): OfflineExecutionReceiptTrustPolicy {
  return {
    keyId: 'offline-receipt-test-key', adapterId: 'openalice.offline-simulator', adapterBuildHash: '1'.repeat(64),
    adapterConfigHash: '2'.repeat(64), adapterRunId: RUN_ID, permitAuthorityKeyIds: ['rfc8032-test-1'],
    permitAuthorityPublicKeyFingerprints: [ed25519PublicKeyFingerprintSha256(createPublicKey(PERMIT_PRIVATE_KEY))],
    publicKey: RECEIPT_PUBLIC_KEY,
  }
}

function expectedReceipt(item: { command: ExecutionCommandV1, permit: ExecutionPermitV2 }, lifecycleSequence: string): OfflineExecutionReceiptExpectedBinding {
  const attemptId = deriveOfflineExecutionAttemptId({ commandId: item.command.commandId,
    adapterId: 'openalice.offline-simulator', adapterRunId: RUN_ID, adapterEpoch: '1', attemptNumber: '1' })
  return {
    commandId: item.command.commandId, payloadHash: item.command.commandId, permitV2Id: item.permit.permitId,
    permitKeyId: 'rfc8032-test-1', acceptedSequence: '1', lifecycleSequence, lifecycleKind: 'submitted',
    adapterEpoch: '1', attemptId, attemptNumber: '1', sourceNamespaceId: '3'.repeat(64), sourceSequence: '1',
    transitionNumber: '1', previousReceiptId: undefined, idempotencyKey: item.command.payload.idempotencyKey,
    accountId: 'paper-main', canonicalSymbol: 'BTC/USDT', venue: 'OKX', venueInstrumentId: 'BTC-USDT',
    mode: 'PAPER_LOCAL', clientOrderId: deriveOkxClientOrderId(item.command.payload.idempotencyKey), side: 'buy',
    orderType: 'limit', timeInForce: 'GTC', reduceOnly: false, quantity: '0.0005', price: '100000.5', maxNotionalUsd: '50.00025',
  }
}

async function waitForEvidence(transport: ExecutionGrpcTransport, commandId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const events = await transport.replayEvents({ afterSequence: '0', limit: 10 })
    const event = events.find(candidate => candidate.schemaVersion === 'openalice_execution_event.v2'
      && candidate.commandId === commandId && candidate.evidenceReceiptId !== undefined)
    if (event?.schemaVersion === 'openalice_execution_event.v2' && event.evidenceReceiptId) return { event }
    if (Date.now() >= deadline) throw new Error('offline_evidence_receipt_timeout')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
}

function startServer(
  paths: { socketPath: string, ledgerPath: string, simulatorPath: string, resultPath: string },
  options: { seedMissingEffect?: boolean } = {},
): ChildProcess {
  return spawn(python!, ['-m', 'sidecars.nautilus_paper.uds_offline_contract_test_server', '--socket-path', paths.socketPath,
    '--sqlite-path', paths.ledgerPath, '--simulator-path', paths.simulatorPath, '--result-path', paths.resultPath,
    ...(options.seedMissingEffect ? ['--seed-missing-effect'] : [])], {
    cwd: repositoryRoot,
    // Do not inherit any broker/provider credential-bearing parent environment.
    // Keep the integration child credential-free and independent from a
    // machine-specific site-packages location. The supplied interpreter owns
    // its dependencies; this path only exposes the checked-out sidecar code.
    env: { OPENALICE_UDS_CONTRACT_TEST_ONLY: '1', PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: repositoryRoot, PATH: '/usr/bin:/bin', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function waitForReady(
  child: ChildProcess, socketPath: string, timeoutMs: number,
): Promise<{ seedCommandId?: string }> {
  const stdout = child.stdout
  const stderr = child.stderr
  if (!stdout || !stderr) return Promise.reject(new Error('sidecar_stdio_missing'))
  return new Promise((resolveReady, rejectReady) => {
    let output = ''; let errors = ''
    const timeout = setTimeout(() => finish(() => rejectReady(new Error(`sidecar_ready_timeout:${errors}`))), timeoutMs)
    const finish = (complete: () => void) => { clearTimeout(timeout); stdout.off('data', onData); stderr.off('data', onError); child.off('error', onChildError); child.off('exit', onExit); complete() }
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8'); const newline = output.indexOf('\n'); if (newline < 0) return
      try { const ready = JSON.parse(output.slice(0, newline)) as { status?: unknown, socketPath?: unknown, seedCommandId?: unknown }
        if (ready.status !== 'ready' || ready.socketPath !== socketPath) throw new Error('sidecar_ready_payload_invalid')
        const seedCommandId = typeof ready.seedCommandId === 'string' ? ready.seedCommandId : undefined
        finish(() => resolveReady({ ...(seedCommandId ? { seedCommandId } : {}) }))
      } catch (error) { finish(() => rejectReady(error)) }
    }
    const onError = (chunk: Buffer) => { errors += chunk.toString('utf8') }
    const onChildError = (error: Error) => finish(() => rejectReady(error))
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(() => rejectReady(new Error(`sidecar_exited_before_ready:${code ?? 'null'}:${signal ?? 'none'}:${errors}`)))
    stdout.on('data', onData); stderr.on('data', onError); child.once('error', onChildError); child.once('exit', onExit)
  })
}

async function stopWithSigterm(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('sidecar_sigterm_timeout')), timeoutMs)
    child.once('error', error => { clearTimeout(timeout); rejectExit(error) })
    child.once('exit', (code, signal) => { clearTimeout(timeout); if (code === 0 && signal === null) resolveExit(); else rejectExit(new Error(`sidecar_exit_invalid:${code ?? 'null'}:${signal ?? 'none'}`)) })
    child.kill('SIGTERM')
  })
}

async function readStopResult(path: string): Promise<StopResult> {
  return JSON.parse(await readFile(path, 'utf8')) as StopResult
}
