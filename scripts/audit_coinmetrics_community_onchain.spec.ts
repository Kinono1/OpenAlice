import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAuditCoinMetricsArgs, runAuditCoinMetricsOnchain } from './audit_coinmetrics_community_onchain.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'openalice-coinmetrics-audit-'))
}

describe('audit_coinmetrics_community_onchain', () => {
  it('parses cli args', () => {
    expect(parseAuditCoinMetricsArgs(['--input', '/tmp/in.jsonl', '--output', '/tmp/out.json'])).toEqual({
      inputPath: '/tmp/in.jsonl',
      outputPath: '/tmp/out.json',
      json: false,
    })
  })

  it('uses OPENALICE_DATA_ROOT for the canonical normalized input', () => {
    const previous = process.env.OPENALICE_DATA_ROOT
    process.env.OPENALICE_DATA_ROOT = '/local/openalice-data'
    try {
      expect(parseAuditCoinMetricsArgs([])).toEqual({
        inputPath: '/local/openalice-data/normalized/onchain/coinmetrics/asset_metrics_1d.normalized.jsonl',
        outputPath: join(process.cwd(), 'data/runtime/openalice_coinmetrics_onchain_audit.latest.json'),
        json: false,
      })
    } finally {
      if (previous == null) delete process.env.OPENALICE_DATA_ROOT
      else process.env.OPENALICE_DATA_ROOT = previous
    }
  })

  it('audits duplicates and ordering from normalized rows', async () => {
    const root = await tempRoot()
    const inputPath = join(root, 'normalized.jsonl')
    const outputPath = join(root, 'runtime/audit.json')
    await writeFile(inputPath, [
      JSON.stringify({ schemaVersion: 'openalice.coinmetrics.asset_metric.normalized.v1', source: 'coinmetrics_community', asset: 'btc', metric: 'PriceUSD', frequency: '1d', time: '2026-05-01T00:00:00.000Z', timeMs: Date.parse('2026-05-01T00:00:00.000Z'), value: 1, valueText: '1', unit: 'USD', availableAt: '2026-05-01T00:00:00.000Z', availableAtMs: Date.parse('2026-05-01T00:00:00.000Z'), ingestedAt: null, rawPayloadHash: 'a' }),
      JSON.stringify({ schemaVersion: 'openalice.coinmetrics.asset_metric.normalized.v1', source: 'coinmetrics_community', asset: 'btc', metric: 'PriceUSD', frequency: '1d', time: '2026-05-01T00:00:00.000Z', timeMs: Date.parse('2026-05-01T00:00:00.000Z'), value: 1, valueText: '1', unit: 'USD', availableAt: '2026-05-01T00:00:00.000Z', availableAtMs: Date.parse('2026-05-01T00:00:00.000Z'), ingestedAt: null, rawPayloadHash: 'b' }),
    ].join('\n') + '\n', 'utf-8')

    const report = await runAuditCoinMetricsOnchain({ inputPath, outputPath, json: true })
    expect(report.status).toBe('partial')
    expect(report.duplicateRows).toBe(1)
    const persisted = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(persisted.blockers).toContain('coinmetrics_duplicate_rows:1')
    expect(persisted.outputHash).toBe(report.outputHash)
    const persistedRaw = await readFile(outputPath, 'utf-8')
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest.artifactHash).toBe(createHash('sha256').update(persistedRaw).digest('hex'))
  })
})
