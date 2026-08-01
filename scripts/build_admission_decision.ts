import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  reduceAdmissionDecision,
  writeAdmissionDecision,
  type AdmissionDecisionV1,
} from '../src/runtime/admission.js'
import { evidenceRefV1Schema } from '../src/runtime/evidence_store.js'

const SHA256_RE = /^[a-f0-9]{64}$/

const gateSchema = z.object({
  gateId: z.string().trim().min(1),
  requirement: z.enum([
    'engineering',
    'paper',
    'tiny_cap',
    'live',
    'live_approval',
    'arm',
    'scaled_live',
  ]),
  providerStatus: z.enum(['pass', 'fail', 'unknown', 'stale']),
  evidence: z.array(evidenceRefV1Schema),
  acceptedSchemaVersions: z.array(z.string().trim().min(1)),
  reasonCodes: z.array(z.string().trim().min(1)).optional(),
}).strict()

export const admissionEvidenceBundleV1Schema = z.object({
  schemaVersion: z.literal('admission_evidence_bundle.v1'),
  candidateId: z.string().trim().min(1).nullable(),
  releaseManifestHash: z.string().regex(SHA256_RE),
  gates: z.array(gateSchema),
  evidenceGraph: z.array(evidenceRefV1Schema).default([]),
  approvalRefs: z.array(z.string().trim().min(1)).default([]),
  accountScope: z.array(z.string().trim().min(1)).default([]),
  assetScope: z.array(z.string().trim().min(1)).default([]),
  ttlMs: z.number().int().positive().optional(),
}).strict()

export type AdmissionEvidenceBundleV1 = z.infer<typeof admissionEvidenceBundleV1Schema>

export interface SourceBinding {
  sourceCommit: string
  dirtyStateHash: string
}

export interface BuildAdmissionDecisionInput {
  bundle: AdmissionEvidenceBundleV1
  binding: SourceBinding
  now?: Date
}

export async function buildAdmissionDecisionFromBundle(
  input: BuildAdmissionDecisionInput,
): Promise<AdmissionDecisionV1> {
  const bundle = admissionEvidenceBundleV1Schema.parse(input.bundle)
  const decision = await reduceAdmissionDecision({
    candidateId: bundle.candidateId,
    sourceCommit: input.binding.sourceCommit,
    dirtyStateHash: input.binding.dirtyStateHash,
    releaseManifestHash: bundle.releaseManifestHash,
    gates: bundle.gates,
    evidenceGraph: bundle.evidenceGraph,
    approvalRefs: bundle.approvalRefs,
    accountScope: bundle.accountScope,
    assetScope: bundle.assetScope,
    ttlMs: bundle.ttlMs,
    requestLiveExecutionArm: false,
    now: input.now,
  })
  if (decision.liveExecutionArmed) {
    throw new Error('build_admission_decision must never arm live execution')
  }
  return decision
}

export function readGitSourceBinding(repoRoot: string): SourceBinding {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  }).trim()
  const status = execFileSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: repoRoot },
  )
  return {
    sourceCommit,
    dirtyStateHash: createHash('sha256').update(status).digest('hex'),
  }
}

interface CliArgs {
  bundlePath: string
  outputPath: string
  repoRoot: string
  now?: Date
}

export function parseBuildAdmissionArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('arguments must use --name value pairs')
    }
    if (!['--bundlePath', '--outputPath', '--repoRoot', '--now'].includes(key)) {
      throw new Error(`unknown argument: ${key}`)
    }
    values.set(key, value)
  }
  const nowValue = values.get('--now')
  const now = nowValue ? new Date(nowValue) : undefined
  if (now && !Number.isFinite(now.getTime())) throw new Error('invalid --now value')
  return {
    bundlePath: values.get('--bundlePath') ?? 'data/runtime/admission_evidence_bundle.v1.json',
    outputPath: values.get('--outputPath') ?? 'data/runtime/admission_decision.v1.json',
    repoRoot: resolve(values.get('--repoRoot') ?? process.cwd()),
    now,
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseBuildAdmissionArgs(argv)
  const bundle = admissionEvidenceBundleV1Schema.parse(
    JSON.parse(await readFile(resolve(args.repoRoot, args.bundlePath), 'utf-8')),
  )
  const decision = await buildAdmissionDecisionFromBundle({
    bundle,
    binding: readGitSourceBinding(args.repoRoot),
    now: args.now,
  })
  const outputPath = resolve(args.repoRoot, args.outputPath)
  writeAdmissionDecision(outputPath, decision)
  process.stdout.write(`${JSON.stringify({
    schemaVersion: decision.schemaVersion,
    decisionId: decision.decisionId,
    stage: decision.stage,
    paperTradingAllowed: decision.paperTradingAllowed,
    liveTradingAllowed: decision.liveTradingAllowed,
    liveExecutionArmed: decision.liveExecutionArmed,
    blockingReasons: decision.blockingReasons,
    outputPath,
  }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
