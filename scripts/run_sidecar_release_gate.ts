#!/usr/bin/env tsx

/**
 * D1 is deliberately a local validation gate, not a release/build command.
 * Its fixed command list is kept here so a caller cannot silently omit the
 * runtime, Python, or Node-to-Python contract checks.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sidecarEnvironmentReceiptV1Schema } from '../src/runtime/release_manifest.js'

const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
const EXPIRY_MS = 15 * 60 * 1000
const SYSTEM_GIT = '/usr/bin/git'
const SYSTEM_PNPM = '/opt/homebrew/bin/pnpm'
const D1_TOOL_PATH = '/opt/homebrew/bin:/usr/bin:/bin'
const CHECK_TIMEOUT_MS = 20 * 60 * 1000
const TERMINATION_GRACE_MS = 5 * 1000
const BUNDLE_MANIFEST = 'd1_release_bundle.v1.json'
const CHECK_IDS = [
  'd1.typescript',
  'd1.sidecar.environment',
  'd1.sidecar.proto',
  'd1.sidecar.python',
  'd1.sidecar.node',
  'd1.sidecar.node_python_uds',
  'd1.release_manifest_launcher',
] as const
type CheckId = (typeof CHECK_IDS)[number]

export interface GateCommandResult {
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly timedOut?: boolean
}

export interface GateDependencies {
  readonly run?: (argv: readonly string[], options: { cwd: string, env: NodeJS.ProcessEnv }) => Promise<GateCommandResult>
  readonly now?: () => Date
  readonly randomId?: () => string
}

export interface SidecarReleaseGateOptions extends GateDependencies {
  readonly repoRoot: string
  readonly receiptDir: string
  readonly environment?: NodeJS.ProcessEnv
}

export interface GateReceipt {
  readonly schemaVersion: 'validation_receipt.v1'
  readonly receiptId: string
  readonly checkId: CheckId
  readonly startedAt: string
  readonly endedAt: string
  readonly executedAt: string
  readonly expiresAt: string
  readonly exitCode: 0
  readonly sourceCommit: string
  readonly dirtyStateHash: string
  readonly sourceClean: true
  readonly commandDigest: string
  readonly commandSha256: string
  readonly environmentReceiptHash: string | null
  readonly inputSummary: readonly { path: string, exists: boolean, sha256: string | null }[]
  readonly outputSummary: {
    readonly stdoutBytes: number
    readonly stderrBytes: number
    readonly stdoutSha256: string
    readonly stderrSha256: string
    readonly stdoutTail: readonly string[]
    readonly stderrTail: readonly string[]
    readonly timedOut: false
  }
  readonly artifacts: readonly { path: string, exists: boolean, sha256: string | null }[]
  readonly status: 'pass'
}

export async function runSidecarReleaseGate(options: SidecarReleaseGateOptions): Promise<readonly string[]> {
  const repoRoot = requireAbsolutePath(options.repoRoot, 'repo_root')
  const receiptDir = requireAbsolutePath(options.receiptDir, 'receipt_dir')
  const env = options.environment ?? process.env
  if (env.OPENALICE_SIDECAR_TEST_PYTHON?.trim()) {
    throw new Error('d1_release_gate_sidecar_python_override_forbidden')
  }
  const runtimePython = requirePython(env.OPENALICE_NAUTILUS_PYTHON, 'OPENALICE_NAUTILUS_PYTHON')
  const testPython = requirePython(env.OPENALICE_NAUTILUS_TEST_PYTHON, 'OPENALICE_NAUTILUS_TEST_PYTHON')
  if (runtimePython === testPython) throw new Error('d1_release_gate_python_roles_must_be_distinct')

  const run = options.run ?? runCommand
  const now = options.now ?? (() => new Date())
  const randomId = options.randomId ?? randomUUID
  const sourceCommit = await gitText(run, repoRoot, [SYSTEM_GIT, 'rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('d1_release_gate_head_invalid')
  const status = await run([SYSTEM_GIT, 'status', '--porcelain=v1', '--untracked-files=all', '-z'], {
    cwd: repoRoot, env: safeEnvironment(),
  })
  if (status.timedOut) throw new Error('d1_release_gate_git_status_timed_out')
  if (status.exitCode !== 0) throw new Error('d1_release_gate_git_status_failed')
  if (status.stdout.length !== 0) throw new Error('d1_release_gate_requires_clean_source')
  const dirtyStateHash = sha256(status.stdout)
  if (dirtyStateHash !== EMPTY_SHA256) throw new Error('d1_release_gate_dirty_hash_not_empty')

  const environmentContractPath = join(
    repoRoot,
    'sidecars/nautilus_paper/release_runtime_contract.v1.json',
  )
  const expectedContractHash = await sha256File(environmentContractPath)
  await assertFrozenRuntimePython(environmentContractPath, runtimePython)

  await assertOwnerPrivateDirectory(receiptDir)
  const bundleDir = join(receiptDir, `${sourceCommit}.d1-release-gate`)
  const finalPaths = CHECK_IDS.map(checkId => join(bundleDir, `${checkId}.validation_receipt.v1.json`))
  await assertAbsent(bundleDir)
  // This lock deliberately has no stale-lock recovery.  A process that dies
  // after reserving a source commit must be investigated by an operator rather
  // than allowing a later process to replace ambiguous evidence.
  const reservationPath = join(receiptDir, `.${sourceCommit}.d1-release-gate.reservation`)
  const reservation = await reserveBundleCommit(reservationPath)
  const stagingDir = join(receiptDir, `.d1-release-gate-${randomId()}`)
  const environmentReceiptPath = join(stagingDir, 'd1.sidecar.environment.environment_receipt.v1.json')
  const completedChecks: {
    check: { checkId: CheckId, argv: readonly string[] }
    result: GateCommandResult
    startedAt: Date
    endedAt: Date
  }[] = []
  let environmentReceiptHash: string | null = null
  try {
    await mkdir(stagingDir, { mode: 0o700 })
    const checks: readonly { checkId: CheckId, argv: readonly string[], env: NodeJS.ProcessEnv, artifacts?: readonly string[] }[] = [
      { checkId: 'd1.typescript', argv: [SYSTEM_PNPM, 'typecheck'], env: safeEnvironment() },
      { checkId: 'd1.sidecar.environment', argv: [runtimePython, '-I', '-S', '-B', 'sidecars/nautilus_paper/verify_release_environment.py', '--contract', environmentContractPath, '--expected-contract-sha256', expectedContractHash, '--release-root', repoRoot, '--trust-mode', 'release-gate', '--output', environmentReceiptPath], env: safeEnvironment() },
      { checkId: 'd1.sidecar.proto', argv: [testPython, '-I', '-B', 'sidecars/nautilus_paper/generate_proto.py', '--check'], env: safeEnvironment() },
      { checkId: 'd1.sidecar.python', argv: [testPython, '-B', '-m', 'pytest', '-p', 'no:cacheprovider', 'sidecars/nautilus_paper'], env: safeEnvironment({ PYTHONPATH: repoRoot }) },
      { checkId: 'd1.sidecar.node', argv: [SYSTEM_PNPM, 'test'], env: safeEnvironment() },
      { checkId: 'd1.sidecar.node_python_uds', argv: [SYSTEM_PNPM, 'exec', 'vitest', 'run', 'src/sidecar/execution-grpc-transport.integration.spec.ts', 'src/sidecar/execution-grpc-offline.integration.spec.ts'], env: safeEnvironment({ OPENALICE_D1_RELEASE_GATE: '1', OPENALICE_SIDECAR_TEST_PYTHON: runtimePython }) },
      { checkId: 'd1.release_manifest_launcher', argv: [SYSTEM_PNPM, 'test:scripts', '--', 'scripts/run_sidecar_release_gate.spec.ts', 'scripts/launch_current_release.spec.ts', 'scripts/launch_nautilus_paper_release.spec.ts', 'scripts/manage_local_release.spec.ts', 'scripts/install_openalice_launchd.spec.ts', 'scripts/research_cutover.spec.ts', 'scripts/plan_paper_local_deployment.spec.ts'], env: safeEnvironment() },
    ]

    for (const check of checks) {
      const startedAt = now()
      const result = await run(check.argv, { cwd: repoRoot, env: check.env })
      if (result.timedOut) throw new Error(`d1_release_gate_check_timed_out:${check.checkId}`)
      if (result.exitCode !== 0) throw new Error(`d1_release_gate_check_failed:${check.checkId}:${result.exitCode}`)
      if (check.checkId === 'd1.sidecar.environment') {
        await assertEnvironmentReceipt(
          environmentReceiptPath,
          expectedContractHash,
        )
        environmentReceiptHash = await sha256File(environmentReceiptPath)
      }
      const endedAt = now()
      completedChecks.push({ check, result, startedAt, endedAt })
    }
    const finalSourceCommit = await gitText(run, repoRoot, [SYSTEM_GIT, 'rev-parse', 'HEAD'])
    if (finalSourceCommit !== sourceCommit) {
      throw new Error('d1_release_gate_source_changed_during_checks')
    }
    const finalStatus = await run(
      [SYSTEM_GIT, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      { cwd: repoRoot, env: safeEnvironment() },
    )
    if (finalStatus.timedOut) {
      throw new Error('d1_release_gate_final_git_status_timed_out')
    }
    if (finalStatus.exitCode !== 0) {
      throw new Error('d1_release_gate_final_git_status_failed')
    }
    if (finalStatus.stdout.length !== 0 || sha256(finalStatus.stdout) !== EMPTY_SHA256) {
      throw new Error('d1_release_gate_source_changed_during_checks')
    }
    if (!environmentReceiptHash) {
      throw new Error('d1_release_gate_environment_receipt_missing')
    }
    const sealedAt = now()
    const bundleExpiresAt = new Date(sealedAt.getTime() + EXPIRY_MS)

    const receipts: { checkId: CheckId, path: string, data: Buffer }[] = []
    for (const { check, result, startedAt, endedAt } of completedChecks) {
      const commandSha256 = sha256(Buffer.from(JSON.stringify(check.argv)))
      const receipt: GateReceipt = {
        schemaVersion: 'validation_receipt.v1',
        receiptId: sha256(Buffer.from(`${check.checkId}:${sourceCommit}:${commandSha256}`)),
        checkId: check.checkId,
        startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), executedAt: endedAt.toISOString(),
        expiresAt: bundleExpiresAt.toISOString(),
        exitCode: 0, sourceCommit, dirtyStateHash, sourceClean: true, commandDigest: commandSha256, commandSha256,
        environmentReceiptHash,
        inputSummary: [],
        outputSummary: outputSummary(result),
        artifacts: check.checkId === 'd1.sidecar.environment'
          ? [{
              path: 'd1.sidecar.environment.environment_receipt.v1.json',
              exists: true,
              sha256: environmentReceiptHash,
            }]
          : [],
        status: 'pass',
      }
      const path = join(stagingDir, `${check.checkId}.validation_receipt.v1.json`)
      const data = Buffer.from(`${canonicalJson(receipt)}\n`)
      await writeAtomicNew(path, data)
      receipts.push({ checkId: check.checkId, path, data })
    }
    if (receipts.length !== CHECK_IDS.length) {
      throw new Error('d1_release_gate_receipt_bundle_incomplete')
    }
    const bundleCore = {
      schemaVersion: 'd1_release_bundle.v1',
      sourceCommit,
      dirtyStateHash,
      environmentReceipt: {
        path: 'd1.sidecar.environment.environment_receipt.v1.json',
        sha256: environmentReceiptHash,
      },
      validationReceipts: receipts.map(receipt => ({
        checkId: receipt.checkId,
        path: `${receipt.checkId}.validation_receipt.v1.json`,
        sha256: sha256(receipt.data),
      })),
      sealedAt: sealedAt.toISOString(),
      expiresAt: bundleExpiresAt.toISOString(),
    }
    const bundle = {
      ...bundleCore,
      bundleId: sha256(Buffer.from(canonicalJson(bundleCore))),
    }
    await writeAtomicNew(
      join(stagingDir, BUNDLE_MANIFEST),
      Buffer.from(`${canonicalJson(bundle)}\n`),
    )
    // Create the final directory exclusively, hard-link every already-fsynced
    // file, and publish the manifest last.  A partial directory cannot validate
    // and no pre-existing directory can be replaced by check-then-rename.
    await publishBundleExclusive(stagingDir, bundleDir)
    return finalPaths
  } finally {
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } finally {
      try {
        await reservation.close()
      } finally {
        await unlink(reservationPath)
      }
    }
  }
}

function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`d1_release_gate_${label}_must_be_absolute`)
  return resolve(value)
}

function requirePython(value: string | undefined, label: string): string {
  const python = value?.trim()
  if (!python || !isAbsolute(python)) throw new Error(`d1_release_gate_${label}_must_be_absolute`)
  return resolve(python)
}

function safeEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: D1_TOOL_PATH,
    HOME: '/var/empty',
    TMPDIR: '/private/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    ...overrides,
  }
}

async function gitText(run: NonNullable<GateDependencies['run']>, cwd: string, argv: readonly string[]): Promise<string> {
  const result = await run(argv, { cwd, env: safeEnvironment() })
  if (result.timedOut) throw new Error('d1_release_gate_git_head_timed_out')
  if (result.exitCode !== 0) throw new Error('d1_release_gate_git_head_failed')
  return result.stdout.toString('utf8').trim()
}

async function runCommand(
  argv: readonly string[],
  options: { cwd: string, env: NodeJS.ProcessEnv },
  timeoutMs = CHECK_TIMEOUT_MS,
  terminationGraceMs = TERMINATION_GRACE_MS,
): Promise<GateCommandResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
    throw new Error('d1_release_gate_timeout_invalid')
  }
  return new Promise((resolveResult, reject) => {
    const [file, ...args] = argv
    if (!file) return reject(new Error('d1_release_gate_command_empty'))
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    let timedOut = false
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    let forceKill: NodeJS.Timeout | undefined
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
    }
    const signal = (name: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, name)
        else child.kill(name)
      } catch {
        try { child.kill(name) } catch { /* Process already exited. */ }
      }
    }
    const finish = (result: GateCommandResult) => {
      if (settled) return
      settled = true
      clearTimers()
      resolveResult(result)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(error)
    }
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.once('error', error => {
      if (timedOut) finish({ exitCode: 124, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut: true })
      else fail(error)
    })
    child.once('close', code => finish({
      exitCode: timedOut ? 124 : (code ?? 1),
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      timedOut,
    }))
    timeout = setTimeout(() => {
      timedOut = true
      signal('SIGTERM')
      forceKill = setTimeout(() => signal('SIGKILL'), terminationGraceMs)
      forceKill.unref()
    }, timeoutMs)
    timeout.unref()
  })
}

/** Test-only process runner seam; formal gate callers always use fixed timeouts. */
export async function runGateCommandForTest(
  argv: readonly string[],
  options: { cwd: string, env: NodeJS.ProcessEnv },
  timeoutMs: number,
  terminationGraceMs: number,
): Promise<GateCommandResult> {
  if (process.env.NODE_ENV !== 'test') throw new Error('d1_release_gate_test_seam_forbidden')
  return runCommand(argv, options, timeoutMs, terminationGraceMs)
}

function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}
async function sha256File(path: string): Promise<string> { return sha256(await readFile(path)) }
async function assertFrozenRuntimePython(contractPath: string, runtimePython: string): Promise<void> {
  let contract: Record<string, unknown>
  let raw: Buffer
  try {
    raw = await readFile(contractPath)
    contract = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('d1_release_gate_runtime_contract_invalid')
  }
  const canonical = Buffer.from(`${canonicalJson(contract)}\n`)
  if (!raw.equals(canonical) && !raw.equals(canonical.subarray(0, canonical.length - 1))) {
    throw new Error('d1_release_gate_runtime_contract_not_canonical')
  }
  const provenance = contract.runtimeProvenance
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error('d1_release_gate_runtime_provenance_invalid')
  }
  const value = provenance as Record<string, unknown>
  if (
    Object.keys(value).sort().join(',')
      !== ['baseRuntimeAggregate', 'installedAggregate', 'interpreterSha256', 'pyvenvCfgSha256', 'sitePackagesAggregate', 'status'].join(',')
  ) {
    throw new Error('d1_release_gate_runtime_provenance_invalid')
  }
  if (value.status !== 'frozen') {
    throw new Error('d1_release_gate_runtime_provenance_not_frozen')
  }
  for (const field of ['interpreterSha256', 'pyvenvCfgSha256', 'baseRuntimeAggregate', 'sitePackagesAggregate', 'installedAggregate']) {
    if (typeof value[field] !== 'string' || !/^[a-f0-9]{64}$/.test(value[field])) {
      throw new Error('d1_release_gate_runtime_provenance_invalid')
    }
  }
  const entry = await lstat(runtimePython).catch(() => null)
  if (!entry || (!entry.isFile() && !entry.isSymbolicLink())) {
    throw new Error('d1_release_gate_runtime_python_unsafe')
  }
  const resolvedPython = await realpath(runtimePython).catch(() => null)
  if (!resolvedPython) throw new Error('d1_release_gate_runtime_python_unsafe')
  const resolvedStatus = await lstat(resolvedPython).catch(() => null)
  if (!resolvedStatus?.isFile() || resolvedStatus.isSymbolicLink() || (resolvedStatus.mode & 0o022) !== 0) {
    throw new Error('d1_release_gate_runtime_python_unsafe')
  }
  if (await sha256File(resolvedPython) !== value.interpreterSha256) {
    throw new Error('d1_release_gate_runtime_interpreter_mismatch')
  }
  const binDirectory = dirname(runtimePython)
  if (basename(binDirectory) !== 'bin') {
    throw new Error('d1_release_gate_runtime_python_not_venv')
  }
  const pyvenvConfig = join(dirname(binDirectory), 'pyvenv.cfg')
  const configStatus = await lstat(pyvenvConfig).catch(() => null)
  if (!configStatus?.isFile() || configStatus.isSymbolicLink() || (configStatus.mode & 0o022) !== 0) {
    throw new Error('d1_release_gate_runtime_python_not_venv')
  }
  if (await sha256File(pyvenvConfig) !== value.pyvenvCfgSha256) {
    throw new Error('d1_release_gate_runtime_pyvenv_mismatch')
  }
  const requestedVenvRoot = dirname(binDirectory)
  const venvRoot = await realpath(requestedVenvRoot).catch(() => null)
  if (!venvRoot) throw new Error('d1_release_gate_runtime_python_not_venv')
  const basePrefix = await parseStrictPyvenvBasePrefix(pyvenvConfig)
  if (!isWithinPath(basePrefix, dirname(venvRoot))) {
    throw new Error('d1_release_gate_runtime_base_prefix_outside_runtime_root')
  }
  if (!isWithinPath(resolvedPython, venvRoot) && !isWithinPath(resolvedPython, basePrefix)) {
    throw new Error('d1_release_gate_runtime_python_outside_runtime_root')
  }
  const publisherUid = process.getuid?.()
  if (!Number.isSafeInteger(publisherUid) || publisherUid === undefined || publisherUid < 0) {
    throw new Error('d1_release_gate_runtime_publisher_uid_unavailable')
  }
  const baseRuntimeAggregate = await assertPublisherOwnedTree(
    basePrefix,
    publisherUid,
    'd1_release_gate_runtime_base_prefix_unsafe',
  )
  if (baseRuntimeAggregate !== value.baseRuntimeAggregate) {
    throw new Error('d1_release_gate_runtime_base_runtime_aggregate_mismatch')
  }
  const sitePackages = join(venvRoot, 'lib', 'python3.13', 'site-packages')
  const sitePackagesAggregate = await assertPublisherOwnedTree(
    sitePackages,
    publisherUid,
    'd1_release_gate_runtime_site_packages_unsafe',
  )
  if (sitePackagesAggregate !== value.sitePackagesAggregate) {
    throw new Error('d1_release_gate_runtime_site_packages_aggregate_mismatch')
  }
}

async function parseStrictPyvenvBasePrefix(configPath: string): Promise<string> {
  let content: string
  try { content = (await readFile(configPath)).toString('utf8') } catch {
    throw new Error('d1_release_gate_runtime_pyvenv_invalid')
  }
  const homeLines = content.split(/\r?\n/).filter(line => line.startsWith('home = '))
  if (homeLines.length !== 1) throw new Error('d1_release_gate_runtime_pyvenv_invalid')
  const home = homeLines[0]!.slice('home = '.length)
  if (!/^\/[^\u0000\r\n]+$/.test(home) || home === '/' || resolve(home) !== home) {
    throw new Error('d1_release_gate_runtime_pyvenv_invalid')
  }
  return dirname(home)
}

function isWithinPath(candidate: string, root: string): boolean {
  const delta = relative(resolve(root), resolve(candidate))
  return delta === '' || (!delta.startsWith('../') && delta !== '..')
}

async function assertPublisherOwnedTree(path: string, publisherUid: number, code: string): Promise<string> {
  const root = resolve(path)
  // Match the Python verifier: the aggregate subject and all descendants must
  // belong to the gate's publisher, while every ancestor to `/` must be a
  // non-symlink directory without group/world write permission.
  for (let current = root; ; current = dirname(current)) {
    const status = await lstat(current).catch(() => null)
    if (
      !status
      || status.isSymbolicLink()
      || !status.isDirectory()
      || (status.mode & 0o022) !== 0
      || (current === root && status.uid !== publisherUid)
    ) throw new Error(code)
    if (dirname(current) === current) break
  }
  const identities: { path: string, type: 'directory' | 'file', uid: number, mode: number, sha256: string | null }[] = []
  async function visit(current: string): Promise<void> {
    const entry = await lstat(current).catch(() => null)
    if (
      !entry
      || entry.isSymbolicLink()
      || (!entry.isDirectory() && !entry.isFile())
      || entry.uid !== publisherUid
      || (entry.mode & 0o022) !== 0
    ) throw new Error(code)
    identities.push({
      path: relative(root, current),
      type: entry.isDirectory() ? 'directory' : 'file',
      uid: entry.uid,
      mode: entry.mode & 0o7777,
      sha256: entry.isFile() ? await sha256File(current) : null,
    })
    if (!entry.isDirectory()) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null)
    if (!entries) throw new Error(code)
    for (const child of entries) {
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) throw new Error(code)
      await visit(join(current, child.name))
    }
  }
  await visit(root)
  return sha256(Buffer.from(canonicalJson(identities.sort(compareAggregatePath))))
}

function compareAggregatePath(left: { path: string }, right: { path: string }): number {
  const a = Array.from(left.path, item => item.codePointAt(0) ?? 0)
  const b = Array.from(right.path, item => item.codePointAt(0) ?? 0)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}
async function assertEnvironmentReceipt(
  path: string,
  expectedContractHash: string,
): Promise<void> {
  try {
    const value = sidecarEnvironmentReceiptV1Schema.parse(
      JSON.parse((await readFile(path)).toString('utf8')),
    )
    if (value.contractHash !== expectedContractHash) {
      throw new Error('d1_release_gate_environment_contract_mismatch')
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'd1_release_gate_environment_contract_mismatch'
    ) throw error
    throw new Error('d1_release_gate_environment_receipt_invalid')
  }
}
function outputSummary(result: GateCommandResult): GateReceipt['outputSummary'] {
  return {
    stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length,
    stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr),
    // Validation artifacts must not persist arbitrary child output. Hashes and
    // byte counts are sufficient to bind diagnostics held outside the release.
    stdoutTail: [], stderrTail: [], timedOut: false,
  }
}
async function assertAbsent(path: string): Promise<void> {
  try { await stat(path); throw new Error(`d1_release_gate_receipt_exists:${path}`) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
async function assertOwnerPrivateDirectory(path: string): Promise<void> {
  const directory = await lstat(path)
  if (directory.isSymbolicLink()) throw new Error('d1_release_gate_receipt_dir_symlink_forbidden')
  if (!directory.isDirectory()) throw new Error('d1_release_gate_receipt_dir_not_directory')
  if ((directory.mode & 0o077) !== 0) throw new Error('d1_release_gate_receipt_dir_not_owner_private')
  const owner = process.getuid?.()
  if (!Number.isSafeInteger(owner) || owner === undefined || owner < 0 || directory.uid !== owner) {
    throw new Error('d1_release_gate_receipt_dir_not_owner_private')
  }
}
async function reserveBundleCommit(path: string) {
  try {
    return await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`d1_release_gate_bundle_reservation_exists:${path}`)
    }
    throw error
  }
}
async function publishBundleExclusive(stagingDir: string, bundleDir: string): Promise<void> {
  try {
    await mkdir(bundleDir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`d1_release_gate_receipt_exists:${bundleDir}`)
    }
    throw error
  }
  let complete = false
  try {
    const names = (await readdir(stagingDir)).sort()
    if (!names.includes(BUNDLE_MANIFEST)) throw new Error('d1_release_gate_bundle_manifest_missing')
    for (const name of names.filter(name => name !== BUNDLE_MANIFEST)) {
      await link(join(stagingDir, name), join(bundleDir, name))
    }
    // Loaders require this manifest, so linking it last is the validity
    // publication point for the otherwise fail-closed directory.
    await link(join(stagingDir, BUNDLE_MANIFEST), join(bundleDir, BUNDLE_MANIFEST))
    const directory = await open(bundleDir, constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
    const parent = await open(dirname(bundleDir), constants.O_RDONLY)
    try { await parent.sync() } finally { await parent.close() }
    complete = true
  } finally {
    if (!complete) {
      await rm(bundleDir, { recursive: true, force: true })
    }
  }
}
async function writeAtomicNew(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${randomUUID()}`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
  try { await link(temporary, path) } catch (error) { await rm(temporary, { force: true }); throw error }
  await unlink(temporary)
  const directory = await open(dirname(path), constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('d1_release_gate_accepts_no_cli_options')
  const receiptDir = process.env.OPENALICE_D1_RECEIPT_DIR
  if (!receiptDir) throw new Error('d1_release_gate_receipt_dir_required')
  await runSidecarReleaseGate({ repoRoot: process.cwd(), receiptDir })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
