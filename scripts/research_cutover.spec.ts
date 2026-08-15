import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertCutoverReleaseClosure,
  assertWithinDowntime,
  PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_BLOCKER,
  paperLocalTwoIdentityDeploymentBlockers,
  remainingDowntimeMilliseconds,
  validatePaperLocalLaunchInputs,
} from './research_cutover.js'
import { D1_RELEASE_REQUIRED_ARTIFACT_PATHS } from '../src/runtime/release_manifest.js'

const remediationRoot = resolve('.')
const releaseRoot = join(remediationRoot, 'runtime/releases')
const releaseId = 'a54a95fdb1b24b2e6ed5ea93c47c9c33e5649d91'
const legacyRepoRoot = resolve('../../OpenAlice')
const freezeReceipt = resolve('../archive/legacy_wip.latest.json')

function runPreflight(tempRoot: string, freezePath: string): Promise<Record<string, unknown>> {
  const args = [
    'scripts/research_cutover.ts',
    '--releaseRoot', releaseRoot,
    '--releaseId', releaseId,
    '--legacyRepoRoot', legacyRepoRoot,
    '--freezeReceipt', freezePath,
    '--canaryReceipt', join(tempRoot, 'missing-canary.json'),
    '--jobsPath', join(legacyRepoRoot, 'data/cron/jobs.json'),
    '--registryPath', join(remediationRoot, 'ops/pipeline/pipeline_registry.v1.json'),
    '--launchdLabel', 'ai.openalice.main',
    '--launchdPlist', join(tempRoot, 'ai.openalice.main.plist'),
    '--launchWrapper', join(tempRoot, 'launch_openalice_current.sh'),
    '--backupDir', tempRoot,
    '--receiptDir', tempRoot,
    '--execute', 'false',
  ]
  return new Promise((resolvePromise, reject) => {
    const child = spawn('./node_modules/.bin/tsx', args, {
      cwd: remediationRoot,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`research_cutover preflight exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`))
        return
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(stdout).toString('utf8')) as Record<string, unknown>)
      } catch (error) {
        reject(new Error(`research_cutover preflight emitted invalid JSON: ${String(error)}`))
      }
    })
  })
}

describe('research_cutover preflight', () => {
  it('revalidates the frozen 555-entry WIP before applying the canary gate', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openalice-research-cutover-'))
    const result = await runPreflight(tempRoot, freezeReceipt)
    const verification = result.legacyWipVerification as Record<string, unknown>

    expect(result.status).toBe('blocked')
    expect(result.blockers).toContain('canary_receipt_missing_or_invalid')
    expect(verification.status).toBe('pass')
    expect(verification.expectedEntryCount).toBe(555)
    expect(verification.sourceHashCheckedCount).toBe(525)
    expect(verification.driftDetected).toBe(false)
  })

  it('fails closed when the freeze receipt no longer matches the legacy WIP', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openalice-research-cutover-drift-'))
    const original = JSON.parse(await readFile(freezeReceipt, 'utf8')) as Record<string, unknown>
    const originalStatus = original.status as Record<string, unknown>
    const tampered = { ...original, status: { ...originalStatus, entryCount: 554 } }
    const tamperedPath = join(tempRoot, 'legacy_wip.tampered.json')
    await writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 })
    await chmod(tamperedPath, 0o600)

    const result = await runPreflight(tempRoot, tamperedPath)
    const verification = result.legacyWipVerification as Record<string, unknown>

    expect(result.status).toBe('blocked')
    expect(result.blockers).toContain('legacy_wip_drift_detected')
    expect(verification.status).toBe('blocked')
    expect(verification.driftDetected).toBe(true)
  })
})

describe('research_cutover downtime budget', () => {
  it('rejects an already expired maintenance window', async () => {
    await expect(assertWithinDowntime(Date.now() - 2_000, 1)).rejects.toThrow(
      'research_cutover_downtime_budget_exceeded',
    )
  })

  it('returns a bounded command timeout while the window remains', () => {
    const remaining = remainingDowntimeMilliseconds(Date.now(), 5)
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(5_000)
  })

  it('rejects non-positive remaining command time', () => {
    expect(() => remainingDowntimeMilliseconds(Date.now() - 2_000, 1)).toThrow(
      'research_cutover_downtime_budget_exceeded',
    )
  })
})

describe('research_cutover PAPER_LOCAL pinned launch inputs', () => {
  it('fails closed when any V2 shell runtime pin is missing or malformed', () => {
    expect(validatePaperLocalLaunchInputs({})).toEqual([
      'paper_local_node_missing_or_not_absolute',
      'paper_local_node_sha256_missing_or_invalid',
      'paper_local_mjs_sha256_missing_or_invalid',
      'paper_local_python_missing_or_not_absolute',
      'paper_local_publisher_uid_missing_or_invalid',
    ])
    expect(validatePaperLocalLaunchInputs({
      paperLocalNode: 'node',
      paperLocalNodeSha256: 'A'.repeat(64),
      paperLocalMjsSha256: 'B'.repeat(64),
      paperLocalPython: 'python3',
      paperLocalPublisherUid: '-1',
    })).toEqual([
      'paper_local_node_missing_or_not_absolute',
      'paper_local_node_sha256_missing_or_invalid',
      'paper_local_mjs_sha256_missing_or_invalid',
      'paper_local_python_missing_or_not_absolute',
      'paper_local_publisher_uid_missing_or_invalid',
    ])
  })

  it('accepts only fully explicit, pinned V2 shell runtime inputs', () => {
    expect(validatePaperLocalLaunchInputs({
      paperLocalNode: '/opt/openalice/node',
      paperLocalNodeSha256: 'a'.repeat(64),
      paperLocalMjsSha256: 'b'.repeat(64),
      paperLocalPython: '/opt/openalice/venv/bin/python3.13',
      paperLocalPublisherUid: '502',
    })).toEqual([])
  })
})

describe('research_cutover manifest closure', () => {
  const d1ArtifactHashes = () => Object.fromEntries(
    D1_RELEASE_REQUIRED_ARTIFACT_PATHS.map((path) => [path, 'a'.repeat(64)]),
  )

  it('does not apply V1 default or node_modules requirements to a legal V2 D1 allowlist', () => {
    expect(() => assertCutoverReleaseClosure({
      schemaVersion: 'release_manifest.v2',
      artifactHashes: d1ArtifactHashes(),
    })).not.toThrow()
  })

  it('keeps the V2 exact allowlist: missing required artifacts and additions are blocked', () => {
    const missing = d1ArtifactHashes()
    delete missing['sidecars/nautilus_paper/supervisor.py']
    expect(() => assertCutoverReleaseClosure({
      schemaVersion: 'release_manifest.v2',
      artifactHashes: missing,
    })).toThrow('execution_sidecar_release_artifact_missing:sidecars/nautilus_paper/supervisor.py')

    expect(() => assertCutoverReleaseClosure({
      schemaVersion: 'release_manifest.v2',
      artifactHashes: {
        ...d1ArtifactHashes(),
        'default/config.json': 'b'.repeat(64),
      },
    })).toThrow('d1_release_forbidden_artifact:default/config.json:general_default_bundle')
  })

  it('retains the V1 app-deploy closure requirements', () => {
    expect(() => assertCutoverReleaseClosure({
      schemaVersion: 'release_manifest.v1',
      artifactHashes: {
        'dist/main.js': 'a'.repeat(64),
        'scripts/runner.ts': 'a'.repeat(64),
        'src/runtime.ts': 'a'.repeat(64),
        'sidecars/runtime.py': 'a'.repeat(64),
        'ops/release.sh': 'a'.repeat(64),
        'package.json': 'a'.repeat(64),
        'pnpm-lock.yaml': 'a'.repeat(64),
        'release-metadata/registry.json': 'a'.repeat(64),
      },
    })).toThrow('research_release_closure_missing:default/')
  })
})

describe('research_cutover two-identity PAPER_LOCAL deployment boundary', () => {
  it('blocks V2 one-shot cutover even when environment UID strings differ', () => {
    const previousPublisher = process.env.OPENALICE_RELEASE_PUBLISHER_UID
    const previousService = process.env.OPENALICE_SERVICE_UID
    process.env.OPENALICE_RELEASE_PUBLISHER_UID = '502'
    process.env.OPENALICE_SERVICE_UID = '501'
    try {
      expect(validatePaperLocalLaunchInputs({
        paperLocalNode: '/opt/openalice/node',
        paperLocalNodeSha256: 'a'.repeat(64),
        paperLocalMjsSha256: 'b'.repeat(64),
        paperLocalPython: '/opt/openalice/venv/bin/python3.13',
        paperLocalPublisherUid: '502',
      })).toEqual([])
      expect(paperLocalTwoIdentityDeploymentBlockers({
        schemaVersion: 'release_manifest.v2',
      })).toEqual([PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_BLOCKER])
    } finally {
      if (previousPublisher === undefined) delete process.env.OPENALICE_RELEASE_PUBLISHER_UID
      else process.env.OPENALICE_RELEASE_PUBLISHER_UID = previousPublisher
      if (previousService === undefined) delete process.env.OPENALICE_SERVICE_UID
      else process.env.OPENALICE_SERVICE_UID = previousService
    }
  })

  it('keeps V1 cutover executable under its existing identity model', () => {
    expect(paperLocalTwoIdentityDeploymentBlockers({
      schemaVersion: 'release_manifest.v1',
    })).toEqual([])
  })
})
