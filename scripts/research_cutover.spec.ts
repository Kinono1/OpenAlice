import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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
