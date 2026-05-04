import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPaperEvidenceReport,
  buildPaperFreshnessSeal,
  evaluatePaperEvidenceLedgerBinding,
  evaluatePaperEvidencePointer,
  assertPaperEvidenceLedgerPath,
  parsePaperEvidenceLedgerJsonl,
  paperEvidenceLedgerEntryToJson,
  paperEvidenceReportFromJson,
  paperEvidenceReportToJson,
  readLatestPaperEvidencePointer,
  refreshPaperEvidenceReportFreshness,
  writePaperEvidenceReport,
} from './paper_evidence_ledger.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('paper evidence ledger v4.1', () => {
  it('marks reports fresh at the max-age boundary and stale after it', () => {
    const generatedAt = '2026-05-02T00:00:00.000Z'

    expect(
      buildPaperFreshnessSeal(generatedAt, new Date('2026-05-02T00:15:00.000Z'), 900),
    ).toMatchObject({
      actualAgeSeconds: 900,
      status: 'fresh',
    })
    expect(
      buildPaperFreshnessSeal(generatedAt, new Date('2026-05-02T00:15:01.000Z'), 900),
    ).toMatchObject({
      actualAgeSeconds: 901,
      status: 'stale',
    })
  })

  it('writes immutable report, JSONL ledger, and latest pointer', () => {
    const root = tempRoot()
    const summary = {
      generatedAt: '2026-05-02T00:00:00.000Z',
      dryRun: true,
      paperDataMode: 'live_only',
      status: 'passed',
    }
    const report = buildPaperEvidenceReport({
      summary,
      summaryPath: 'data/runtime/paper_shadow_loop.latest.json',
      runtimeCommit: 'abc123',
      dataManifestHash: 'sha256:data',
      now: new Date('2026-05-02T00:00:30.000Z'),
    })

    const result = writePaperEvidenceReport({ report, root })

    const reportJson = JSON.parse(readFileSync(result.reportPath, 'utf-8')) as Record<string, unknown>
    const ledgerLines = readFileSync(result.ledgerPath, 'utf-8').trim().split('\n')
    const pointer = readLatestPaperEvidencePointer(result.latestPointerPath)

    expect(report.reportId).toMatch(/^paper_20260502T000000Z_[a-f0-9]{16}$/)
    expect(reportJson).toMatchObject({
      schema_version: 'paper_evidence_report.v4_1',
      report_id: report.reportId,
      runtime_commit: 'abc123',
      data_manifest_hash: 'sha256:data',
      paper_data_mode: 'live_only',
      freshness: {
        actual_age_seconds: 30,
        status: 'fresh',
      },
    })
    expect(ledgerLines).toHaveLength(1)
    expect(JSON.parse(ledgerLines[0])).toMatchObject({
      schema_version: 'paper_evidence_ledger.v4_1',
      report_id: report.reportId,
      paper_data_mode: 'live_only',
      freshness_status: 'fresh',
    })
    expect(pointer).toMatchObject({
      schemaVersion: 'paper_evidence_latest_pointer.v4_1',
      latestReportId: report.reportId,
      path: result.reportPath,
    })
  })

  it('parses persisted snake_case reports back into camelCase TS reports', () => {
    const paperDecision = { status: 'updated_positions', orders: [] }
    const report = buildPaperEvidenceReport({
      summary: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        paperDataMode: 'live_only',
      },
      summaryPath: 'data/runtime/paper_shadow_loop.latest.json',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecision,
      now: new Date('2026-05-02T00:00:30.000Z'),
    })

    const parsed = paperEvidenceReportFromJson(paperEvidenceReportToJson(report))

    expect(report.paperDecisionHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(parsed).toMatchObject({
      schemaVersion: 'paper_evidence_report.v4_1',
      reportId: report.reportId,
      paperDataMode: 'live_only',
      paperDecisionPath: expect.stringContaining('paper_decision.latest.json'),
      paperDecisionHash: report.paperDecisionHash,
      freshness: {
        actualAgeSeconds: 30,
        status: 'fresh',
      },
    })
  })

  it('evaluates stale reports as stale_report_halt without force closing existing positions', () => {
    const report = buildPaperEvidenceReport({
      summary: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        paperDataMode: 'live_only',
      },
      summaryPath: 'data/runtime/paper_shadow_loop.latest.json',
      now: new Date('2026-05-02T00:16:00.000Z'),
      maxAllowedAgeSeconds: 900,
    })

    const evaluation = evaluatePaperEvidencePointer(
      {
        schemaVersion: 'paper_evidence_latest_pointer.v4_1',
        latestReportId: report.reportId,
        path: '/tmp/report.json',
        updatedAt: '2026-05-02T00:16:00.000Z',
      },
      report,
      new Date('2026-05-02T00:16:00.000Z'),
    )

    expect(evaluation).toMatchObject({
      status: 'stale_report_halt',
      blockNewOpens: true,
      forceCloseExisting: false,
      alert: true,
      blockingReasons: [{
        code: 'STALE_PAPER_EVIDENCE_REPORT',
        severity: 'hard_block',
      }],
    })
  })

  it('recomputes report freshness at gate evaluation time without mutating stored report', () => {
    const report = buildPaperEvidenceReport({
      summary: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        paperDataMode: 'live_only',
      },
      summaryPath: 'data/runtime/paper_shadow_loop.latest.json',
      now: new Date('2026-05-02T00:00:30.000Z'),
      maxAllowedAgeSeconds: 900,
    })
    const refreshed = refreshPaperEvidenceReportFreshness(
      report,
      new Date('2026-05-02T00:16:00.000Z'),
    )

    expect(report.freshness).toMatchObject({
      actualAgeSeconds: 30,
      status: 'fresh',
    })
    expect(refreshed.freshness).toMatchObject({
      actualAgeSeconds: 960,
      status: 'stale',
    })
    expect(evaluatePaperEvidencePointer(
      {
        schemaVersion: 'paper_evidence_latest_pointer.v4_1',
        latestReportId: report.reportId,
        path: '/tmp/report.json',
        updatedAt: '2026-05-02T00:00:30.000Z',
      },
      report,
      new Date('2026-05-02T00:16:00.000Z'),
    )).toMatchObject({
      status: 'stale_report_halt',
      blockingReasons: [{ code: 'STALE_PAPER_EVIDENCE_REPORT' }],
    })
  })

  it('hard-blocks pointer/report mismatch and non-live-only paper evidence', () => {
    const report = buildPaperEvidenceReport({
      summary: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        paperDataMode: 'auto',
      },
      summaryPath: 'data/runtime/paper_shadow_loop.latest.json',
      now: new Date('2026-05-02T00:00:30.000Z'),
    })

    expect(evaluatePaperEvidencePointer(
      {
        schemaVersion: 'paper_evidence_latest_pointer.v4_1',
        latestReportId: 'different_report_id',
        path: '/tmp/report.json',
        updatedAt: '2026-05-02T00:00:30.000Z',
      },
      report,
      new Date('2026-05-02T00:00:30.000Z'),
    )).toMatchObject({
      status: 'stale_report_halt',
      blockNewOpens: true,
      forceCloseExisting: false,
      alert: true,
      blockingReasons: [
        { code: 'PAPER_EVIDENCE_POINTER_REPORT_MISMATCH' },
        { code: 'PAPER_EVIDENCE_NOT_LIVE_ONLY' },
      ],
    })
  })

  it('preserves pointer mismatch and non-live-only reasons when the report is also stale', () => {
    const report = buildPaperEvidenceReport({
      summary: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        paperDataMode: 'auto',
      },
      summaryPath: 'data/runtime/paper_shadow_loop.latest.json',
      now: new Date('2026-05-02T00:00:30.000Z'),
      maxAllowedAgeSeconds: 900,
    })

    const evaluation = evaluatePaperEvidencePointer(
      {
        schemaVersion: 'paper_evidence_latest_pointer.v4_1',
        latestReportId: 'different_report_id',
        path: '/tmp/report.json',
        updatedAt: '2026-05-02T00:00:30.000Z',
      },
      report,
      new Date('2026-05-02T00:16:00.000Z'),
    )

    expect(evaluation).toMatchObject({
      status: 'stale_report_halt',
      blockNewOpens: true,
      forceCloseExisting: false,
      alert: true,
      blockingReasons: [
        { code: 'PAPER_EVIDENCE_POINTER_REPORT_MISMATCH' },
        { code: 'PAPER_EVIDENCE_NOT_LIVE_ONLY' },
        { code: 'STALE_PAPER_EVIDENCE_REPORT' },
      ],
    })
  })

  it('hard-blocks reports without a freshness seal', () => {
    const evaluation = evaluatePaperEvidencePointer(
      {
        schemaVersion: 'paper_evidence_latest_pointer.v4_1',
        latestReportId: 'paper_missing_seal',
        path: '/tmp/report.json',
        updatedAt: '2026-05-02T00:00:00.000Z',
      },
      {} as never,
    )

    expect(evaluation).toMatchObject({
      status: 'missing_freshness_seal',
      blockNewOpens: true,
      forceCloseExisting: false,
      alert: true,
      blockingReasons: [{
        code: 'MISSING_FRESHNESS_SEAL',
      }],
    })
  })

  it('parses paper evidence ledger jsonl and rejects corrupt lines', () => {
    const report = buildPaperEvidenceReport({
      summary: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        paperDataMode: 'live_only',
      },
      summaryPath: 'data/runtime/paper_shadow_loop.latest.json',
      now: new Date('2026-05-02T00:00:30.000Z'),
    })
    const entry = {
      schemaVersion: 'paper_evidence_ledger.v4_1' as const,
      reportId: report.reportId,
      generatedAt: report.generatedAt,
      path: '/tmp/report.json',
      sourceRunId: report.sourceRunId,
      paperDataMode: report.paperDataMode,
      freshnessStatus: report.freshness.status,
      sourceSummaryHash: report.sourceSummaryHash,
    }

    expect(parsePaperEvidenceLedgerJsonl(`${JSON.stringify(paperEvidenceLedgerEntryToJson(entry))}\n`))
      .toEqual([entry])
    expect(() => parsePaperEvidenceLedgerJsonl('{"not":"valid"}\n'))
      .toThrow(/CORRUPT_PAPER_EVIDENCE_LEDGER line 1/)
  })

  it('accepts only the canonical promotion-grade paper evidence ledger path', () => {
    expect(() => assertPaperEvidenceLedgerPath('runtime/paper/evidence_ledger.jsonl')).not.toThrow()
    expect(() => assertPaperEvidenceLedgerPath('evidence_ledger.jsonl')).not.toThrow()
  })

  it('rejects shadow ledger paths as promotion-grade paper evidence ledgers', () => {
    expect(() => assertPaperEvidenceLedgerPath('data/paper_trading/paper_policy_shadow_ledger.jsonl'))
      .toThrow('PAPER_EVIDENCE_LEDGER_PATH_IS_SHADOW_LEDGER')
  })

  it('rejects non-canonical promotion-grade paper evidence ledger file names', () => {
    expect(() => assertPaperEvidenceLedgerPath('runtime/paper/shadow_opportunity_ledger.jsonl'))
      .toThrow('PAPER_EVIDENCE_LEDGER_PATH_NOT_CANONICAL')
  })

  it('hard-blocks when latest pointer report is absent from the append-only ledger', () => {
    const report = buildPaperEvidenceReport({
      summary: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        paperDataMode: 'live_only',
      },
      summaryPath: 'data/runtime/paper_shadow_loop.latest.json',
      now: new Date('2026-05-02T00:00:30.000Z'),
    })

    const evaluation = evaluatePaperEvidenceLedgerBinding(
      {
        schemaVersion: 'paper_evidence_latest_pointer.v4_1',
        latestReportId: report.reportId,
        path: '/tmp/report.json',
        updatedAt: '2026-05-02T00:00:30.000Z',
      },
      report,
      [{
        schemaVersion: 'paper_evidence_ledger.v4_1',
        reportId: 'different_report',
        generatedAt: report.generatedAt,
        path: '/tmp/report.json',
        sourceRunId: report.sourceRunId,
        paperDataMode: report.paperDataMode,
        freshnessStatus: report.freshness.status,
        sourceSummaryHash: report.sourceSummaryHash,
      }],
    )

    expect(evaluation).toMatchObject({
      matchedEntry: null,
      blockingReasons: [{ code: 'PAPER_EVIDENCE_REPORT_NOT_IN_LEDGER' }],
    })
  })

  it('hard-blocks when append-only ledger core fields disagree with latest pointer report', () => {
    const report = buildPaperEvidenceReport({
      summary: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        paperDataMode: 'live_only',
      },
      summaryPath: 'data/runtime/paper_shadow_loop.latest.json',
      now: new Date('2026-05-02T00:00:30.000Z'),
    })

    const evaluation = evaluatePaperEvidenceLedgerBinding(
      {
        schemaVersion: 'paper_evidence_latest_pointer.v4_1',
        latestReportId: report.reportId,
        path: '/tmp/report.json',
        updatedAt: '2026-05-02T00:00:30.000Z',
      },
      report,
      [{
        schemaVersion: 'paper_evidence_ledger.v4_1',
        reportId: report.reportId,
        generatedAt: report.generatedAt,
        path: '/tmp/other-report.json',
        sourceRunId: report.sourceRunId,
        paperDataMode: 'auto',
        freshnessStatus: report.freshness.status,
        sourceSummaryHash: 'sha256:wrong',
      }],
    )

    expect(evaluation.blockingReasons.map((reason) => reason.code)).toEqual([
      'PAPER_EVIDENCE_LEDGER_PATH_MISMATCH',
      'PAPER_EVIDENCE_LEDGER_DATA_MODE_MISMATCH',
      'PAPER_EVIDENCE_LEDGER_SOURCE_SUMMARY_HASH_MISMATCH',
    ])
  })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openalice-paper-evidence-'))
  roots.push(root)
  return root
}
