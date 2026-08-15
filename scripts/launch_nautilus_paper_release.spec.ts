import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  D1_RELEASE_BUNDLE_METADATA_PATH,
  D1_RELEASE_CHECK_IDS,
  DEPENDENCY_LOCK_METADATA_PATH,
  EXECUTION_PROTO_PATH,
  PIPELINE_REGISTRY_METADATA_PATH,
  SIDECAR_ENVIRONMENT_RECEIPT_PATH,
  SIDECAR_RUNTIME_CONTRACT_PATH,
  SIDECAR_RUNTIME_LOCK_PATH,
  SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH,
  STRATEGY_CONFIG_METADATA_PATH,
  buildReleaseManifestV2,
  releaseManifestHash,
  type ReleaseManifestV2Core,
} from '../src/runtime/release_manifest.js'
import { REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2 } from '../src/runtime/release_manager.js'
import {
  PAPER_LOCAL_FORWARDED_SIGNALS,
  assertRuntimePythonBinding,
  assertTrustedD1ReleaseFilesystem,
  assertTrustedD1MaterializedEntrypoint,
  parsePaperLocalLauncherArgs,
  runEnvironmentVerifier,
  validateSupervisorConfigBinding,
  validateD1BundleBinding,
  validateD1ReleaseManifest,
} from '../ops/release/launch_nautilus_paper.mjs'

const COMMIT = '1'.repeat(40)
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const execFileAsync = promisify(execFile)

describe('dedicated PAPER_LOCAL release launcher', () => {
  it('accepts only a clean V2 release bound to the exact D1 and environment evidence', () => {
    const manifest = buildReleaseManifestV2(makeCore())

    expect(validateD1ReleaseManifest(manifest)).toEqual(manifest)

    expect(() => validateD1ReleaseManifest({
      ...manifest,
      engineeringChecks: manifest.engineeringChecks.slice(1),
    })).toThrow('d1_engineering_checks_mismatch')
    expect(() => validateD1ReleaseManifest({
      ...manifest,
      liveExecutionArmed: true,
    })).toThrow('d1_live_execution_armed')
    expect(() => validateD1ReleaseManifest({
      ...manifest,
      engineeringChecks: [
        ...manifest.engineeringChecks,
        manifest.engineeringChecks[0],
      ],
    })).toThrow('d1_engineering_checks_mismatch')
    expect(() => validateD1ReleaseManifest({
      ...manifest,
      validationReceipts: [
        ...manifest.validationReceipts,
        {
          ...manifest.validationReceipts[0],
          path: 'release-metadata/validation-receipts/duplicate.json',
        },
      ],
    })).toThrow('d1_validation_receipts_mismatch')
    expect(() => validateD1ReleaseManifest(
      manifest,
      new Date('2026-08-15T02:00:00.000Z'),
    )).toThrow('d1_validation_receipt_invalid')
  })

  it('cross-binds the materialized D1 bundle to the manifest receipt set', () => {
    const core = makeCore()
    const bundleCore = {
      schemaVersion: 'd1_release_bundle.v1',
      sourceCommit: core.sourceCommit,
      dirtyStateHash: core.dirtyStateHash,
      environmentReceipt: {
        path: 'd1.sidecar.environment.environment_receipt.v1.json',
        sha256: core.sidecarEnvironment.receiptHash,
      },
      validationReceipts: core.validationReceipts.map(receipt => ({
        checkId: receipt.checkId,
        path: `${receipt.checkId}.validation_receipt.v1.json`,
        sha256: receipt.receiptHash,
      })),
      sealedAt: '2026-08-15T01:05:00.000Z',
      expiresAt: core.validationReceipts[0]!.expiresAt,
    }
    const bundle = { ...bundleCore, bundleId: hashCanonical(bundleCore) }
    const raw = `${canonicalJson(bundle)}\n`
    const boundCore = {
      ...core,
      artifactHashes: {
        ...core.artifactHashes,
        [D1_RELEASE_BUNDLE_METADATA_PATH]: createHash('sha256').update(raw).digest('hex'),
      },
    }
    const manifest = buildReleaseManifestV2(boundCore)
    expect(validateD1BundleBinding(raw, manifest)).toEqual(bundle)

    const conflictingCore = {
      ...bundleCore,
      environmentReceipt: { ...bundleCore.environmentReceipt, sha256: '0'.repeat(64) },
    }
    const conflicting = { ...conflictingCore, bundleId: hashCanonical(conflictingCore) }
    const conflictingRaw = `${canonicalJson(conflicting)}\n`
    const conflictingManifest = buildReleaseManifestV2({
      ...boundCore,
      artifactHashes: {
        ...boundCore.artifactHashes,
        [D1_RELEASE_BUNDLE_METADATA_PATH]: createHash('sha256').update(conflictingRaw).digest('hex'),
      },
    })
    expect(() => validateD1BundleBinding(conflictingRaw, conflictingManifest))
      .toThrow('d1_release_bundle_environment_invalid')
  })

  it('rejects a missing supervisor artifact even if the manifest hash is superficially valid', () => {
    const core = makeCore()
    const missing = 'sidecars/nautilus_paper/supervisor.py'
    const artifactHashes = { ...core.artifactHashes }
    delete artifactHashes[missing]
    const manifestCore = { ...core, artifactHashes }
    const manifest = {
      schemaVersion: 'release_manifest.v2',
      manifestHash: releaseManifestHash(manifestCore),
      ...manifestCore,
    }

    expect(() => validateD1ReleaseManifest(manifest)).toThrow(
      `d1_release_artifact_missing:${missing}`,
    )
  })

  it('requires explicit absolute inputs and permits only the research pointer', () => {
    expect(PAPER_LOCAL_FORWARDED_SIGNALS).toContain('SIGQUIT')
    const previous = {
      python: process.env.OPENALICE_NAUTILUS_PYTHON,
      publisher: process.env.OPENALICE_RELEASE_PUBLISHER_UID,
      shell: process.env.OPENALICE_PAPER_LOCAL_SHELL_PATH,
    }
    process.env.OPENALICE_NAUTILUS_PYTHON = '/private/runtime/bin/python3.13'
    process.env.OPENALICE_RELEASE_PUBLISHER_UID = '501'
    process.env.OPENALICE_PAPER_LOCAL_SHELL_PATH = '/private/releases/ops/release/launch_nautilus_paper.sh'
    try {
      expect(parsePaperLocalLauncherArgs([
        '--release-root', '/private/releases',
        '--pointer', 'research-current',
        '--config', '/private/run/supervisor.json',
        '--verify-only',
      ])).toMatchObject({
        releaseRoot: '/private/releases',
        pointer: 'research-current',
        publisherUid: 501,
        shellPath: '/private/releases/ops/release/launch_nautilus_paper.sh',
        verifyOnly: true,
      })
      expect(() => parsePaperLocalLauncherArgs([
        '--release-root', '/private/releases',
        '--pointer', 'current',
        '--config', '/private/run/supervisor.json',
      ])).toThrow('paper_local_pointer_must_be_research_current')
      expect(() => parsePaperLocalLauncherArgs([
        '--release-root', 'relative',
        '--release-id', COMMIT,
        '--config', '/private/run/supervisor.json',
      ])).toThrow('absolute_release-root_required')
    } finally {
      if (previous.python === undefined) delete process.env.OPENALICE_NAUTILUS_PYTHON
      else process.env.OPENALICE_NAUTILUS_PYTHON = previous.python
      if (previous.publisher === undefined) delete process.env.OPENALICE_RELEASE_PUBLISHER_UID
      else process.env.OPENALICE_RELEASE_PUBLISHER_UID = previous.publisher
      if (previous.shell === undefined) delete process.env.OPENALICE_PAPER_LOCAL_SHELL_PATH
      else process.env.OPENALICE_PAPER_LOCAL_SHELL_PATH = previous.shell
    }
  })

  it('cross-binds the supervisor config schema hash to the selected V2 release artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-supervisor-binding-'))
    const configPath = join(root, 'supervisor.json')
    const manifestHash = 'a'.repeat(64)
    const schemaHash = 'b'.repeat(64)
    const config = {
      schemaVersion: 'openalice_paper_supervisor_config.v1',
      mode: 'PAPER_LOCAL',
      releaseManifestHash: manifestHash,
      schemaHash,
    }
    await writeFile(configPath, `${canonicalJson(config)}\n`, { mode: 0o600 })

    await expect(validateSupervisorConfigBinding(
      configPath,
      manifestHash,
      schemaHash,
    )).resolves.toBeUndefined()
    await expect(validateSupervisorConfigBinding(
      configPath,
      manifestHash,
      'c'.repeat(64),
    )).rejects.toThrow('paper_local_supervisor_config_binding_mismatch')
  })

  it('requires a separately owned, non-writable publisher hierarchy before trusting release hashes', async () => {
    const statuses = new Map([
      ['/', fakeDirectory(0)],
      ['/trusted', fakeDirectory(0)],
      ['/trusted/releases', fakeDirectory(700)],
      [`/trusted/releases/${COMMIT}`, fakeDirectory(700)],
      [`/trusted/releases/${COMMIT}/release_manifest.v2.json`, fakeFile(700)],
    ])
    const entries = new Map([
      [`/trusted/releases/${COMMIT}`, [{ name: 'release_manifest.v2.json' }]],
    ])
    const filesystem = {
      lstat: async (path: string) => {
        const status = statuses.get(path)
        if (!status) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return status
      },
      readdir: async (path: string) => entries.get(path) ?? [],
      access: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      },
    }

    await expect(assertTrustedD1ReleaseFilesystem({
      releaseRoot: '/trusted/releases',
      releasePath: `/trusted/releases/${COMMIT}`,
      publisherUid: 700,
      serviceUid: 501,
      filesystem,
    })).resolves.toBeUndefined()

    statuses.set(`/trusted/releases/${COMMIT}/release_manifest.v2.json`, fakeFile(700, 0o664))
    await expect(assertTrustedD1ReleaseFilesystem({
      releaseRoot: '/trusted/releases',
      releasePath: `/trusted/releases/${COMMIT}`,
      publisherUid: 700,
      serviceUid: 501,
      filesystem,
    })).rejects.toThrow('paper_local_release_tree_unsafe')

    statuses.set(`/trusted/releases/${COMMIT}/release_manifest.v2.json`, fakeFile(700))
    await expect(assertTrustedD1ReleaseFilesystem({
      releaseRoot: '/trusted/releases',
      releasePath: `/trusted/releases/${COMMIT}`,
      publisherUid: 501,
      serviceUid: 501,
      filesystem,
    })).rejects.toThrow('paper_local_release_publisher_must_differ_from_service_uid')
  })

  it('admits only a protected materialized shell/MJS pair with release-bound bytes', async () => {
    const shell = '/stable/bin/launch_nautilus_paper.sh'
    const module = '/stable/bin/launch_nautilus_paper.mjs'
    const statuses = new Map([
      ['/', fakeDirectory(0)],
      ['/stable', fakeDirectory(0)],
      ['/stable/bin', fakeDirectory(700)],
      [shell, fakeFile(700, 0o555)],
      [module, fakeFile(700, 0o444)],
    ])
    const filesystem = {
      lstat: async (path: string) => {
        const status = statuses.get(path)
        if (!status) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return status
      },
      readdir: async () => [],
      access: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      },
    }
    const expectedHashes = { shell: 'a'.repeat(64), module: 'b'.repeat(64) }

    await expect(assertTrustedD1MaterializedEntrypoint({
      shellPath: shell,
      modulePath: module,
      publisherUid: 700,
      serviceUid: 501,
      filesystem,
      realpath: async (path: string) => path,
      expectedHashes,
      hashFile: async (path: string) => path === shell ? expectedHashes.shell : expectedHashes.module,
    })).resolves.toEqual({ shellPath: shell, modulePath: module })

    await expect(assertTrustedD1MaterializedEntrypoint({
      shellPath: shell,
      modulePath: module,
      publisherUid: 700,
      serviceUid: 501,
      filesystem,
      realpath: async (path: string) => path,
      expectedHashes,
      hashFile: async () => 'c'.repeat(64),
    })).rejects.toThrow('paper_local_launcher_hash_mismatch')
  })

  it('rejects a same-UID publisher before the shell can execute Node', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'paper-local-wrapper-'))
    const fakeNode = join(temporary, 'trusted-node')
    await writeFile(fakeNode, '#!/bin/sh\nprintf "node-should-not-run\\n"\n')
    await chmod(fakeNode, 0o700)
    const nodeHash = createHash('sha256').update(
      '#!/bin/sh\nprintf "node-should-not-run\\n"\n',
    ).digest('hex')

    await expect(execFileAsync('/bin/sh', [
      resolve('ops/release/launch_nautilus_paper.sh'),
      '--verify-only',
    ], {
      env: {
        OPENALICE_NODE: fakeNode,
        OPENALICE_NODE_SHA256: nodeHash,
        OPENALICE_PAPER_LOCAL_MJS_SHA256: '0'.repeat(64),
        OPENALICE_NAUTILUS_PYTHON: '/private/runtime/bin/python3.13',
        OPENALICE_RELEASE_PUBLISHER_UID: String(process.getuid?.() ?? 501),
        NODE_OPTIONS: '--require=/tmp/attacker.js',
        BROKER_SECRET: 'must-not-cross',
        PATH: `${temporary}:/usr/bin:/bin`,
      },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('trusted_node_publisher_uid_unsafe'),
      stdout: expect.not.stringContaining('node-should-not-run'),
    })
  })

  it('rejects a service-owned Node path before it can build an implicit invocation', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'paper-local-service-wrapper-'))
    const fakeNode = join(temporary, 'trusted-node')
    await writeFile(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    await chmod(fakeNode, 0o700)
    const nodeHash = createHash('sha256').update(
      '#!/bin/sh\nprintf "%s\\n" "$@"\n',
    ).digest('hex')

    const serviceUid = process.getuid?.() ?? 501
    await expect(execFileAsync('/bin/sh', [
      resolve('ops/release/launch_nautilus_paper.sh'),
    ], {
      env: {
        OPENALICE_NODE: fakeNode,
        OPENALICE_NODE_SHA256: nodeHash,
        OPENALICE_PAPER_LOCAL_MJS_SHA256: '0'.repeat(64),
        OPENALICE_NAUTILUS_PYTHON: '/private/runtime/bin/python3.13',
        OPENALICE_RELEASE_PUBLISHER_UID: String(serviceUid + 1),
        OPENALICE_RELEASE_DIR: '/private/releases',
        OPENALICE_PAPER_LOCAL_SUPERVISOR_CONFIG: '/private/run/supervisor.json',
      },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('trusted_node_path_unsafe'),
    })
  })

  it('requires an independently pinned MJS hash before the candidate runner can execute', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'paper-local-mjs-pin-'))
    const fakeNode = join(temporary, 'candidate-runner')
    const marker = join(temporary, 'candidate-executed')
    const candidate = `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(marker)}\n`
    await writeFile(fakeNode, candidate)
    await chmod(fakeNode, 0o700)
    const nodeHash = createHash('sha256').update(candidate).digest('hex')

    await expect(execFileAsync('/bin/sh', [
      resolve('ops/release/launch_nautilus_paper.sh'),
      '--verify-only',
    ], {
      env: {
        OPENALICE_NODE: fakeNode,
        OPENALICE_NODE_SHA256: nodeHash,
        OPENALICE_NAUTILUS_PYTHON: '/private/runtime/bin/python3.13',
        OPENALICE_RELEASE_PUBLISHER_UID: String((process.getuid?.() ?? 501) + 1),
      },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('OPENALICE_PAPER_LOCAL_MJS_SHA256_required'),
    })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an unprotected shell/MJS pair before the candidate MJS can run', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'paper-local-mjs-bootstrap-'))
    const shell = join(temporary, 'launch_nautilus_paper.sh')
    const module = join(temporary, 'launch_nautilus_paper.mjs')
    const marker = join(temporary, 'candidate-mjs-executed')
    const moduleBytes = `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(marker)}\n`
    await writeFile(shell, await readFile(resolve('ops/release/launch_nautilus_paper.sh')))
    await writeFile(module, moduleBytes)
    await chmod(shell, 0o555)
    await chmod(module, 0o444)
    const trustedRunner = '/bin/sh'
    const nodeHash = createHash('sha256').update(await readFile(trustedRunner)).digest('hex')
    const moduleHash = createHash('sha256').update(moduleBytes).digest('hex')

    await expect(execFileAsync('/bin/sh', [shell, '--verify-only'], {
      env: {
        OPENALICE_NODE: trustedRunner,
        OPENALICE_NODE_SHA256: nodeHash,
        OPENALICE_PAPER_LOCAL_MJS_SHA256: moduleHash,
        OPENALICE_NAUTILUS_PYTHON: '/private/runtime/bin/python3.13',
        OPENALICE_RELEASE_PUBLISHER_UID: String((process.getuid?.() ?? 501) + 1),
      },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('paper_local_shell_entrypoint_unsafe'),
    })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects runtime Python byte drift before executing the candidate', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'paper-local-python-binding-'))
    const venv = join(temporary, 'venv')
    const python = join(venv, 'bin/python')
    const marker = join(temporary, 'executed')
    await mkdir(join(venv, 'bin'), { recursive: true })
    await writeFile(python, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(marker)}\n`)
    await chmod(python, 0o700)
    await writeFile(join(venv, 'pyvenv.cfg'), 'home = /base\n')
    const manifest = buildReleaseManifestV2(makeCore())

    await expect(assertRuntimePythonBinding(
      python,
      manifest.sidecarEnvironment.receipt,
      { trustMode: 'release-gate' },
    )).rejects.toThrow('paper_local_runtime_interpreter_mismatch')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses deployment verification when the publisher identity is the current service identity', async () => {
    const serviceUid = process.getuid?.() ?? -1
    expect(Number.isSafeInteger(serviceUid)).toBe(true)
    await expect(assertRuntimePythonBinding(
      '/private/unreachable/runtime/bin/python3.13',
      buildReleaseManifestV2(makeCore()).sidecarEnvironment.receipt,
      { trustMode: 'deployment', publisherUid: serviceUid },
    )).rejects.toThrow(
      serviceUid > 0
        ? 'paper_local_release_publisher_must_differ_from_service_uid'
        : 'paper_local_service_uid_unsafe',
    )
  })

  it('binds the complete in-root base runtime before a deployment verifier can execute Python', async () => {
    const manifest = buildReleaseManifestV2(makeCore())
    const seam = trustedRuntimeSeam()
    await expect(assertRuntimePythonBinding(
      seam.python,
      manifest.sidecarEnvironment.receipt,
      { trustMode: 'deployment', publisherUid: 700, runtimeTrustTestSeam: seam },
    )).resolves.toMatchObject({
      python: seam.python,
      venvRoot: '/trusted/runtime/venv',
      basePrefix: '/trusted/runtime/base',
      interpreterHash: '9'.repeat(64),
      pyvenvCfgHash: '0'.repeat(64),
    })
  })

  it.each([
    ['owner', (seam: ReturnType<typeof trustedRuntimeSeam>) => seam.setStatus('/trusted/runtime/base/lib/python3.13/os.py', fakeFile(501))],
    ['mode', (seam: ReturnType<typeof trustedRuntimeSeam>) => seam.setStatus('/trusted/runtime/base/lib/python3.13/os.py', fakeFile(700, 0o775))],
    ['acl', (seam: ReturnType<typeof trustedRuntimeSeam>) => seam.setWritable('/trusted/runtime/base/lib/python3.13/os.py')],
    ['symlink', (seam: ReturnType<typeof trustedRuntimeSeam>) => seam.setStatus('/trusted/runtime/base/lib/python3.13/os.py', fakeSymlink(700))],
  ])('rejects a deployment base runtime with an unsafe %s member before Python execution', async (_attack, mutate) => {
    const seam = trustedRuntimeSeam()
    mutate(seam)
    await expect(assertRuntimePythonBinding(
      seam.python,
      buildReleaseManifestV2(makeCore()).sidecarEnvironment.receipt,
      { trustMode: 'deployment', publisherUid: 700, runtimeTrustTestSeam: seam },
    )).rejects.toThrow('paper_local_runtime_base_prefix_unsafe')
  })

  it('rejects a pyvenv base prefix outside the protected runtime root before Python execution', async () => {
    const seam = trustedRuntimeSeam({ pyvenv: 'home = /outside/base/bin\n' })
    await expect(assertRuntimePythonBinding(
      seam.python,
      buildReleaseManifestV2(makeCore()).sidecarEnvironment.receipt,
      { trustMode: 'deployment', publisherUid: 700, runtimeTrustTestSeam: seam },
    )).rejects.toThrow('paper_local_runtime_base_prefix_outside_runtime_root')
  })

  it('rejects an unsafe base runtime before the environment verifier can spawn the candidate', async () => {
    const seam = trustedRuntimeSeam()
    seam.setStatus('/trusted/runtime/base/lib/python3.13/os.py', fakeFile(700, 0o775))
    let candidateExecuted = false
    seam.runCaptured = async () => {
      candidateExecuted = true
      return { code: 0, stdout: '{}', stderr: '' }
    }
    await expect(runEnvironmentVerifier({
      python: seam.python,
      releasePath: '/release',
      manifest: buildReleaseManifestV2(makeCore()),
      publisherUid: 700,
      runtimeTrustTestSeam: seam,
    })).rejects.toThrow('paper_local_runtime_base_prefix_unsafe')
    expect(candidateExecuted).toBe(false)
  })

  it('rejects a base-runtime byte drift before the environment verifier can spawn the candidate', async () => {
    const seam = trustedRuntimeSeam()
    seam.setHash('/trusted/runtime/base/lib/python3.13/os.py', 'b'.repeat(64))
    let candidateExecuted = false
    seam.runCaptured = async () => {
      candidateExecuted = true
      return { code: 0, stdout: '{}', stderr: '' }
    }
    await expect(runEnvironmentVerifier({
      python: seam.python,
      releasePath: '/release',
      manifest: buildReleaseManifestV2(makeCore()),
      publisherUid: 700,
      runtimeTrustTestSeam: seam,
    })).rejects.toThrow('paper_local_runtime_base_runtime_aggregate_mismatch')
    expect(candidateExecuted).toBe(false)
  })

  it('rejects a site-packages aggregate drift before Python execution', async () => {
    const seam = trustedRuntimeSeam()
    seam.setStatus('/trusted/runtime/venv/lib/python3.13/site-packages/added.py', fakeFile(700))
    await expect(assertRuntimePythonBinding(
      seam.python,
      buildReleaseManifestV2(makeCore()).sidecarEnvironment.receipt,
      { trustMode: 'deployment', publisherUid: 700, runtimeTrustTestSeam: seam },
    )).rejects.toThrow('paper_local_runtime_site_packages_aggregate_mismatch')
  })

  it('rejects a contract/receipt aggregate mismatch before Python execution', async () => {
    const manifest = buildReleaseManifestV2(makeCore())
    const receipt = { ...manifest.sidecarEnvironment.receipt, baseRuntimeAggregate: 'b'.repeat(64) }
    const seam = trustedRuntimeSeam()
    await expect(assertRuntimePythonBinding(
      seam.python,
      receipt,
      { trustMode: 'deployment', publisherUid: 700, runtimeTrustTestSeam: seam },
    )).rejects.toThrow('paper_local_runtime_base_runtime_aggregate_mismatch')
  })

  it('rejects mismatched real/effective deployment service identities', async () => {
    const seam = trustedRuntimeSeam({ identity: { realUid: 501, effectiveUid: 502 } })
    await expect(assertRuntimePythonBinding(
      seam.python,
      buildReleaseManifestV2(makeCore()).sidecarEnvironment.receipt,
      { trustMode: 'deployment', publisherUid: 700, runtimeTrustTestSeam: seam },
    )).rejects.toThrow('paper_local_service_uid_unsafe')
  })
})

function fakeDirectory(uid: number, mode = 0o755) {
  return {
    uid,
    mode,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  }
}

function fakeFile(uid: number, mode = 0o644) {
  return {
    uid,
    mode,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  }
}

function fakeSymlink(uid: number) {
  return {
    uid,
    mode: 0o777,
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => true,
  }
}

function trustedRuntimeSeam(options: {
  pyvenv?: string
  identity?: { realUid: number, effectiveUid: number }
} = {}) {
  const publisherUid = 700
  const python = '/trusted/runtime/venv/bin/python'
  const directories = [
    '/', '/trusted', '/trusted/runtime', '/trusted/runtime/venv', '/trusted/runtime/venv/bin',
    '/trusted/runtime/venv/lib', '/trusted/runtime/venv/lib/python3.13', '/trusted/runtime/venv/lib/python3.13/site-packages',
    '/trusted/runtime/base', '/trusted/runtime/base/bin', '/trusted/runtime/base/lib', '/trusted/runtime/base/lib/python3.13',
  ]
  const statuses = new Map<string, ReturnType<typeof fakeDirectory> | ReturnType<typeof fakeFile> | ReturnType<typeof fakeSymlink>>(
    directories.map((path) => [path, fakeDirectory(path === '/' || path === '/trusted' ? 0 : publisherUid)]),
  )
  statuses.set(python, fakeFile(publisherUid, 0o755))
  statuses.set('/trusted/runtime/venv/pyvenv.cfg', fakeFile(publisherUid))
  statuses.set('/trusted/runtime/base/lib/python3.13/os.py', fakeFile(publisherUid))
  const writable = new Set<string>()
  const hashes = new Map<string, string>()
  const readEntries = (path: string) => [...statuses.entries()]
    .filter(([entry]) => join(entry, '..') === path)
    .map(([entry, status]) => ({
      name: entry.split('/').at(-1)!,
      isDirectory: status.isDirectory,
      isFile: status.isFile,
      isSymbolicLink: status.isSymbolicLink,
    }))
  return {
    python,
    runCaptured: undefined as undefined | ((command: string, args: string[], options: unknown) => Promise<{ code: number, stdout: string, stderr: string }>),
    setStatus: (path: string, status: ReturnType<typeof fakeDirectory> | ReturnType<typeof fakeFile> | ReturnType<typeof fakeSymlink>) => statuses.set(path, status),
    setWritable: (path: string) => writable.add(path),
    setHash: (path: string, hash: string) => hashes.set(path, hash),
    identity: options.identity ?? { realUid: 501, effectiveUid: 501 },
    filesystem: {
      lstat: async (path: string) => {
        const status = statuses.get(path)
        if (!status) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return status
      },
      readdir: async (path: string) => readEntries(path),
      realpath: async (path: string) => path,
      readFile: async (path: string) => {
        if (path !== '/trusted/runtime/venv/pyvenv.cfg') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return options.pyvenv ?? 'home = /trusted/runtime/base/bin\n'
      },
      hashFile: async (path: string) => hashes.get(path) ?? (path === python ? '9'.repeat(64) : path === '/trusted/runtime/venv/pyvenv.cfg' ? '0'.repeat(64) : 'a'.repeat(64)),
      access: async (path: string) => {
        if (writable.has(path)) return undefined
        throw Object.assign(new Error('not writable'), { code: 'EACCES' })
      },
    },
  }
}

function makeCore(): ReleaseManifestV2Core {
  const contractHash = 'a'.repeat(64)
  const lockHash = 'b'.repeat(64)
  const wheelManifestHash = 'c'.repeat(64)
  const protoHash = 'd'.repeat(64)
  const environmentReceiptHash = 'e'.repeat(64)
  const validationReceipts = D1_RELEASE_CHECK_IDS.map((checkId, index) => ({
    checkId,
    path: `release-metadata/validation-receipts/${checkId}.validation_receipt.v1.json`,
    receiptHash: `${index + 1}`.repeat(64),
    sourceCommit: COMMIT,
    dirtyStateHash: EMPTY_SHA256,
    executedAt: '2026-08-15T01:00:00.000Z',
    expiresAt: '2026-08-15T02:00:00.000Z',
    status: 'pass' as const,
  }))
  const artifactHashes: Record<string, string> = Object.fromEntries(
    REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2.map((path) => [path, 'f'.repeat(64)]),
  )
  Object.assign(artifactHashes, {
    'package.json': '4'.repeat(64),
    'pnpm-lock.yaml': '5'.repeat(64),
    [SIDECAR_ENVIRONMENT_RECEIPT_PATH]: environmentReceiptHash,
    [D1_RELEASE_BUNDLE_METADATA_PATH]: 'e'.repeat(64),
    [SIDECAR_RUNTIME_CONTRACT_PATH]: contractHash,
    [SIDECAR_RUNTIME_LOCK_PATH]: lockHash,
    [SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH]: wheelManifestHash,
    [EXECUTION_PROTO_PATH]: protoHash,
    'dist/proto/openalice_execution_v1.proto': protoHash,
    [PIPELINE_REGISTRY_METADATA_PATH]: '6'.repeat(64),
    [DEPENDENCY_LOCK_METADATA_PATH]: '7'.repeat(64),
    [STRATEGY_CONFIG_METADATA_PATH]: '8'.repeat(64),
    ...Object.fromEntries(
      validationReceipts.map((receipt) => [receipt.path, receipt.receiptHash]),
    ),
  })
  return {
    releaseId: COMMIT,
    sourceCommit: COMMIT,
    dirtyStateHash: EMPTY_SHA256,
    builtAt: '2026-08-15T01:10:00.000Z',
    runtimeEntry: 'ops/release/launch_nautilus_paper.sh',
    artifactHashes,
    pipelineRegistryHash: '6'.repeat(64),
    dependencyLockHash: '7'.repeat(64),
    strategyConfigHash: '8'.repeat(64),
    validationReceipts,
    sidecarEnvironment: {
      receiptPath: SIDECAR_ENVIRONMENT_RECEIPT_PATH,
      receiptHash: environmentReceiptHash,
      contractPath: SIDECAR_RUNTIME_CONTRACT_PATH,
      receipt: {
        schemaVersion: 'openalice_sidecar_environment_receipt.v1',
        contractHash,
        interpreterHash: '9'.repeat(64),
        pyvenvCfgHash: '0'.repeat(64),
        baseRuntimeAggregate: trustedBaseRuntimeAggregate(),
        sitePackagesAggregate: trustedSitePackagesAggregate(),
        installedAggregate: '1'.repeat(64),
        lockHash,
        wheelManifestHash,
        protoHash,
        generatedAggregate: '2'.repeat(64),
        target: {
          implementation: 'CPython',
          python: '3.13.5',
          cacheTag: 'cpython-313',
          system: 'Darwin',
          macosMajor: 26,
          machine: 'arm64',
        },
        flags: {
          paperOnly: true,
          liveTradingAllowed: false,
          liveExecutionArmed: false,
        },
        executedAt: '2026-08-15T00:59:00.000Z',
        status: 'pass',
      },
    },
    admissionDecisionId: null,
    engineeringChecks: [...D1_RELEASE_CHECK_IDS],
    liveExecutionArmed: false,
  }
}

function trustedBaseRuntimeAggregate() {
  return aggregate([
    { path: '', type: 'directory', uid: 700, mode: 0o755, sha256: null },
    { path: 'bin', type: 'directory', uid: 700, mode: 0o755, sha256: null },
    { path: 'lib', type: 'directory', uid: 700, mode: 0o755, sha256: null },
    { path: 'lib/python3.13', type: 'directory', uid: 700, mode: 0o755, sha256: null },
    { path: 'lib/python3.13/os.py', type: 'file', uid: 700, mode: 0o644, sha256: 'a'.repeat(64) },
  ])
}

function trustedSitePackagesAggregate() {
  return aggregate([
    { path: '', type: 'directory', uid: 700, mode: 0o755, sha256: null },
  ])
}

function aggregate(entries: readonly Record<string, unknown>[]) {
  return createHash('sha256').update(canonicalJson([...entries].sort((left, right) => compareCodePoints(String(left.path), String(right.path))))).digest('hex')
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

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
