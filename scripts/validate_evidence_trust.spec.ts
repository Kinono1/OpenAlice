import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DATA_LINEAGE_PIT_POLICY,
  DATA_LINEAGE_SCHEMA_VERSION,
  type DataLineageGraph,
  dataLineageGraphToJson,
} from '../src/data/data_lineage.js'
import {
  buildEvidenceTrustValidationReport,
  parseValidateEvidenceTrustArgs,
  renderEvidenceTrustValidationReport,
} from './validate_evidence_trust.js'

describe('validate_evidence_trust', () => {
  it('passes only when all manifests are trusted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evidence-trust-pass-'))
    const manifestPath = join(dir, 'artifact.manifest.json')
    await writeManifest(manifestPath, {
      job: 'unit',
      evidenceTrust: 'pass',
      dqStatus: 'pass',
      businessStatus: 'pass',
    })

    const report = await buildEvidenceTrustValidationReport([manifestPath], {
      generatedAt: '2026-05-02T00:00:00.000Z',
      requireLineageGraph: false,
    })

    expect(report.passed).toBe(true)
    expect(report.checkedCount).toBe(1)
    expect(report.blockingManifests).toEqual([])
  })

  it('fails closed on quarantine, fail, missing evidenceTrust, and missing inputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evidence-trust-fail-'))
    const quarantine = join(dir, 'quarantine.manifest.json')
    const missingTrust = join(dir, 'missing-trust.manifest.json')
    await writeManifest(quarantine, {
      job: 'dirty_worktree_audit',
      evidenceTrust: 'quarantine',
      dqStatus: 'quarantine',
      businessStatus: 'warn',
    })
    await writeManifest(missingTrust, {
      job: 'legacy',
      dqStatus: 'pass',
      businessStatus: 'pass',
    })

    const report = await buildEvidenceTrustValidationReport([
      quarantine,
      missingTrust,
      join(dir, 'absent.manifest.json'),
    ], {
      generatedAt: '2026-05-02T00:00:00.000Z',
      requireLineageGraph: false,
    })

    expect(report.passed).toBe(false)
    expect(report.missingInputs).toEqual([join(dir, 'absent.manifest.json')])
    expect(report.blockingManifests.map((item) => item.reason)).toEqual([
      'evidence_trust_missing',
      'evidence_trust_not_pass:quarantine',
    ])
  })

  it('expands simple manifest globs recursively', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evidence-trust-glob-'))
    await writeManifest(join(dir, 'a.manifest.json'), {
      job: 'a',
      evidenceTrust: 'pass',
      dqStatus: 'pass',
      businessStatus: 'pass',
    })
    await writeManifest(join(dir, 'nested/b.manifest.json'), {
      job: 'b',
      evidenceTrust: 'fail',
      dqStatus: 'fail',
      businessStatus: 'fail',
    })

    const report = await buildEvidenceTrustValidationReport([join(dir, '**/*.manifest.json')], {
      generatedAt: '2026-05-02T00:00:00.000Z',
      requireLineageGraph: false,
    })

    expect(report.checkedCount).toBe(2)
    expect(report.passed).toBe(false)
    expect(report.blockingManifests).toHaveLength(1)
    expect(report.blockingManifests[0]?.job).toBe('b')
  })

  it('fails closed when Evidence OS trust inputs have no lineage graph', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evidence-trust-missing-lineage-'))
    await writeManifest(join(dir, 'artifact.manifest.json'), {
      job: 'trusted_artifact',
      evidenceTrust: 'pass',
      dqStatus: 'pass',
      businessStatus: 'pass',
    })

    const report = await buildEvidenceTrustValidationReport([dir], {
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.passed).toBe(false)
    expect(report.missingEvidence).toEqual(['DATA_LINEAGE_GRAPH_MISSING'])
  })

  it('validates data lineage latest files from directory inputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evidence-trust-lineage-pass-'))
    await writeManifest(join(dir, 'artifact.manifest.json'), {
      job: 'trusted_artifact',
      evidenceTrust: 'pass',
      dqStatus: 'pass',
      businessStatus: 'pass',
    })
    await writeDataLineage(join(dir, 'data_lineage.latest.json'), makeValidLineageGraph())

    const report = await buildEvidenceTrustValidationReport([dir], {
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.passed).toBe(true)
    expect(report.checkedCount).toBe(2)
    expect(report.blockingLineageGraphs).toEqual([])
    expect(report.lineageGraphs).toHaveLength(1)
    expect(report.lineageGraphs[0]).toMatchObject({
      schemaVersion: DATA_LINEAGE_SCHEMA_VERSION,
      passed: true,
      blockingReasons: [],
      errorClass: null,
    })
    expect(report.lineageGraphs[0]?.hash).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('hard-blocks invalid lineage graphs in trust reports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evidence-trust-lineage-fail-'))
    const graph = makeValidLineageGraph()
    graph.nodes[1] = {
      ...graph.nodes[1],
      parents: ['missing_raw_source'],
    }
    graph.nodes[2] = {
      ...graph.nodes[2],
      availableTimePolicy: 'available_time <= decision_time OR available_time > decision_time',
    }
    await writeDataLineage(join(dir, 'data_lineage.latest.json'), graph)

    const report = await buildEvidenceTrustValidationReport([dir], {
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.passed).toBe(false)
    expect(report.checkedCount).toBe(1)
    expect(report.blockingLineageGraphs).toHaveLength(1)
    expect(report.blockingLineageGraphs[0]?.blockingReasons).toEqual([
      'MISSING_LINEAGE_PARENT',
      'FEATURE_NON_PIT_AVAILABLE_TIME_POLICY',
    ])
  })

  it('expands data lineage files through recursive globs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evidence-trust-lineage-glob-'))
    await writeDataLineage(join(dir, 'nested/data_lineage.latest.json'), makeValidLineageGraph())

    const report = await buildEvidenceTrustValidationReport([join(dir, '**/data_lineage.latest.json')], {
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.passed).toBe(true)
    expect(report.checkedCount).toBe(1)
    expect(report.lineageGraphs).toHaveLength(1)
  })

  it('renders blockers for operator logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evidence-trust-render-'))
    const manifestPath = join(dir, 'artifact.manifest.json')
    await writeManifest(manifestPath, {
      job: 'unit',
      evidenceTrust: 'quarantine',
      dqStatus: 'quarantine',
      businessStatus: 'warn',
    })
    const report = await buildEvidenceTrustValidationReport([manifestPath], {
      generatedAt: '2026-05-02T00:00:00.000Z',
      requireLineageGraph: false,
    })
    const markdown = renderEvidenceTrustValidationReport(report)

    expect(markdown).toContain('# Evidence Trust Validation')
    expect(markdown).toContain('Passed: false')
    expect(markdown).toContain('evidence_trust_not_pass:quarantine')
  })

  it('parses json flag and positional manifests', () => {
    expect(parseValidateEvidenceTrustArgs(['--json', 'a.manifest.json'])).toEqual({
      json: true,
      requireLineageGraph: true,
      manifestInputs: ['a.manifest.json'],
    })
    expect(parseValidateEvidenceTrustArgs([
      '--json=false',
      '--requireLineageGraph=false',
      'a.manifest.json',
      'b.manifest.json',
    ])).toEqual({
      json: false,
      requireLineageGraph: false,
      manifestInputs: ['a.manifest.json', 'b.manifest.json'],
    })
  })
})

async function writeManifest(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

async function writeDataLineage(path: string, graph: DataLineageGraph): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(dataLineageGraphToJson(graph), null, 2)}\n`, 'utf-8')
}

function makeValidLineageGraph(): DataLineageGraph {
  return {
    schemaVersion: DATA_LINEAGE_SCHEMA_VERSION,
    generatedAt: '2026-05-02T00:00:00.000Z',
    nodes: [
      {
        id: 'binance_btcusdt_1m_raw',
        type: 'raw_source',
        qualityStatus: 'ok',
        source: 'binance',
        endpoint: '/api/v3/klines',
        symbol: 'BTCUSDT',
        firstTimestamp: '2026-05-01T00:00:00.000Z',
        lastTimestamp: '2026-05-02T00:00:00.000Z',
      },
      {
        id: 'btcusdt_1m_normalized',
        type: 'normalized_series',
        qualityStatus: 'ok',
        parents: ['binance_btcusdt_1m_raw'],
      },
      {
        id: 'btcusdt_1m_return_5',
        type: 'feature',
        qualityStatus: 'ok',
        parents: ['btcusdt_1m_normalized'],
        availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
      },
      {
        id: 'btcusdt_strategy_input',
        type: 'strategy_input',
        qualityStatus: 'ok',
        parents: ['btcusdt_1m_return_5'],
        availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
      },
      {
        id: 'btcusdt_decision_artifact',
        type: 'decision_artifact',
        qualityStatus: 'ok',
        parents: ['btcusdt_strategy_input'],
        availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
      },
    ],
  }
}
