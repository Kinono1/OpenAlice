import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { sha256Canonical, stableStringify } from '../src/sidecar/contracts.js'
import {
  D1_RELEASE_CHECK_IDS, D1_RELEASE_REQUIRED_ARTIFACT_PATHS,
  D1_RELEASE_BUNDLE_METADATA_PATH, DEPENDENCY_LOCK_METADATA_PATH, EXECUTION_PROTO_PATH,
  PIPELINE_REGISTRY_METADATA_PATH, SIDECAR_ENVIRONMENT_RECEIPT_PATH,
  SIDECAR_RUNTIME_CONTRACT_PATH, SIDECAR_RUNTIME_LOCK_PATH,
  SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH, STRATEGY_CONFIG_METADATA_PATH,
  buildReleaseManifestV2, type ReleaseManifestV2, type ReleaseManifestV2Core,
} from '../src/runtime/release_manifest.js'
import {
  FUTURE_ATTESTATION_TYPES,
  buildPaperLocalDeploymentPlan,
  validatePaperLocalDeploymentPlan,
  verifyPaperLocalDeploymentInputs,
  writePaperLocalDeploymentPlan,
  type PaperLocalDeploymentInputs,
  type VerifiedPlanObservations,
} from './plan_paper_local_deployment.js'

const COMMIT = '1'.repeat(40)
const HASH = (char: string) => char.repeat(64)

describe('D1 PAPER_LOCAL plan-only deployment', () => {
  it('builds a fixed non-executable plan and keeps planId independent of createdAt', () => {
    const manifest = fixtureManifest()
    const first = buildPaperLocalDeploymentPlan(manifest, fixtureInput(), fixtureObserved())
    const second = buildPaperLocalDeploymentPlan(manifest, { ...fixtureInput(), createdAt: '2026-08-15T01:15:00.000Z' }, fixtureObserved())
    expect(first.status).toBe('plan_only')
    expect(first.planId).toBe(second.planId)
    expect(first.capabilities).toEqual({ install: false, start: false, launchctl: false, pointerMutation: false, broker: false, network: false, liveExecution: false, mutation: false, deploymentAuthorized: false, deploymentPerformed: false })
    expect(first.attestations).toEqual(FUTURE_ATTESTATION_TYPES)
    expect(Object.keys(first.launchd.environmentVariables).sort()).toEqual([
      'OPENALICE_NAUTILUS_PYTHON', 'OPENALICE_NODE', 'OPENALICE_NODE_SHA256',
      'OPENALICE_PAPER_LOCAL_MJS_SHA256', 'OPENALICE_PAPER_LOCAL_SUPERVISOR_CONFIG',
      'OPENALICE_RELEASE_DIR', 'OPENALICE_RELEASE_PUBLISHER_UID',
    ])
    expect(first.launchd.programArguments).toEqual(['/bin/sh', `${fixtureInput().materializedDirectory}/launch_nautilus_paper.sh`, '--release-root', '/releases', '--release-id', COMMIT, '--config', '/run/supervisor.json'])
  })

  it('rejects V1, unfrozen/live, unknown bad release state, expired evidence, invalid identities and hash/config mutations', () => {
    const input = fixtureInput(); const observed = fixtureObserved(); const manifest = fixtureManifest()
    expect(() => buildPaperLocalDeploymentPlan({ ...manifest, schemaVersion: 'release_manifest.v1' } as unknown as ReleaseManifestV2, input, observed)).toThrow('requires_release_manifest_v2')
    expect(() => buildPaperLocalDeploymentPlan({ ...manifest, admissionDecisionId: HASH('f') } as unknown as ReleaseManifestV2, input, observed)).toThrow()
    expect(() => buildPaperLocalDeploymentPlan({ ...manifest, liveExecutionArmed: true } as unknown as ReleaseManifestV2, input, observed)).toThrow()
    expect(() => buildPaperLocalDeploymentPlan(manifest, { ...input, serviceUid: input.publisherUid }, observed)).toThrow('two_identity_uid_invalid')
    expect(() => buildPaperLocalDeploymentPlan(manifest, { ...input, expiresAt: '2026-08-15T03:00:01.000Z' }, observed)).toThrow('expiry_invalid')
    expect(() => buildPaperLocalDeploymentPlan({ ...manifest, artifactHashes: { ...manifest.artifactHashes, 'sidecars/nautilus_paper/supervisor_config.v1.schema.json': undefined } } as unknown as ReleaseManifestV2, input, observed)).toThrow()
  })

  it('performs only read-only runtime and canonical supervisor config verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paper-local-plan-'))
    const releaseRoot = join(root, 'releases'); const release = join(releaseRoot, COMMIT)
    const node = join(root, 'node'); const python = join(root, 'python'); const config = join(root, 'supervisor.json')
    await mkdir(join(release, 'ops/release'), { recursive: true })
    await mkdir(join(release, 'sidecars/nautilus_paper'), { recursive: true })
    await writeFile(join(release, 'ops/release/launch_nautilus_paper.sh'), 'shell')
    await writeFile(join(release, 'ops/release/launch_nautilus_paper.mjs'), 'mjs')
    await writeFile(node, 'node'); await chmod(node, 0o700); await writeFile(python, 'python'); await chmod(python, 0o700)
    const manifest = fixtureManifest({ releaseId: COMMIT })
    const shellHash = await hashFile(join(release, 'ops/release/launch_nautilus_paper.sh'))
    const mjsHash = await hashFile(join(release, 'ops/release/launch_nautilus_paper.mjs'))
    const nodeHash = await hashFile(node); const pythonHash = await hashFile(python)
    const contractValue = { runtimeProvenance: { interpreterSha256: pythonHash, pyvenvCfgSha256: manifest.sidecarEnvironment.receipt.pyvenvCfgHash, baseRuntimeAggregate: manifest.sidecarEnvironment.receipt.baseRuntimeAggregate, sitePackagesAggregate: manifest.sidecarEnvironment.receipt.sitePackagesAggregate, installedAggregate: manifest.sidecarEnvironment.receipt.installedAggregate, status: 'frozen' } }
    const contractPath = join(release, 'sidecars/nautilus_paper/release_runtime_contract.v1.json')
    await writeFile(contractPath, `${stableStringify(contractValue)}\n`)
    const contractHash = await hashFile(contractPath)
    const supervisorSchemaPath = join(release, 'sidecars/nautilus_paper/supervisor_config.v1.schema.json')
    await writeFile(supervisorSchemaPath, await readFile(new URL('../sidecars/nautilus_paper/supervisor_config.v1.schema.json', import.meta.url)))
    const supervisorSchemaHash = await hashFile(supervisorSchemaPath)
    const bound = fixtureManifest({ artifactHashes: { ...manifest.artifactHashes, 'ops/release/launch_nautilus_paper.sh': shellHash, 'ops/release/launch_nautilus_paper.mjs': mjsHash, 'sidecars/nautilus_paper/release_runtime_contract.v1.json': contractHash, 'sidecars/nautilus_paper/supervisor_config.v1.schema.json': supervisorSchemaHash }, sidecarEnvironment: { ...manifest.sidecarEnvironment, receipt: { ...manifest.sidecarEnvironment.receipt, contractHash, interpreterHash: pythonHash } } })
    const schemaHash = bound.artifactHashes['sidecars/nautilus_paper/supervisor_config.v1.schema.json']!
    const configValue = { schemaVersion: 'openalice_paper_supervisor_config.v1', mode: 'PAPER_LOCAL', runRoot: '/run/paper', ledgerPath: '/run/paper/ledger.jsonl', simulatorDatabasePath: '/run/paper/simulator.sqlite', statusPath: '/run/paper/status.json', policyPath: '/run/paper/policy.json', permitPublicKeyPath: '/run/paper/permit.pub', capabilityAuthorityPrivateKeyPath: '/run/paper/capability.key', receiptSigningPrivateKeyPath: '/run/paper/receipt.key', sourceAttestationPrivateKeyPath: '/run/paper/source.key', runId: 'plan-test', schemaHash, releaseManifestHash: bound.manifestHash, proofValiditySeconds: 60, leaseName: 'plan-test', ttlSeconds: 60, queueSize: 1, startupTimeoutSeconds: 10, shutdownTimeoutSeconds: 10 }
    await writeFile(config, stableStringify(configValue))
    const input = fixtureInput({ releaseRoot, materializedDirectory: release, nodePath: node, nodeSha256: nodeHash, pythonPath: python, supervisorConfigPath: config })
    await expect(verifyPaperLocalDeploymentInputs(bound, input)).resolves.toMatchObject({ nodeSha256: nodeHash, pythonInterpreterHash: pythonHash })
    await writeFile(config, `${stableStringify({ ...configValue, mode: 'OTHER' })}\n`)
    await expect(verifyPaperLocalDeploymentInputs(bound, input)).rejects.toThrow('supervisor_config_schema_invalid')
    await writeFile(config, stableStringify({ ...configValue, schemaHash: HASH('0') }))
    await expect(verifyPaperLocalDeploymentInputs(bound, input)).rejects.toThrow('supervisor_config_binding_mismatch')
    await symlink(node, `${node}-link`)
    await expect(verifyPaperLocalDeploymentInputs(bound, { ...input, nodePath: `${node}-link` })).rejects.toThrow('node_unsafe')
  })

  it('seals an exclusive 0700 reservation, refuses unsafe output and never clobbers an existing plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paper-local-plan-output-'))
    const output = join(await realpath(root), 'plans'); await mkdir(output, { mode: 0o700 }); await chmod(output, 0o700)
    const input = fixtureInput({ outputRoot: output, publisherUid: process.getuid?.() ?? 0 })
    const plan = buildPaperLocalDeploymentPlan(fixtureManifest(), input, fixtureObserved())
    const freshAt = new Date('2026-08-15T01:10:00.000Z')
    const target = await writePaperLocalDeploymentPlan(plan, output, freshAt)
    expect(await readFile(join(target, 'SEALED'), 'utf8')).toBe(`${plan.planId}\n`)
    expect(await readdir(target)).toEqual(['SEALED', 'plan.json'])
    expect(await readFile(join(target, 'plan.json'), 'utf8')).toBe(`${stableStringify(plan)}\n`)
    await expect(writePaperLocalDeploymentPlan(plan, output, freshAt)).rejects.toThrow('already_exists')
    const stalePlan = buildPaperLocalDeploymentPlan(fixtureManifest(), { ...input, expiresAt: '2026-08-15T01:59:00.000Z' }, fixtureObserved())
    const stale = join(output, `${stalePlan.planId}.plan`); await mkdir(stale, { mode: 0o700 }); await writeFile(join(stale, 'plan.json'), 'partial')
    await expect(writePaperLocalDeploymentPlan(stalePlan, output, freshAt)).rejects.toThrow('already_exists')
    expect(await readFile(join(stale, 'plan.json'), 'utf8')).toBe('partial')
    expect(() => validatePaperLocalDeploymentPlan(plan, { freshAt })).not.toThrow()
    expect(() => validatePaperLocalDeploymentPlan(plan, { freshAt: new Date('2026-08-15T00:59:59.999Z') })).toThrow('not_fresh')
    expect(() => validatePaperLocalDeploymentPlan(plan, { freshAt: new Date('2026-08-15T02:00:00.000Z') })).toThrow('not_fresh')
    expect(() => validatePaperLocalDeploymentPlan(plan, { freshAt: new Date(Number.NaN) })).toThrow('not_fresh')
    await chmod(output, 0o755)
    await expect(writePaperLocalDeploymentPlan(plan, output, freshAt)).rejects.toThrow('output_root_unsafe')
  })

  it('contains no installer, broker, network, or child-process import path', async () => {
    const source = await readFile(new URL('./plan_paper_local_deployment.ts', import.meta.url), 'utf8')
    for (const forbidden of ['child_process', 'install_openalice', 'fetch(', 'Broker']) expect(source).not.toContain(forbidden)
  })

  it('rejects unknown plan/env fields, non-plan status, enabled capability, and derived-id/payload tampering', () => {
    const plan = buildPaperLocalDeploymentPlan(fixtureManifest(), fixtureInput(), fixtureObserved())
    for (const invalid of [
      { ...plan, unexpected: true },
      { ...plan, status: 'pass' },
      { ...plan, capabilities: { ...plan.capabilities, broker: true } },
      { ...plan, attestations: plan.attestations.filter(value => value !== 'paper_local_service_execution_control_attestation.v1') },
      { ...plan, launchd: { ...plan.launchd, environmentVariables: { ...plan.launchd.environmentVariables, EXTRA: 'x' } } },
      { ...plan, launchd: { ...plan.launchd, payloadSha256: HASH('0') } },
      { ...plan, planId: HASH('0') },
    ]) expect(() => validatePaperLocalDeploymentPlan(invalid)).toThrow()
  })

  it('changes planId for manifest/path/identity/config/expiry semantics but not createdAt', () => {
    const baseInput = fixtureInput(); const observed = fixtureObserved(); const base = buildPaperLocalDeploymentPlan(fixtureManifest(), baseInput, observed)
    const variants = [
      buildPaperLocalDeploymentPlan(fixtureManifest({ builtAt: '2026-08-15T00:31:00.000Z' }), baseInput, observed),
      buildPaperLocalDeploymentPlan(fixtureManifest(), { ...baseInput, materializedDirectory: '/stable-launcher-pair-2' }, observed),
      buildPaperLocalDeploymentPlan(fixtureManifest(), { ...baseInput, serviceUid: 503 }, observed),
      buildPaperLocalDeploymentPlan(fixtureManifest(), { ...baseInput, supervisorConfigPath: '/run/supervisor-2.json' }, observed),
      buildPaperLocalDeploymentPlan(fixtureManifest(), { ...baseInput, expiresAt: '2026-08-15T01:59:00.000Z' }, observed),
    ]
    for (const variant of variants) expect(variant.planId).not.toBe(base.planId)
    expect(buildPaperLocalDeploymentPlan(fixtureManifest(), { ...baseInput, createdAt: '2026-08-15T01:01:00.000Z' }, observed).planId).toBe(base.planId)
  })

  it('declares serviceDomain and closed schema fields; rejects an output-root symlink', async () => {
    const schema = JSON.parse(await readFile(new URL('./paper_local_deployment_plan.v1.schema.json', import.meta.url), 'utf8'))
    expect(schema.properties.launchd.required).toContain('serviceDomain')
    expect(schema.properties.launchd.properties.environmentVariables.additionalProperties).toBe(false)
    expect(schema.properties.attestations.prefixItems).toHaveLength(8)
    expect(schema.properties.attestations.prefixItems[6]).toEqual({ const: 'paper_local_service_execution_control_attestation.v1' })
    expect(schema.properties.capabilities.required).toEqual(expect.arrayContaining(['deploymentAuthorized', 'deploymentPerformed']))
    const validateSchema = new Ajv2020({ strict: true, validateFormats: false }).compile(schema)
    const schemaPlan = buildPaperLocalDeploymentPlan(fixtureManifest(), fixtureInput(), fixtureObserved())
    expect(validateSchema(schemaPlan), JSON.stringify(validateSchema.errors)).toBe(true)
    expect(validateSchema({
      ...schemaPlan,
      launchd: {
        ...schemaPlan.launchd,
        environmentVariables: { ...schemaPlan.launchd.environmentVariables, BROKER_SECRET: 'forbidden' },
      },
    })).toBe(false)
    const root = await mkdtemp(join(tmpdir(), 'paper-local-plan-alias-')); const target = join(await realpath(root), 'output')
    await mkdir(target, { mode: 0o700 }); const alias = join(await realpath(root), 'alias'); await symlink(target, alias)
    const plan = buildPaperLocalDeploymentPlan(fixtureManifest(), fixtureInput({ outputRoot: alias, publisherUid: process.getuid?.() ?? 0 }), fixtureObserved())
    await expect(writePaperLocalDeploymentPlan(plan, alias, new Date('2026-08-15T01:10:00.000Z'))).rejects.toThrow('output_root_unsafe')
  })
})

function fixtureInput(overrides: Partial<PaperLocalDeploymentInputs> = {}): PaperLocalDeploymentInputs {
  return { releaseRoot: '/releases', releaseId: COMMIT, materializedDirectory: '/stable-launcher-pair', nodePath: '/runtime/node', nodeSha256: HASH('a'), pythonPath: '/runtime/python', publisherUid: 501, serviceUid: 502, supervisorConfigPath: '/run/supervisor.json', label: 'ai.openalice.paper-local', plistPath: '/Library/LaunchAgents/ai.openalice.paper-local.plist', logPath: '/var/log/openalice.log', errorLogPath: '/var/log/openalice.err.log', outputRoot: '/plans', createdAt: '2026-08-15T01:00:00.000Z', expiresAt: '2026-08-15T02:00:00.000Z', ...overrides }
}
function fixtureObserved(): VerifiedPlanObservations { return { nodeSha256: HASH('a'), pythonInterpreterHash: HASH('d'), pythonResolvedPath: '/runtime/python-real', supervisorCanonicalSha256: HASH('e') } }
function fixtureManifest(overrides: Partial<ReleaseManifestV2> = {}): ReleaseManifestV2 {
  const core = validV2Core()
  return buildReleaseManifestV2({ ...core, ...overrides, artifactHashes: overrides.artifactHashes ?? core.artifactHashes, sidecarEnvironment: overrides.sidecarEnvironment ?? core.sidecarEnvironment })
}
function validV2Core(): ReleaseManifestV2Core {
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const validationReceipts = D1_RELEASE_CHECK_IDS.map((checkId, index) => ({ checkId, path: `release-metadata/validation-receipts/${checkId}.validation_receipt.v1.json`, receiptHash: HASH(String(index + 1)), sourceCommit: COMMIT, dirtyStateHash: empty, executedAt: '2026-08-15T00:00:00.000Z', expiresAt: '2026-08-15T02:00:00.000Z', status: 'pass' as const }))
  const contractHash = HASH('a'); const lockHash = HASH('b'); const wheelHash = HASH('c'); const protoHash = HASH('d')
  return { releaseId: COMMIT, sourceCommit: COMMIT, dirtyStateHash: empty, builtAt: '2026-08-15T00:30:00.000Z', runtimeEntry: 'ops/release/launch_nautilus_paper.sh', artifactHashes: { ...Object.fromEntries(D1_RELEASE_REQUIRED_ARTIFACT_PATHS.map(path => [path, HASH('f')])), 'package.json': HASH('4'), [D1_RELEASE_BUNDLE_METADATA_PATH]: HASH('4'), [SIDECAR_ENVIRONMENT_RECEIPT_PATH]: HASH('e'), [SIDECAR_RUNTIME_CONTRACT_PATH]: contractHash, [SIDECAR_RUNTIME_LOCK_PATH]: lockHash, [SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH]: wheelHash, [EXECUTION_PROTO_PATH]: protoHash, 'dist/proto/openalice_execution_v1.proto': protoHash, [PIPELINE_REGISTRY_METADATA_PATH]: HASH('5'), [DEPENDENCY_LOCK_METADATA_PATH]: HASH('6'), [STRATEGY_CONFIG_METADATA_PATH]: HASH('7'), ...Object.fromEntries(validationReceipts.map(receipt => [receipt.path, receipt.receiptHash])) }, pipelineRegistryHash: HASH('5'), dependencyLockHash: HASH('6'), strategyConfigHash: HASH('7'), validationReceipts, sidecarEnvironment: { receiptPath: SIDECAR_ENVIRONMENT_RECEIPT_PATH, receiptHash: HASH('e'), contractPath: SIDECAR_RUNTIME_CONTRACT_PATH, receipt: { schemaVersion: 'openalice_sidecar_environment_receipt.v1', contractHash, interpreterHash: HASH('d'), pyvenvCfgHash: HASH('9'), baseRuntimeAggregate: HASH('a'), sitePackagesAggregate: HASH('b'), installedAggregate: HASH('0'), lockHash, wheelManifestHash: wheelHash, protoHash, generatedAggregate: HASH('f'), target: { implementation: 'CPython', python: '3.13.5', cacheTag: 'cpython-313', system: 'Darwin', macosMajor: 26, machine: 'arm64' }, flags: { paperOnly: true, liveTradingAllowed: false, liveExecutionArmed: false }, executedAt: '2026-08-15T00:00:00.000Z', status: 'pass' } }, admissionDecisionId: null, engineeringChecks: [...D1_RELEASE_CHECK_IDS], liveExecutionArmed: false }
}
async function hashFile(path: string): Promise<string> { return (await import('node:crypto')).createHash('sha256').update(await readFile(path)).digest('hex') }
