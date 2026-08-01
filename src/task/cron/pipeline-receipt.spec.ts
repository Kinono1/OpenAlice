import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPipelineExecutionReceipt,
  pipelineExecutionReceiptV1Schema,
  type PipelineRunContextV1,
} from './pipeline-receipt.js'

describe('pipeline execution receipt', () => {
  it('binds registry policy, lock and hashed artifact lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-receipt-'))
    await mkdir(join(root, 'input'), { recursive: true })
    await writeFile(join(root, 'input/source.json'), '{"ok":true}\n')
    await writeFile(join(root, 'output.json'), '{"status":"pass"}\n')

    const receipt = await buildPipelineExecutionReceipt({
      context: makeContext(),
      jobId: 'job-1',
      jobName: 'registered_job',
      sourceFireSeq: 42,
      startedAt: new Date('2026-08-01T12:00:00.000Z'),
      endedAt: new Date('2026-08-01T12:00:01.000Z'),
      status: 'pass',
      repoRoot: root,
    })

    expect(pipelineExecutionReceiptV1Schema.parse(receipt)).toEqual(receipt)
    expect(receipt).toMatchObject({
      owner: 'runtime-operations',
      timeoutSeconds: 300,
      lock: { policy: 'required', key: 'pipeline:job-1' },
      artifactLineage: { status: 'complete' },
    })
    expect(receipt.artifactLineage.inputs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.artifactLineage.outputs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('marks missing or unsafe lineage partial without inventing hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-receipt-partial-'))
    const context = makeContext()
    context.inputs = ['../escape']
    context.outputs = ['missing.json']
    const receipt = await buildPipelineExecutionReceipt({
      context,
      jobId: 'job-1',
      jobName: 'registered_job',
      sourceFireSeq: 43,
      startedAt: new Date('2026-08-01T12:00:00.000Z'),
      endedAt: new Date('2026-08-01T12:00:01.000Z'),
      status: 'fail',
      repoRoot: root,
      reasonCodes: ['execution_failed'],
    })

    expect(receipt.artifactLineage.status).toBe('partial')
    expect(receipt.artifactLineage.inputs[0]).toMatchObject({ kind: 'unsafe', sha256: null })
    expect(receipt.artifactLineage.outputs[0]).toMatchObject({ kind: 'missing', sha256: null })
  })
})

function makeContext(): PipelineRunContextV1 {
  return {
    schemaVersion: 'pipeline_run_context.v1',
    registryHash: '1'.repeat(64),
    registryEntryId: 'pipeline.scripts_registered_job_ts',
    entrypoint: 'scripts/registered_job.ts',
    owner: 'runtime-operations',
    safetyLevel: 'artifact_write',
    networkPolicy: 'denied',
    timeoutSeconds: 300,
    lock: { policy: 'required', key: 'pipeline:job-1' },
    inputs: ['input'],
    outputs: ['output.json'],
  }
}
