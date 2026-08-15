import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stableStringify } from './contracts.js'
import type { ExecutionCommandV1, ExecutionPermitV2 } from '../domain/trading/execution-protocol.js'
import type { ExecutionSidecarTransportRequest } from '../domain/trading/execution-sidecar-writer.js'
import { ExecutionGrpcTransport } from './execution-grpc-transport.js'

const python = process.env.OPENALICE_SIDECAR_TEST_PYTHON?.trim()
const contractIt = python ? it : it.skip
const gateMode = process.env.OPENALICE_D1_RELEASE_GATE === '1'
const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(here, 'fixtures/openalice_execution_contract_v1.json')
const TEST_RUN_ID = 'paper-grpc-contract-test-run'
const TEST_SCHEMA_HASH = 'a'.repeat(64)
const TEST_PROOF_HASH = createHash('sha256').update(stableStringify({
  configDigest: 'b'.repeat(64),
  credentialClass: 'demo_only',
  endpointClass: 'okx_demo',
  executionClientRegistered: true,
  expiresAt: '2026-08-15T00:01:01.000Z',
  liveExecutionArmed: false,
  liveTradingAllowed: false,
  mode: 'PAPER_EXCHANGE',
  observedAt: '2026-08-15T00:00:00.000Z',
  paperOnly: true,
  runId: TEST_RUN_ID,
  schemaHash: TEST_SCHEMA_HASH,
  schemaVersion: 'openalice_paper_environment_proof.v1',
  venue: 'OKX',
}), 'utf8').digest('hex')

interface ContractFixture {
  command: ExecutionCommandV1
  permit: ExecutionPermitV2
}

interface StopResult {
  status: string
  executionCommandCount: number
  latestCursor: number
}

describe('ExecutionGrpcTransport Node-Python UDS contract', () => {
  if (gateMode && !python) {
    it('fails synchronously when D1 gate did not supply the runtime Python', () => {
      throw new Error('d1_release_gate_runtime_python_missing')
    })
  }

  contractIt('accepts once, returns the full command, and replays/streams one acknowledged event', async () => {
    const temporary = await mkdtemp('/private/tmp/oa-uds-')
    const socketPath = resolve(temporary, 'sidecar.sock')
    const sqlitePath = resolve(temporary, 'ledger.sqlite3')
    const resultPath = resolve(temporary, 'stop-result.json')
    let child: ChildProcess | undefined
    let transport: ExecutionGrpcTransport | undefined
    try {
      const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as ContractFixture
      const request: ExecutionSidecarTransportRequest = {
        command: fixture.command,
        permit: fixture.permit,
        canonicalPayloadJsonUtf8: Buffer.from(stableStringify(fixture.command.payload), 'utf8'),
        permitJsonUtf8: Buffer.from(stableStringify(fixture.permit), 'utf8'),
      }
      // These are the canonical bytes passed directly to the native gRPC client.
      expect(Buffer.from(request.canonicalPayloadJsonUtf8).toString('utf8'))
        .toBe(stableStringify(fixture.command.payload))
      expect(Buffer.from(request.permitJsonUtf8).toString('utf8')).toBe(stableStringify(fixture.permit))

      const started = spawn(python!, [
        '-m', 'sidecars.nautilus_paper.uds_contract_test_server',
        '--socket-path', socketPath,
        '--sqlite-path', sqlitePath,
        '--result-path', resultPath,
        '--fixture-path', fixturePath,
      ], {
        cwd: resolve(here, '../..'),
        // Do not propagate the parent process environment (which may contain
        // broker or provider credentials) into this fixture-only child.
        env: {
          OPENALICE_UDS_CONTRACT_TEST_ONLY: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          // The child receives only the repository import root and a tiny,
          // credential-free execution environment.  Its interpreter is the
          // gate-provided runtime Python, never a discovered test Python.
          PYTHONPATH: resolve(here, '../..'),
          PATH: '/usr/bin:/bin',
          LANG: 'C',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child = started
      await waitForReady(started, socketPath, 5_000)

      transport = new ExecutionGrpcTransport({ socketPath, rpcDeadlineMs: 1_500 })
      await expect(transport.verifyReady({
        clientId: 'openalice.node-python-uds-test',
        mode: 'PAPER_EXCHANGE',
        runId: TEST_RUN_ID,
        environmentProofHash: TEST_PROOF_HASH,
        schemaHash: TEST_SCHEMA_HASH,
      })).resolves.toMatchObject({
        writerEpoch: '1',
        latestSequence: '0',
      })
      const accepted = await transport.execute(request, { signal: new AbortController().signal })
      expect(accepted).toEqual({
        commandId: fixture.command.commandId,
        disposition: 'accepted',
        acceptedSequence: '1',
      })
      const duplicate = await transport.execute(request, { signal: new AbortController().signal })
      expect(duplicate).toEqual({
        commandId: fixture.command.commandId,
        disposition: 'duplicate',
        acceptedSequence: '1',
      })
      await expect(transport.getCommand(fixture.command.commandId)).resolves.toEqual({
        found: true,
        command: fixture.command,
        commandId: fixture.command.commandId,
        disposition: 'accepted',
        acceptedSequence: '1',
        permitV2Id: fixture.permit.permitId,
        clientOrderId: fixture.command.payload.kind === 'submit'
          ? fixture.command.payload.clientOrderId
          : undefined,
      })
      await expect(transport.getSnapshot({
        accountId: fixture.command.payload.accountId,
        canonicalSymbol: fixture.command.payload.canonicalSymbol,
      })).resolves.toEqual({ found: false })

      const replayed = await transport.replayEvents({ afterSequence: '0', limit: 10 })
      expect(replayed).toHaveLength(1)
      expect(replayed[0]).toMatchObject({
        schemaVersion: 'openalice_execution_event.v1',
        commandId: fixture.command.commandId,
        sequence: '1',
        kind: 'acknowledged',
        clientOrderId: fixture.command.payload.kind === 'submit'
          ? fixture.command.payload.clientOrderId
          : undefined,
      })

      const streamController = new AbortController()
      const streamIterator = transport.streamEvents(
        { afterSequence: '0' },
        { signal: streamController.signal },
      )[Symbol.asyncIterator]()
      await expect(streamIterator.next()).resolves.toEqual({
        done: false,
        value: replayed[0],
      })
      await streamIterator.return?.()
      transport.close()
      transport = undefined

      await stopWithSigterm(started, 3_000)
      child = undefined
      const stopped = JSON.parse(await readFile(resultPath, 'utf8')) as StopResult
      expect(stopped).toEqual({ status: 'stopped', executionCommandCount: 1, latestCursor: 1 })
    } finally {
      transport?.close()
      if (child) await stopWithSigterm(child, 3_000)
      await rm(temporary, { recursive: true, force: true })
    }
  }, 15_000)
})

function waitForReady(child: ChildProcess, expectedSocketPath: string, timeoutMs: number): Promise<void> {
  const stdout = child.stdout
  const stderr = child.stderr
  if (!stdout || !stderr) return Promise.reject(new Error('sidecar_stdio_missing'))
  return new Promise((resolveReady, rejectReady) => {
    let output = ''
    let errors = ''
    const timeout = setTimeout(() => finish(() => rejectReady(new Error(`sidecar_ready_timeout:${errors}`))), timeoutMs)
    const finish = (complete: () => void) => {
      clearTimeout(timeout)
      stdout.off('data', onData)
      stderr.off('data', onError)
      child.off('error', onChildError)
      child.off('exit', onExit)
      complete()
    }
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const lineEnd = output.indexOf('\n')
      if (lineEnd < 0) return
      try {
        const ready = JSON.parse(output.slice(0, lineEnd)) as { status?: unknown, socketPath?: unknown }
        if (ready.status !== 'ready' || ready.socketPath !== expectedSocketPath) {
          finish(() => rejectReady(new Error('sidecar_ready_payload_invalid')))
          return
        }
        finish(resolveReady)
      } catch {
        finish(() => rejectReady(new Error('sidecar_ready_payload_invalid')))
      }
    }
    const onError = (chunk: Buffer) => { errors += chunk.toString('utf8') }
    const onChildError = (error: Error) => finish(() => rejectReady(error))
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => rejectReady(new Error(`sidecar_exited_before_ready:${code ?? 'null'}:${signal ?? 'none'}:${errors}`)))
    }
    stdout.on('data', onData)
    stderr.on('data', onError)
    child.once('error', onChildError)
    child.once('exit', onExit)
  })
}

async function stopWithSigterm(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('sidecar_sigterm_timeout')), timeoutMs)
    child.once('error', error => { clearTimeout(timeout); rejectExit(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0 && signal === null) resolveExit()
      else rejectExit(new Error(`sidecar_exit_invalid:${code ?? 'null'}:${signal ?? 'none'}`))
    })
  })
  child.kill('SIGTERM')
  try {
    await exited
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    throw error
  }
}
