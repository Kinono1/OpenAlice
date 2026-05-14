import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildPitAuditGlobalGateStatus,
  parsePitAuditGlobalGateStatusArgs,
  runPitAuditGlobalGateStatus,
} from './build_pit_audit_global_gate_status.js'

describe('build_pit_audit_global_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parsePitAuditGlobalGateStatusArgs(['--output', 'null', '--json'])).toMatchObject({
      outputPath: null,
      ethCarryPitAuditPath: 'data/research/eth_carry_pit_audit.latest.json',
      ethCarryEvidencePath: 'data/research/eth_carry_research_evidence_status.latest.json',
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:pit-audit-global-gate']).toContain('build_pit_audit_global_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_pit_audit_global_gate_status.ts')
  })

  it('reports watch when carry PIT audit passes but global audit not implemented', () => {
    const report = buildPitAuditGlobalGateStatus({
      generatedAt: '2026-05-08T07:00:00.000Z',
      ethCarryPitAudit: {
        status: 'pass',
        counts: {
          carryFeatureRows: 55101,
          auditedRows: 55101,
          passingRows: 55101,
          failingRows: 0,
        },
      },
      ethCarryEvidence: {
        pitEvidence: {
          fundingAvailableTimeStatus: 'complete',
          basisAvailableTimeStatus: 'present',
        },
      },
      collectorPitRowsAudit: {
        status: 'missing',
        sampledRows: 0,
        promotionUsableRows: 0,
        violations: [],
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T07:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked',
    })
    expect(report.checks.carryPitAuditStatus).toBe('pass')
    expect(report.checks.carryPitAuditPassingRows).toBe(55101)
    expect(report.checks.carryPitAuditTotalRows).toBe(55101)
    expect(report.checks.carryPitAuditPassRatePct).toBe(100)
    expect(report.checks.globalPitAuditImplemented).toBe(false)
    expect(report.blockers).toContain('pit_audit_not_global_only_carry_has_audit')
  })

  it('reports blocked when carry PIT audit is missing', () => {
    const report = buildPitAuditGlobalGateStatus({
      generatedAt: '2026-05-08T07:00:00.000Z',
      ethCarryPitAudit: null,
      ethCarryEvidence: null,
    })

    expect(report.status).toBe('blocked')
    expect(report.blockers).toContain('carry_pit_audit_artifact_missing')
    expect(report.blockers).toContain('carry_funding_available_time_not_complete:missing')
    expect(report.blockers).toContain('carry_basis_available_time_not_present:missing')
    expect(report.blockers).toContain('pit_audit_not_global_only_carry_has_audit')
  })

  it('reports blocked when carry PIT audit has failing rows', () => {
    const report = buildPitAuditGlobalGateStatus({
      generatedAt: '2026-05-08T07:00:00.000Z',
      ethCarryPitAudit: {
        status: 'partial',
        counts: {
          auditedRows: 100,
          passingRows: 80,
          failingRows: 20,
        },
      },
      ethCarryEvidence: {
        pitEvidence: {
          fundingAvailableTimeStatus: 'complete',
          basisAvailableTimeStatus: 'present',
        },
      },
    })

    expect(report.status).toBe('blocked')
    expect(report.blockers).toContain('carry_pit_audit_failing_rows:20')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-pit-audit-global-'))
    const pitAuditPath = join(root, 'eth_carry_pit_audit.latest.json')
    const evidencePath = join(root, 'eth_carry_research_evidence_status.latest.json')
    const collectorPitRowsPath = join(root, 'collector_pit_rows.jsonl')
    const outputPath = join(root, 'pit_audit_global_gate_status.latest.json')
    await mkdir(root, { recursive: true })
    await writeFile(pitAuditPath, JSON.stringify({
      status: 'pass',
      counts: {
        carryFeatureRows: 100,
        auditedRows: 100,
        passingRows: 100,
        failingRows: 0,
      },
    }), 'utf-8')
    await writeFile(evidencePath, JSON.stringify({
      pitEvidence: {
        fundingAvailableTimeStatus: 'complete',
        basisAvailableTimeStatus: 'present',
      },
    }), 'utf-8')
    await writeFile(collectorPitRowsPath, JSON.stringify({
      eventTime: '2026-05-08T00:00:00.000Z',
      observedAt: '2026-05-08T00:00:00.000Z',
      availableAt: '2026-05-08T00:00:00.000Z',
    }) + '\n', 'utf-8')

    const report = await runPitAuditGlobalGateStatus({
      outputPath,
      ethCarryPitAuditPath: pitAuditPath,
      ethCarryEvidencePath: evidencePath,
      collectorPitRowsPath,
      json: false,
    })

    expect(report.status).toBe('pass')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'pit_audit_global_gate_status',
      businessStatus: 'pass',
      recordsIn: 2,
      recordsOut: 1,
    })
  })
})
