import { describe, expect, it } from 'vitest'
import {
  buildOpenAliceEvidencePacket,
  parseOpenAliceEvidencePacketArgs,
} from './build_openalice_evidence_packet.js'

describe('build_openalice_evidence_packet', () => {
  it('parses CLI defaults', () => {
    const args = parseOpenAliceEvidencePacketArgs([])
    expect(args.outputPath).toContain('openalice_evidence_packet')
    expect(args.json).toBe(false)
  })

  it('parses --output and --json flags', () => {
    const args = parseOpenAliceEvidencePacketArgs(['--output', '/tmp/test.json', '--json'])
    expect(args.outputPath).toBe('/tmp/test.json')
    expect(args.json).toBe(true)
  })

  it('builds evidence packet with schema and gate status via overrides', async () => {
    const packet = await buildOpenAliceEvidencePacket(
      { outputPath: null, json: false },
      {
        gitBranch: 'test-branch',
        headCommit: 'abc1234',
        dirtyCount: 0,
        gitAhead: 5,
        validationCommands: [
          { command: 'tsc --noEmit', exitCode: 0, passed: true, stdoutTail: '' },
        ],
      },
    )

    expect(packet.schemaVersion).toBe(1)
    expect(packet.generatedAt).toBeTruthy()
    expect(packet.gitStatus).toMatchObject({
      branch: 'test-branch',
      headCommit: 'abc1234',
      dirty: false,
    })
    expect(packet.gateStatus).toMatchObject({
      paperTradingAllowed: expect.any(Boolean),
      liveTradingAllowed: expect.any(Boolean),
      canPromote: expect.any(Boolean),
    })
    expect(packet.artifactAges.length).toBeGreaterThan(0)
    expect(packet.validationCommands.length).toBe(1)
    expect(packet.validationCommands[0].passed).toBe(true)
    expect(Array.isArray(packet.missingArtifacts)).toBe(true)
    expect(packet.paperDiagnosticsSummary).toMatchObject({
      rawClosedTrades: expect.any(Number),
      promotionCountedTrades: expect.any(Number),
      gapPendingExplanation: true,
    })
  }, 120_000)
})
