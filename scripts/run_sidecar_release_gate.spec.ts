import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadD1ReleaseGateBundle,
  loadValidationReceiptBinding,
} from '../src/runtime/release_manager.js'
import { runGateCommandForTest, runSidecarReleaseGate, type GateCommandResult } from './run_sidecar_release_gate.js'

const COMMIT = 'a'.repeat(40)
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('D1 sidecar release gate', () => {
  it('runs only the fixed local checks in order and writes bindable canonical pass receipts after all pass', async () => {
    const fixture = await createFixture()
    const calls: { argv: readonly string[], env: NodeJS.ProcessEnv }[] = []
    const run = async (argv: readonly string[], options: { cwd: string, env: NodeJS.ProcessEnv }): Promise<GateCommandResult> => {
      calls.push({ argv, env: options.env })
      if (argv[0] === '/usr/bin/git' && argv[1] === 'rev-parse') return result(`${COMMIT}\n`)
      if (argv[0] === '/usr/bin/git') return result()
      if (argv.some(value => value.endsWith('/verify_release_environment.py'))) {
        await writeFile(
          argument(argv, '--output'),
          `${JSON.stringify(environmentReceipt(argument(argv, '--expected-contract-sha256')))}\n`,
        )
      }
      return result('ok\n')
    }

    const paths = await runSidecarReleaseGate({ ...fixture, run, now: () => new Date('2026-08-15T00:00:00.000Z'), randomId: () => 'deterministic' })
    expect(calls.map(call => call.argv)).toEqual([
      ['/usr/bin/git', 'rev-parse', 'HEAD'],
      ['/usr/bin/git', 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      ['/opt/homebrew/bin/pnpm', 'typecheck'],
      [fixture.runtimePython, '-I', '-S', '-B', 'sidecars/nautilus_paper/verify_release_environment.py', '--contract', join(fixture.repoRoot, 'sidecars/nautilus_paper/release_runtime_contract.v1.json'), '--expected-contract-sha256', expect.any(String), '--release-root', fixture.repoRoot, '--trust-mode', 'release-gate', '--output', join(fixture.receiptDir, '.d1-release-gate-deterministic/d1.sidecar.environment.environment_receipt.v1.json')],
      [fixture.testPython, '-I', '-B', 'sidecars/nautilus_paper/generate_proto.py', '--check'],
      [fixture.testPython, '-B', '-m', 'pytest', '-p', 'no:cacheprovider', 'sidecars/nautilus_paper'],
      ['/opt/homebrew/bin/pnpm', 'test'],
      ['/opt/homebrew/bin/pnpm', 'exec', 'vitest', 'run', 'src/sidecar/execution-grpc-transport.integration.spec.ts', 'src/sidecar/execution-grpc-offline.integration.spec.ts'],
      ['/opt/homebrew/bin/pnpm', 'test:scripts', '--', 'scripts/run_sidecar_release_gate.spec.ts', 'scripts/launch_current_release.spec.ts', 'scripts/launch_nautilus_paper_release.spec.ts', 'scripts/manage_local_release.spec.ts', 'scripts/install_openalice_launchd.spec.ts', 'scripts/research_cutover.spec.ts', 'scripts/plan_paper_local_deployment.spec.ts'],
      ['/usr/bin/git', 'rev-parse', 'HEAD'],
      ['/usr/bin/git', 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
    ])
    expect(calls[5]!.env.PYTHONPATH).toBe(fixture.repoRoot)
    expect(calls[7]!.env).toMatchObject({ OPENALICE_D1_RELEASE_GATE: '1', OPENALICE_SIDECAR_TEST_PYTHON: fixture.runtimePython })
    expect(new Set(calls.map(call => call.env.PATH))).toEqual(
      new Set(['/opt/homebrew/bin:/usr/bin:/bin']),
    )
    expect(new Set(calls.map(call => call.env.HOME))).toEqual(new Set(['/var/empty']))
    expect(new Set(calls.map(call => call.env.TMPDIR))).toEqual(new Set(['/private/tmp']))
    const allArgs = calls.flatMap(call => call.argv)
    expect(allArgs.join(' ')).not.toMatch(/test:e2e|\be2e\b|broker|ccxt|publish|launchctl|\bcommit\b/)
    expect(allArgs).not.toContain('install')
    expect(allArgs).not.toContain('scripts/install_openalice_launchd.ts')
    expect(paths).toHaveLength(7)

    const expectedEnvironmentReceiptHash = JSON.parse(
      await readFile(paths[0]!, 'utf8'),
    ).environmentReceiptHash as string
    expect(expectedEnvironmentReceiptHash).toMatch(/^[a-f0-9]{64}$/)
    for (const path of paths) {
      const receipt = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      expect(receipt).toMatchObject({ schemaVersion: 'validation_receipt.v1', sourceCommit: COMMIT, dirtyStateHash: EMPTY_SHA256, sourceClean: true, status: 'pass', exitCode: 0 })
      expect(receipt.commandDigest).toBe(receipt.commandSha256)
      expect(receipt.environmentReceiptHash).toBe(expectedEnvironmentReceiptHash)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      await expect(loadValidationReceiptBinding({ path, sourceCommit: COMMIT, dirtyStateHash: EMPTY_SHA256, environmentReceiptHash: expectedEnvironmentReceiptHash, now: new Date('2026-08-15T00:01:00.000Z') })).resolves.toMatchObject({ status: 'pass' })
    }
    const environment = JSON.parse(await readFile(paths[1]!, 'utf8')) as { environmentReceiptHash?: unknown }
    expect(environment.environmentReceiptHash).toBeTypeOf('string')
    expect(JSON.parse(await readFile(paths[2]!, 'utf8'))).toMatchObject({ environmentReceiptHash: environment.environmentReceiptHash })
    expect(await readFile(join(dirname(paths[0]!), 'd1.sidecar.environment.environment_receipt.v1.json'), 'utf8')).toContain('"status":"pass"')
    expect(await readdir(fixture.receiptDir)).toEqual([`${COMMIT}.d1-release-gate`])
    expect(await readdir(dirname(paths[0]!))).toHaveLength(9)
    const bundle = JSON.parse(
      await readFile(join(dirname(paths[0]!), 'd1_release_bundle.v1.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(bundle).toMatchObject({
      schemaVersion: 'd1_release_bundle.v1',
      sourceCommit: COMMIT,
      dirtyStateHash: EMPTY_SHA256,
      expiresAt: '2026-08-15T00:15:00.000Z',
    })
    expect(bundle.bundleId).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.validationReceipts).toHaveLength(7)
    await expect(loadD1ReleaseGateBundle({
      bundleDir: dirname(paths[0]!),
      sourceCommit: COMMIT,
      dirtyStateHash: EMPTY_SHA256,
      now: new Date('2026-08-15T00:01:00.000Z'),
    })).resolves.toMatchObject({
      environment: { receipt: { status: 'pass' } },
      validationReceipts: { length: 7 },
    })
  })

  it('fails before checks and emits no receipt for a dirty source', async () => {
    const fixture = await createFixture()
    const calls: readonly string[][] = []
    await expect(runSidecarReleaseGate({ ...fixture, run: async argv => {
      ;(calls as string[][]).push([...argv])
      return argv[1] === 'rev-parse' ? result(`${COMMIT}\n`) : result(' M source.ts\0')
    } })).rejects.toThrow('d1_release_gate_requires_clean_source')
    expect(calls).toEqual([['/usr/bin/git', 'rev-parse', 'HEAD'], ['/usr/bin/git', 'status', '--porcelain=v1', '--untracked-files=all', '-z']])
    expect(await readdir(fixture.receiptDir)).toEqual([])
  })

  it('removes staged output and writes no partial pass receipts when a fixed check fails', async () => {
    const fixture = await createFixture()
    let count = 0
    await expect(runSidecarReleaseGate({ ...fixture, run: async argv => {
      count += 1
      if (argv[1] === 'rev-parse') return result(`${COMMIT}\n`)
      if (argv[0] === '/usr/bin/git') return result()
      if (argv[0] === '/opt/homebrew/bin/pnpm' && argv[1] === 'typecheck') return result('', 'type failure\n', 2)
      return result()
    }, randomId: () => 'failure' })).rejects.toThrow('d1_release_gate_check_failed:d1.typescript:2')
    expect(count).toBe(3)
    expect(await readdir(fixture.receiptDir)).toEqual([])
  })

  it('terminates a timed-out process and cannot turn the timeout into a pass result', async () => {
    const fixture = await createFixture()
    const result = await runGateCommandForTest(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      { cwd: fixture.repoRoot, env: { PATH: '/usr/bin:/bin', HOME: '/var/empty' } },
      50,
      50,
    )
    expect(result).toMatchObject({ exitCode: 124, timedOut: true })
  })

  it('writes no receipt when a fixed check reports a timeout', async () => {
    const fixture = await createFixture()
    await expect(runSidecarReleaseGate({
      ...fixture,
      run: async argv => {
        if (argv[1] === 'rev-parse') return result(`${COMMIT}\n`)
        if (argv[0] === '/usr/bin/git') return result()
        return { ...result(), exitCode: 124, timedOut: true }
      },
      randomId: () => 'timed-out-check',
    })).rejects.toThrow('d1_release_gate_check_timed_out:d1.typescript')
    expect(await readdir(fixture.receiptDir)).toEqual([])
  })

  it('rechecks HEAD and clean source after all checks before publishing receipts', async () => {
    const fixture = await createFixture()
    let statusCalls = 0
    await expect(runSidecarReleaseGate({ ...fixture, run: async argv => {
      if (argv[0] === '/usr/bin/git' && argv[1] === 'rev-parse') return result(`${COMMIT}\n`)
      if (argv[0] === '/usr/bin/git') {
        statusCalls += 1
        return statusCalls === 1 ? result() : result(' M changed.ts\0')
      }
      if (argv.some(value => value.endsWith('/verify_release_environment.py'))) {
        await writeFile(
          argument(argv, '--output'),
          `${JSON.stringify(environmentReceipt(argument(argv, '--expected-contract-sha256')))}\n`,
        )
      }
      return result('ok\n')
    }, randomId: () => 'final-drift' })).rejects.toThrow(
      'd1_release_gate_source_changed_during_checks',
    )
    expect(statusCalls).toBe(2)
    expect(await readdir(fixture.receiptDir)).toEqual([])
  })

  it('rejects missing, relative, identical, or externally overridden Python role inputs', async () => {
    const fixture = await createFixture()
    await expect(runSidecarReleaseGate({ ...fixture, environment: {} })).rejects.toThrow('OPENALICE_NAUTILUS_PYTHON_must_be_absolute')
    await expect(runSidecarReleaseGate({ ...fixture, environment: { OPENALICE_NAUTILUS_PYTHON: 'python', OPENALICE_NAUTILUS_TEST_PYTHON: fixture.testPython } })).rejects.toThrow('OPENALICE_NAUTILUS_PYTHON_must_be_absolute')
    await expect(runSidecarReleaseGate({ ...fixture, environment: { OPENALICE_NAUTILUS_PYTHON: fixture.runtimePython, OPENALICE_NAUTILUS_TEST_PYTHON: fixture.runtimePython } })).rejects.toThrow('python_roles_must_be_distinct')
    await expect(runSidecarReleaseGate({ ...fixture, environment: { OPENALICE_NAUTILUS_PYTHON: fixture.runtimePython, OPENALICE_NAUTILUS_TEST_PYTHON: fixture.testPython, OPENALICE_SIDECAR_TEST_PYTHON: fixture.testPython } })).rejects.toThrow('sidecar_python_override_forbidden')
  })

  it('fails closed rather than overwriting an existing receipt', async () => {
    const fixture = await createFixture()
    const bundle = join(fixture.receiptDir, `${COMMIT}.d1-release-gate`)
    await mkdir(bundle, { mode: 0o700 })
    const existingPath = join(bundle, 'd1.typescript.validation_receipt.v1.json')
    await writeFile(existingPath, 'existing\n', { mode: 0o600 })
    await expect(runSidecarReleaseGate({ ...fixture, run: async argv => argv[1] === 'rev-parse' ? result(`${COMMIT}\n`) : result() })).rejects.toThrow('d1_release_gate_receipt_exists')
    expect(await readFile(existingPath, 'utf8')).toBe('existing\n')
  })

  it('rejects an unfrozen or mismatched runtime before executing any D1 check', async () => {
    const fixture = await createFixture()
    const contractPath = join(
      fixture.repoRoot,
      'sidecars/nautilus_paper/release_runtime_contract.v1.json',
    )
    await writeFile(contractPath, '{"runtimeProvenance":{"baseRuntimeAggregate":null,"installedAggregate":null,"interpreterSha256":null,"pyvenvCfgSha256":null,"sitePackagesAggregate":null,"status":"unfrozen"}}\n')
    const calls: readonly string[][] = []
    await expect(runSidecarReleaseGate({ ...fixture, run: async argv => {
      ;(calls as string[][]).push([...argv])
      return argv[1] === 'rev-parse' ? result(`${COMMIT}\n`) : result()
    } })).rejects.toThrow('d1_release_gate_runtime_provenance_not_frozen')
    expect(calls).toEqual([
      ['/usr/bin/git', 'rev-parse', 'HEAD'],
      ['/usr/bin/git', 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
    ])
    expect(await readdir(fixture.receiptDir)).toEqual([])

    const interpreterHash = '0'.repeat(64)
    const configHash = createHash('sha256').update('home = /base\n').digest('hex')
    await writeFile(contractPath, `{"runtimeProvenance":{"baseRuntimeAggregate":"${'1'.repeat(64)}","installedAggregate":"${'1'.repeat(64)}","interpreterSha256":"${interpreterHash}","pyvenvCfgSha256":"${configHash}","sitePackagesAggregate":"${'1'.repeat(64)}","status":"frozen"}}\n`)
    await expect(runSidecarReleaseGate({ ...fixture, run: async argv => (
      argv[1] === 'rev-parse' ? result(`${COMMIT}\n`) : result()
    ) })).rejects.toThrow('d1_release_gate_runtime_interpreter_mismatch')
    expect(await readdir(fixture.receiptDir)).toEqual([])
  })

  it.each([
    ['base runtime byte drift', async (fixture: Awaited<ReturnType<typeof createFixture>>) => writeFile(join(fixture.baseRuntime, 'byte-drift'), 'changed\n'), 'd1_release_gate_runtime_base_runtime_aggregate_mismatch'],
    ['site-packages byte drift', async (fixture: Awaited<ReturnType<typeof createFixture>>) => writeFile(join(fixture.sitePackages, 'byte-drift'), 'changed\n'), 'd1_release_gate_runtime_site_packages_aggregate_mismatch'],
  ])('rejects %s before any candidate check can execute', async (_label, mutate, expected) => {
    const fixture = await createFixture()
    await mutate(fixture)
    const calls: readonly string[][] = []
    await expect(runSidecarReleaseGate({ ...fixture, run: async argv => {
      ;(calls as string[][]).push([...argv])
      return argv[1] === 'rev-parse' ? result(`${COMMIT}\n`) : result()
    } })).rejects.toThrow(expected)
    expect(calls).toEqual([
      ['/usr/bin/git', 'rev-parse', 'HEAD'],
      ['/usr/bin/git', 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
    ])
    expect(await readdir(fixture.receiptDir)).toEqual([])
  })

  it('uses the same UTF-8 and Unicode code-point aggregate contract for runtime paths', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.baseRuntime, 'é'), 'latin\n')
    await writeFile(join(fixture.baseRuntime, '\ue000'), 'private\n')
    await writeFile(join(fixture.baseRuntime, '😀'), 'astral\n')
    const contractPath = join(fixture.repoRoot, 'sidecars/nautilus_paper/release_runtime_contract.v1.json')
    const contract = JSON.parse(await readFile(contractPath, 'utf8')) as { runtimeProvenance: Record<string, string> }
    contract.runtimeProvenance.baseRuntimeAggregate = await treeAggregate(fixture.baseRuntime)
    await writeFile(contractPath, `${canonicalJson(contract)}\n`)
    const calls: readonly string[][] = []
    await expect(runSidecarReleaseGate({ ...fixture, run: async argv => {
      ;(calls as string[][]).push([...argv])
      if (argv[1] === 'rev-parse') return result(`${COMMIT}\n`)
      if (argv[0] === '/usr/bin/git') return result()
      if (argv.some(value => value.endsWith('/verify_release_environment.py'))) {
        await writeFile(argument(argv, '--output'), `${JSON.stringify(environmentReceipt(argument(argv, '--expected-contract-sha256')))}\n`)
      }
      return result('ok\n')
    }, randomId: () => 'unicode-paths' })).resolves.toHaveLength(7)
    expect(calls.some(argv => argv[0] === '/opt/homebrew/bin/pnpm' && argv[1] === 'typecheck')).toBe(true)
  })

  it('rejects an aggregate value that is not bound by the frozen contract before any candidate check', async () => {
    const fixture = await createFixture()
    const contractPath = join(fixture.repoRoot, 'sidecars/nautilus_paper/release_runtime_contract.v1.json')
    const contract = JSON.parse(await readFile(contractPath, 'utf8')) as { runtimeProvenance: Record<string, string> }
    contract.runtimeProvenance.baseRuntimeAggregate = '0'.repeat(64)
    await writeFile(contractPath, `${canonicalJson(contract)}\n`)
    const calls: readonly string[][] = []
    await expect(runSidecarReleaseGate({ ...fixture, run: async argv => {
      ;(calls as string[][]).push([...argv])
      return argv[1] === 'rev-parse' ? result(`${COMMIT}\n`) : result()
    } })).rejects.toThrow('d1_release_gate_runtime_base_runtime_aggregate_mismatch')
    expect(calls).toHaveLength(2)
  })

  it('reserves a source commit with O_EXCL so a concurrent gate executes zero checks', async () => {
    const fixture = await createFixture()
    let releaseFirstCheck: (() => void) | undefined
    let firstCheckStarted: (() => void) | undefined
    const firstCheckBarrier = new Promise<void>(resolve => { firstCheckStarted = resolve })
    const first = runSidecarReleaseGate({
      ...fixture,
      randomId: () => 'first',
      run: async argv => {
        if (argv[1] === 'rev-parse') return result(`${COMMIT}\n`)
        if (argv[0] === '/usr/bin/git') return result()
        if (argv[0] === '/opt/homebrew/bin/pnpm' && argv[1] === 'typecheck') {
          firstCheckStarted!()
          await new Promise<void>(resolve => { releaseFirstCheck = resolve })
        }
        if (argv.some(value => value.endsWith('/verify_release_environment.py'))) {
          await writeFile(argument(argv, '--output'), `${JSON.stringify(environmentReceipt(argument(argv, '--expected-contract-sha256')))}\n`)
        }
        return result('ok\n')
      },
    })
    await firstCheckBarrier
    const secondCalls: readonly string[][] = []
    await expect(runSidecarReleaseGate({ ...fixture, run: async argv => {
      ;(secondCalls as string[][]).push([...argv])
      return argv[1] === 'rev-parse' ? result(`${COMMIT}\n`) : result()
    } })).rejects.toThrow('d1_release_gate_bundle_reservation_exists')
    expect(secondCalls).toEqual([
      ['/usr/bin/git', 'rev-parse', 'HEAD'],
      ['/usr/bin/git', 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
    ])
    releaseFirstCheck!()
    await expect(first).resolves.toHaveLength(7)
    expect(await readdir(fixture.receiptDir)).toEqual([`${COMMIT}.d1-release-gate`])
  })

  it('never replaces a bundle directory created after the initial absence check', async () => {
    const fixture = await createFixture()
    const target = join(fixture.receiptDir, `${COMMIT}.d1-release-gate`)
    let statusCalls = 0
    await expect(runSidecarReleaseGate({
      ...fixture,
      randomId: () => 'late-target',
      run: async argv => {
        if (argv[1] === 'rev-parse') return result(`${COMMIT}\n`)
        if (argv[0] === '/usr/bin/git') {
          statusCalls += 1
          if (statusCalls === 2) await mkdir(target, { mode: 0o700 })
          return result()
        }
        if (argv.some(value => value.endsWith('/verify_release_environment.py'))) {
          await writeFile(argument(argv, '--output'), `${JSON.stringify(environmentReceipt(argument(argv, '--expected-contract-sha256')))}\n`)
        }
        return result('ok\n')
      },
    })).rejects.toThrow('d1_release_gate_receipt_exists')
    expect(await readdir(target)).toEqual([])
    expect(await readdir(fixture.receiptDir)).toEqual([`${COMMIT}.d1-release-gate`])
  })
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'd1-release-gate-'))
  const repoRoot = join(root, 'repo')
  const receiptDir = join(root, 'receipts')
  await mkdir(join(repoRoot, 'sidecars/nautilus_paper'), { recursive: true })
  await mkdir(receiptDir, { mode: 0o700 })
  await chmod(receiptDir, 0o700)
  const runtimeParent = join(await realpath(root), 'runtime')
  const runtimeRoot = join(runtimeParent, 'venv')
  const baseRuntime = join(runtimeParent, 'base')
  const sitePackages = join(runtimeRoot, 'lib/python3.13/site-packages')
  await mkdir(join(runtimeRoot, 'bin'), { recursive: true })
  await mkdir(join(baseRuntime, 'bin'), { recursive: true })
  await mkdir(sitePackages, { recursive: true })
  const runtimePython = join(runtimeRoot, 'bin/python')
  const testPython = join(root, 'test-python')
  await writeFile(runtimePython, '')
  const config = `home = ${join(baseRuntime, 'bin')}\n`
  await writeFile(join(runtimeRoot, 'pyvenv.cfg'), config)
  await writeFile(testPython, '')
  const interpreterHash = createHash('sha256').update('').digest('hex')
  const configHash = createHash('sha256').update(config).digest('hex')
  const baseRuntimeAggregate = await treeAggregate(baseRuntime)
  const sitePackagesAggregate = await treeAggregate(sitePackages)
  await writeFile(
    join(repoRoot, 'sidecars/nautilus_paper/release_runtime_contract.v1.json'),
    `{"runtimeProvenance":{"baseRuntimeAggregate":"${baseRuntimeAggregate}","installedAggregate":"${'1'.repeat(64)}","interpreterSha256":"${interpreterHash}","pyvenvCfgSha256":"${configHash}","sitePackagesAggregate":"${sitePackagesAggregate}","status":"frozen"}}\n`,
  )
  return { repoRoot, receiptDir, runtimePython, testPython, baseRuntime, sitePackages, environment: { OPENALICE_NAUTILUS_PYTHON: runtimePython, OPENALICE_NAUTILUS_TEST_PYTHON: testPython } }
}

async function treeAggregate(root: string): Promise<string> {
  const entries: { path: string, type: 'directory' | 'file', uid: number, mode: number, sha256: string | null }[] = []
  async function visit(path: string): Promise<void> {
    const entry = await stat(path)
    entries.push({
      path: relative(root, path),
      type: entry.isDirectory() ? 'directory' : 'file',
      uid: entry.uid,
      mode: entry.mode & 0o7777,
      sha256: entry.isFile() ? createHash('sha256').update(await readFile(path)).digest('hex') : null,
    })
    if (entry.isDirectory()) for (const child of await readdir(path)) await visit(join(path, child))
  }
  await visit(root)
  return createHash('sha256').update(canonicalJson(entries.sort((a, b) => compareCodePoints(a.path, b.path)))).digest('hex')
}
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, item => item.codePointAt(0) ?? 0)
  const b = Array.from(right, item => item.codePointAt(0) ?? 0)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function result(stdout = '', stderr = '', exitCode = 0): GateCommandResult { return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) } }
function argument(argv: readonly string[], name: string): string { const value = argv[argv.indexOf(name) + 1]; if (!value) throw new Error(`missing ${name}`); return value }
function environmentReceipt(contractHash: string) {
  return {
    schemaVersion: 'openalice_sidecar_environment_receipt.v1',
    contractHash,
    interpreterHash: 'b'.repeat(64),
    pyvenvCfgHash: 'c'.repeat(64),
    baseRuntimeAggregate: '3'.repeat(64),
    sitePackagesAggregate: '4'.repeat(64),
    installedAggregate: 'd'.repeat(64),
    lockHash: 'e'.repeat(64),
    wheelManifestHash: 'f'.repeat(64),
    protoHash: '1'.repeat(64),
    generatedAggregate: '2'.repeat(64),
    target: {
      implementation: 'CPython', python: '3.13.5', cacheTag: 'cpython-313',
      system: 'Darwin', macosMajor: 26, machine: 'arm64',
    },
    flags: {
      paperOnly: true, liveTradingAllowed: false, liveExecutionArmed: false,
    },
    executedAt: '2026-08-15T00:00:00.000Z',
    status: 'pass',
  }
}
