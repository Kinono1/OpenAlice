import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('cron_external_derivatives_data_collect.sh', () => {
  it('delegates overlap handling to the internal collector lock and preserves stdout report visibility', async () => {
    const script = await readFile('scripts/cron_external_derivatives_data_collect.sh', 'utf-8')

    expect(script).not.toContain('external_derivatives_data_collect.lock')
    expect(script).not.toMatch(/mkdir\s+"\$LOCK_DIR"/)
    expect(script).toContain('external_derivatives_data_collect.current.stdout.json')
    expect(script).toContain('./node_modules/.bin/tsx scripts/collect_external_derivatives_data.ts "${COLLECT_ARGS[@]}" > "$REPORT_STDOUT_PATH"')
    expect(script).toContain('date -u +%Y-%m-%dT%H:%M:%SZ')
    expect(script).toContain('OPENALICE_EXTERNAL_OUTPUT_PATH')
    expect(script).toContain('OPENALICE_EXTERNAL_REPORT_PATH')
    expect(script).toContain('OPENALICE_EXTERNAL_RUN_LEDGER_PATH')
    expect(script).toContain('OPENALICE_EXTERNAL_COLLECTOR_LOCK_DIR')
    expect(script).toContain('JSON.parse(readFileSync(stdoutReportPath')
    expect(script).toContain('stdoutLatestMismatch')
    expect(script).toContain('external_derivatives_data_collect.latest.json.manifest.json')
    expect(script).toContain('evidenceTrust')
    expect(script).toContain('trustNeedsReview')
    expect(script).toContain("evidenceTrust=${evidenceTrust ?? 'unknown'}")
    expect(script).not.toMatch(/\b(placeOrder|createOrder|submitOrder|executeTrade|dispatchOrder|enableCryptoDispatcher)\b/)
  })

  it('writes a review notification when the collector report contains endpoint errors', async () => {
    const { notification, exitCode } = await runWrapperWithCollectorOutput({
      collectorExitCode: 1,
      collectorStdout: JSON.stringify({
        runId: 'external-test-errors',
        collectorLockStatus: 'acquired',
        errors: [{
          symbol: 'BTCUSDT',
          endpoint: 'fundingRate',
          errorClass: 'network',
          error: 'timeout',
        }],
        conflictingDuplicateRows: 0,
        fetchedRows: 0,
        persistedRows: 0,
        previousReportStale: false,
        endpointDiagnostics: [{ attempts: 2 }],
        baseUrl: 'https://fapi.binance.com',
        proxyConfigured: false,
      }),
    })

    expect(exitCode).toBe(1)
    expect(notification).toMatchObject({
      shouldNotify: true,
      deliveryDecision: 'notify',
      headline: 'external derivatives collect needs review',
    })
    expect(notification.content).toContain('runId=external-test-errors')
    expect(notification.content).toContain('latestRunId=external-test-errors')
    expect(notification.content).toContain('stdoutLatestMismatch=false')
    expect(notification.content).toContain('exitCode=1')
    expect(notification.content).toContain('errors=1')
    expect(notification.content).toContain('firstError=BTCUSDT/fundingRate:network:timeout')
  })

  it('writes a review notification when a successful run fetches zero rows', async () => {
    const { notification, exitCode } = await runWrapperWithCollectorOutput({
      collectorExitCode: 0,
      collectorStdout: JSON.stringify({
        runId: 'external-test-zero-rows',
        collectorLockStatus: 'acquired',
        errors: [],
        conflictingDuplicateRows: 0,
        fetchedRows: 0,
        persistedRows: 0,
        previousReportStale: false,
        endpointDiagnostics: [{ attempts: 1 }],
        baseUrl: 'https://fapi.binance.com',
        proxyConfigured: false,
      }),
    })

    expect(exitCode).toBe(0)
    expect(notification).toMatchObject({
      shouldNotify: true,
      deliveryDecision: 'notify',
      headline: 'external derivatives collect needs review',
    })
    expect(notification.content).toContain('runId=external-test-zero-rows')
    expect(notification.content).toContain('fetchedRows=0')
  })

  it('uses the latest manifest to notify when evidence trust is quarantined', async () => {
    const { notification, exitCode } = await runWrapperWithCollectorOutput({
      collectorExitCode: 0,
      collectorStdout: JSON.stringify({
        runId: 'external-test-quarantine',
        collectorLockStatus: 'acquired',
        errors: [],
        conflictingDuplicateRows: 0,
        fetchedRows: 20,
        persistedRows: 14,
        previousReportStale: false,
        endpointDiagnostics: [{ attempts: 1 }],
        baseUrl: 'https://fapi.binance.com',
        proxyConfigured: false,
      }),
      manifest: {
        evidenceTrust: 'quarantine',
        dqStatus: 'quarantine',
        git: { dirty: true, dirtyFilesCount: 626 },
      },
    })

    expect(exitCode).toBe(0)
    expect(notification).toMatchObject({
      shouldNotify: true,
      deliveryDecision: 'notify',
      headline: 'external derivatives collect needs review',
    })
    expect(notification.content).toContain('runId=external-test-quarantine')
    expect(notification.content).toContain('evidenceTrust=quarantine')
    expect(notification.content).toContain('dqStatus=quarantine')
    expect(notification.content).toContain('gitDirty=true')
    expect(notification.content).toContain('gitDirtyFilesCount=626')
  })

  it('notifies when stdout and latest report runIds diverge', async () => {
    const { notification, exitCode } = await runWrapperWithCollectorOutput({
      collectorExitCode: 0,
      collectorStdout: JSON.stringify({
        runId: 'external-test-stdout',
        collectorLockStatus: 'acquired',
        errors: [],
        conflictingDuplicateRows: 0,
        fetchedRows: 20,
        persistedRows: 14,
        previousReportStale: false,
        endpointDiagnostics: [{ attempts: 1 }],
        baseUrl: 'https://fapi.binance.com',
        proxyConfigured: false,
      }),
      latestReport: {
        runId: 'external-test-latest',
      },
      manifest: {
        evidenceTrust: 'pass',
        dqStatus: 'pass',
        git: { dirty: false, dirtyFilesCount: 0 },
      },
    })

    expect(exitCode).toBe(0)
    expect(notification).toMatchObject({
      shouldNotify: true,
      deliveryDecision: 'notify',
      headline: 'external derivatives collect needs review',
    })
    expect(notification.content).toContain('runId=external-test-stdout')
    expect(notification.content).toContain('latestRunId=external-test-latest')
    expect(notification.content).toContain('stdoutRunId=external-test-stdout')
    expect(notification.content).toContain('stdoutLatestMismatch=true')
  })

  it('writes a notification when both stdout and latest reports are unreadable', async () => {
    const { notification, exitCode } = await runWrapperWithCollectorOutput({
      collectorExitCode: 0,
      collectorStdout: 'not-json',
    })

    expect(exitCode).toBe(0)
    expect(notification).toMatchObject({
      shouldNotify: true,
      deliveryDecision: 'notify',
      headline: 'external derivatives collect report missing or unreadable',
    })
    expect(String(notification.content)).toMatch(/ENOENT|Unexpected/)
  })

  it('passes optional output/report/ledger/lock path overrides through to the collector', async () => {
    const { collectorInvocation, exitCode } = await runWrapperWithCollectorOutput({
      collectorExitCode: 0,
      collectorStdout: JSON.stringify({
        runId: 'external-test-env-paths',
        collectorLockStatus: 'acquired',
        errors: [],
        conflictingDuplicateRows: 0,
        fetchedRows: 20,
        persistedRows: 14,
        previousReportStale: false,
        endpointDiagnostics: [{ attempts: 1 }],
        baseUrl: 'https://fapi.binance.com',
        proxyConfigured: false,
      }),
      env: {
        OPENALICE_EXTERNAL_OUTPUT_PATH: '/tmp/oa-external/events.jsonl',
        OPENALICE_EXTERNAL_REPORT_PATH: '/tmp/oa-external/latest.json',
        OPENALICE_EXTERNAL_RUN_LEDGER_PATH: '/tmp/oa-external/runs.jsonl',
        OPENALICE_EXTERNAL_COLLECTOR_LOCK_DIR: '/tmp/oa-external/lock',
      },
    })

    expect(exitCode).toBe(0)
    expect(collectorInvocation).toEqual(expect.arrayContaining([
      '--outputPath',
      '/tmp/oa-external/events.jsonl',
      '--reportPath',
      '/tmp/oa-external/latest.json',
      '--runLedgerPath',
      '/tmp/oa-external/runs.jsonl',
      '--collectorLockDir',
      '/tmp/oa-external/lock',
    ]))
  })
})

async function runWrapperWithCollectorOutput(input: {
  collectorStdout: string
  collectorExitCode: number
  manifest?: unknown
  latestReport?: unknown
  env?: NodeJS.ProcessEnv
}): Promise<{ exitCode: number; notification: Record<string, unknown>; collectorInvocation: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'oa-external-cron-'))
  const scriptsDir = join(root, 'scripts')
  const binDir = join(root, 'bin')
  const runtimeDir = join(root, 'data', 'runtime')
  await mkdir(scriptsDir, { recursive: true })
  await mkdir(binDir, { recursive: true })
  await mkdir(runtimeDir, { recursive: true })

  const script = await readFile('scripts/cron_external_derivatives_data_collect.sh', 'utf-8')
  const scriptPath = join(scriptsDir, 'cron_external_derivatives_data_collect.sh')
  await writeFile(scriptPath, script, 'utf-8')
  await chmod(scriptPath, 0o755)
  await writeFile(join(scriptsDir, 'openalice_env.sh'), '#!/usr/bin/env bash\n', 'utf-8')

  const tsxPath = join(root, 'node_modules', '.bin', 'tsx')
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
  await writeFile(tsxPath, [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$OPENALICE_TEST_COLLECTOR_INVOCATION_PATH"',
    'cat "$OPENALICE_TEST_COLLECTOR_STDOUT_PATH"',
    'exit "$OPENALICE_TEST_COLLECTOR_EXIT_CODE"',
    '',
  ].join('\n'), 'utf-8')
  await chmod(tsxPath, 0o755)

  const collectorStdoutPath = join(root, 'collector_stdout.json')
  const collectorInvocationPath = join(root, 'collector_invocation.txt')
  await writeFile(collectorStdoutPath, input.collectorStdout, 'utf-8')
  if (input.manifest !== undefined) {
    await writeFile(
      join(runtimeDir, 'external_derivatives_data_collect.latest.json.manifest.json'),
      `${JSON.stringify(input.manifest)}\n`,
      'utf-8',
    )
  }
  const latestReport = input.latestReport ?? tryParseJson(input.collectorStdout)
  if (latestReport !== null) {
    await writeFile(
      join(runtimeDir, 'external_derivatives_data_collect.latest.json'),
      `${JSON.stringify(latestReport)}\n`,
      'utf-8',
    )
  }

  const exitCode = await runScript(scriptPath, {
    ...process.env,
    ...input.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OPENALICE_TEST_COLLECTOR_STDOUT_PATH: collectorStdoutPath,
    OPENALICE_TEST_COLLECTOR_INVOCATION_PATH: collectorInvocationPath,
    OPENALICE_TEST_COLLECTOR_EXIT_CODE: String(input.collectorExitCode),
  })
  const notification = JSON.parse(await readFile(
    join(runtimeDir, 'external_derivatives_data_collect_notification.json'),
    'utf-8',
  )) as Record<string, unknown>
  const collectorInvocation = (await readFile(collectorInvocationPath, 'utf-8'))
    .split('\n')
    .filter(Boolean)
  return { exitCode, notification, collectorInvocation }
}

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function runScript(path: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.on('error', reject)
    child.on('close', code => resolve(code ?? 1))
  })
}
