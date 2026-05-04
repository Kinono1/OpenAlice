import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeExperiment, type ExperimentRecord } from './experiment-ledger.js'

describe('experiment-ledger', () => {
  let root: string | null = null

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
      root = null
    }
  })

  it('appends experiment records to dated JSONL files', () => {
    root = mkdtempSync(join(tmpdir(), 'openalice-experiment-ledger-'))
    const record: ExperimentRecord = {
      experiment_id: 'exp-1',
      strategy: 'volume_breakout',
      git_commit: 'abc123',
      data_range: {
        train: ['2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z'],
        test: ['2026-05-02T00:00:00.000Z', '2026-05-03T00:00:00.000Z'],
      },
      config_hash: 'sha256:test',
      metrics: {
        oos_sharpe: 0.4,
        cost_adjusted_score: null,
      },
      gates: {
        promotion: 'FAIL',
        reason: ['FDR_FAILED'],
      },
      module_modes: {
        meta_labeling: 'shadow',
      },
    }

    writeExperiment(record, root)

    const file = join(root, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    const rows = readFileSync(file, 'utf-8').trim().split('\n')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0])).toMatchObject(record)
  })
})
