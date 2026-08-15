import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAccountCorruptionGateStatus,
  parseAccountCorruptionGateStatusArgs,
  runAccountCorruptionGateStatus,
  scanAccountStateFiles,
} from './build_account_corruption_gate_status.js'

describe('build_account_corruption_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseAccountCorruptionGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
      accountStateDir: 'data/paper_trading',
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:account-corruption-gate']).toContain('build_account_corruption_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_account_corruption_gate_status.ts')
  })

  it('scans files and reports no corruption in a clean directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-account-corruption-'))
    await mkdir(root, { recursive: true })

    const checks = await scanAccountStateFiles(root)
    expect(checks).toEqual([])
  })

  it('detects corrupt JSON files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-account-corruption-'))
    await mkdir(root, { recursive: true })

    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'good.json'), JSON.stringify({ equity: 1000 }), 'utf-8')
    await writeFile(join(root, 'bad.json'), 'not valid json', 'utf-8')

    const checks = await scanAccountStateFiles(root)
    expect(checks).toHaveLength(2)
    const good = checks.find(c => c.file === 'good.json')
    expect(good?.corrupt).toBe(false)
    expect(good?.error).toBeNull()
    const bad = checks.find(c => c.file === 'bad.json')
    expect(bad?.corrupt).toBe(true)
    expect(bad?.error).toBeTruthy()
  })

  it('produces valid report structure with no corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-account-corruption-'))
    await mkdir(root, { recursive: true })

    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'good.json'), JSON.stringify({ equity: 1000 }), 'utf-8')

    const report = await buildAccountCorruptionGateStatus('2026-05-08T06:00:00.000Z', root)

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T06:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'pass',
    })

    expect(report.checks.accountFilesExist.found).toBe(true)
    expect(report.checks.accountFilesExist.count).toBe(1)
    expect(report.checks.accountFilesExist.verdict).toContain('account state file(s) found')
    expect(report.checks.corruptFiles.found).toBe(false)
    expect(report.checks.corruptFiles.corruptCount).toBe(0)
    expect(report.checks.corruptFiles.verdict).toContain('All')
    expect(report.checks.failClosedMechanism.found).toBe(false)
    expect(report.checks.failClosedMechanism.verdict).toContain('No corruption')
    expect(report.blockers).toEqual([])
  })

  it('blocks when corrupt files exist and adds blockers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-account-corruption-'))
    await mkdir(root, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'bad.json'), 'trash', 'utf-8')
    await writeFile(join(root, 'also_bad.json'), '{invalid', 'utf-8')

    const checks = await scanAccountStateFiles(root)
    const corruptCount = checks.filter(c => c.corrupt).length
    expect(corruptCount).toBe(2)

    const report = await buildAccountCorruptionGateStatus('2026-05-08T06:00:00.000Z', root)
    expect(report.status).toBe('block')
    expect(report.checks.corruptFiles.found).toBe(true)
    expect(report.checks.corruptFiles.corruptCount).toBe(2)
    expect(report.checks.failClosedMechanism.found).toBe(true)
    expect(report.blockers).toEqual([
      'Account state corruption detected: 2 file(s) failed integrity check',
    ])
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-account-corruption-'))
    const outputPath = join(root, 'account_corruption_gate_status.latest.json')
    const accountStateDir = join(root, 'state')
    await mkdir(root, { recursive: true })
    await mkdir(accountStateDir, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(accountStateDir, 'good.json'), JSON.stringify({ equity: 1000 }), 'utf-8')

    const report = await runAccountCorruptionGateStatus({
      outputPath,
      json: false,
      accountStateDir,
    })

    expect(report.status).toBe('pass')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      schemaVersion: 1,
      researchOnly: true,
      diagnosticOnly: true,
      status: 'pass',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'account_corruption_gate_status',
      businessStatus: 'pass',
    })
  })

  it('writes failing manifest when corrupt files block the gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-account-corruption-'))
    const outputPath = join(root, 'account_corruption_gate_status.latest.json')
    const accountStateDir = join(root, 'state')
    await mkdir(accountStateDir, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(accountStateDir, 'bad.json'), '{bad', 'utf-8')

    const report = await runAccountCorruptionGateStatus({
      outputPath,
      json: false,
      accountStateDir,
    })

    expect(report.status).toBe('block')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      status: 'block',
      blockers: ['Account state corruption detected: 1 file(s) failed integrity check'],
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'account_corruption_gate_status',
      businessStatus: 'fail',
    })
  })
})
