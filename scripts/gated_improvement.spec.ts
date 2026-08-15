import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs, runGatedImprovement, signApprovalPayload } from './gated_improvement.ts'

describe('gated_improvement', () => {
  it('candidate leaves source and production config unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-evolution-'))
    const repoRoot = join(root, 'repo')
    const dataRoot = join(repoRoot, 'data')
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await mkdir(join(dataRoot, 'research'), { recursive: true })
    const sourcePath = join(repoRoot, 'src', 'strategy.ts')
    const configPath = join(dataRoot, 'research', 'best_config.json')
    await writeFile(sourcePath, 'export const strategy = "champion"\n')
    await writeFile(configPath, '{"version":1}\n')
    const beforeSource = await readFile(sourcePath, 'utf-8')
    const beforeConfig = await readFile(configPath, 'utf-8')
    const result = await runGatedImprovement(parseArgs([
      '--mode', 'candidate', '--repoRoot', repoRoot, '--dataRoot', dataRoot,
      '--candidateId', 'candidate_test_safe', '--force', 'true',
    ]))
    expect(result).toMatchObject({ status: 'candidate_generated', candidateId: 'candidate_test_safe' })
    expect(await readFile(sourcePath, 'utf-8')).toBe(beforeSource)
    expect(await readFile(configPath, 'utf-8')).toBe(beforeConfig)
    const bundle = JSON.parse(await readFile(join(dataRoot, 'research', 'evolution', 'candidates', 'candidate_test_safe', 'candidate.json'), 'utf-8'))
    expect(bundle.safety).toMatchObject({ sourceMutationAllowed: false, productionConfigMutationAllowed: false, orderCreationAllowed: false })
    expect(bundle.validation.missingMethods).toHaveLength(3)
  })

  it('suppresses candidate generation without a material delta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-evolution-'))
    const dataRoot = join(root, 'data')
    const args = parseArgs(['--mode', 'candidate', '--repoRoot', root, '--dataRoot', dataRoot])
    expect((await runGatedImprovement(args)).status).toBe('candidate_generated')
    expect((await runGatedImprovement(args)).status).toBe('suppressed_no_material_delta')
  })

  it('promote rejects missing human approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-evolution-'))
    const dataRoot = join(root, 'data')
    await runGatedImprovement(parseArgs([
      '--mode', 'candidate', '--repoRoot', root, '--dataRoot', dataRoot,
      '--candidateId', 'candidate_reject_me', '--force', 'true',
    ]))
    const result = await runGatedImprovement(parseArgs([
      '--mode', 'promote', '--repoRoot', root, '--dataRoot', dataRoot, '--candidateId', 'candidate_reject_me',
    ]))
    expect(result.status).toBe('rejected_gate_failure')
    expect(result.blockers).toContain('human_approval_missing')
  })

  it('promotes only to paper-shadow with signed approval and passing gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-evolution-'))
    const dataRoot = join(root, 'data')
    const candidateId = 'candidate_paper_only'
    const runtime = join(dataRoot, 'runtime')
    await mkdir(runtime, { recursive: true })
    await mkdir(join(dataRoot, 'config'), { recursive: true })
    const artifacts: Record<string, unknown> = {
      'scheduler_security_audit.latest.json': { status: 'pass' },
      'external_derivatives_data_audit.latest.json': { status: 'complete' },
      'pit_audit_global_gate_status.latest.json': { status: 'pass' },
      'okx_route_cost_slippage_readiness.latest.json': { status: 'pass' },
      'wfo_stability_gate_status.latest.json': { status: 'pass' },
      'release_gate_status.json': { status: 'pass', allowPaperTrading: true },
      'strategy_promotion.latest.json': { finalVerdict: 'paper_allowed' },
      'dirty_worktree_audit.latest.json': { status: 'dirty', dirtyHash: 'traceable' },
    }
    for (const [name, value] of Object.entries(artifacts)) await writeFile(join(runtime, name), JSON.stringify(value))
    await writeFile(join(dataRoot, 'config', 'accounts.json'), '[]\n')
    await writeFile(join(dataRoot, 'config', 'agent.json'), '{"evolutionMode":false}\n')
    await runGatedImprovement(parseArgs([
      '--mode', 'candidate', '--repoRoot', root, '--dataRoot', dataRoot,
      '--candidateId', candidateId, '--force', 'true',
    ]))
    const candidatePath = join(dataRoot, 'research', 'evolution', 'candidates', candidateId, 'candidate.json')
    const candidate = JSON.parse(await readFile(candidatePath, 'utf-8'))
    candidate.recommendation = 'paper-candidate'
    candidate.validation.status = 'pass'
    await writeFile(candidatePath, JSON.stringify(candidate))
    const secret = 'local-test-secret-with-sufficient-entropy'
    const approvalBase = {
      schemaVersion: 1 as const,
      candidateId,
      action: 'promote-to-paper-shadow' as const,
      approvedBy: 'test-human',
      approvedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const approvalPath = join(root, 'approval.json')
    await writeFile(approvalPath, JSON.stringify({ ...approvalBase, signature: signApprovalPayload(approvalBase, secret) }))
    process.env.TEST_CANDIDATE_APPROVAL_SECRET = secret
    const result = await runGatedImprovement(parseArgs([
      '--mode', 'promote', '--repoRoot', root, '--dataRoot', dataRoot, '--candidateId', candidateId,
      '--approvalPath', approvalPath, '--approvalSecretEnv', 'TEST_CANDIDATE_APPROVAL_SECRET',
    ]))
    expect(result.status).toBe('promoted_to_paper_shadow')
    const promoted = JSON.parse(await readFile(join(dataRoot, 'paper_shadow', 'promoted_candidates', candidateId, 'paper_config.json'), 'utf-8'))
    expect(promoted).toMatchObject({ target: 'paper-shadow-only', liveTradingAllowed: false, executionAllowed: false })
  })
})
