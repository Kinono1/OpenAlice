import { z } from 'zod'
import { sha256Canonical } from '../sidecar/contracts.js'

export const RELEASE_MANIFEST_V1 = 'release_manifest.v1' as const
export const RELEASE_MANIFEST_V2 = 'release_manifest.v2' as const

export const D1_RELEASE_CHECK_IDS = [
  'd1.typescript',
  'd1.sidecar.environment',
  'd1.sidecar.proto',
  'd1.sidecar.python',
  'd1.sidecar.node',
  'd1.sidecar.node_python_uds',
  'd1.release_manifest_launcher',
] as const

export const SIDECAR_ENVIRONMENT_RECEIPT_PATH =
  'release-metadata/sidecar_environment_receipt.v1.json' as const
export const D1_RELEASE_BUNDLE_METADATA_PATH =
  'release-metadata/d1_release_bundle.v1.json' as const
export const SIDECAR_RUNTIME_CONTRACT_PATH =
  'sidecars/nautilus_paper/release_runtime_contract.v1.json' as const
export const SIDECAR_RUNTIME_LOCK_PATH =
  'sidecars/nautilus_paper/requirements-paper-local-runtime-macos-arm64-cp313.lock' as const
export const SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH =
  'sidecars/nautilus_paper/wheelhouse-paper-local-runtime-macos-arm64-cp313.sha256' as const
export const EXECUTION_PROTO_PATH =
  'src/sidecar/proto/openalice_execution_v1.proto' as const
export const PIPELINE_REGISTRY_METADATA_PATH =
  'release-metadata/pipeline_registry.v1.json' as const
export const DEPENDENCY_LOCK_METADATA_PATH =
  'release-metadata/pnpm-lock.yaml' as const
export const STRATEGY_CONFIG_METADATA_PATH =
  'release-metadata/strategy_release_config.v1.json' as const

/**
 * The exact materialized artifact set for the standalone D1 PAPER_LOCAL
 * sidecar.  The selected TypeScript bridge sources, package metadata, and lock
 * are hash-bound interoperability evidence checked in the clean source tree;
 * they do not make this deliberately minimal release a self-contained or
 * rebuildable OpenAlice Node application.
 */
export const D1_RELEASE_REQUIRED_ARTIFACT_PATHS = [
  'dist/proto/openalice_execution_v1.proto',
  'src/sidecar/proto/openalice_execution_v1.proto',
  'scripts/check_execution_sidecar_proto.ts',
  'src/bootstrap/execution-sidecar.ts',
  'src/domain/trading/execution-lifecycle-read-model.ts',
  'src/domain/trading/execution-offline-receipt-read-model.ts',
  'src/domain/trading/execution-protocol.ts',
  'src/domain/trading/execution-sidecar-read-model.ts',
  'src/domain/trading/execution-sidecar-writer.ts',
  'src/domain/trading/execution-terminal-reducer.ts',
  'src/domain/trading/offline-execution-receipt.ts',
  'src/sidecar/contracts.ts',
  'src/sidecar/execution-grpc-transport.ts',
  'ops/release/launch_nautilus_paper.mjs',
  'ops/release/launch_nautilus_paper.sh',
  'sidecars/nautilus_paper/README.md',
  'sidecars/nautilus_paper/__init__.py',
  'sidecars/nautilus_paper/contract.py',
  'sidecars/nautilus_paper/core.py',
  'sidecars/nautilus_paper/environment.py',
  'sidecars/nautilus_paper/generated/__init__.py',
  'sidecars/nautilus_paper/generated/openalice_execution_v1_pb2.py',
  'sidecars/nautilus_paper/generated/openalice_execution_v1_pb2_grpc.py',
  'sidecars/nautilus_paper/grpc_receiver.py',
  'sidecars/nautilus_paper/ledger.py',
  'sidecars/nautilus_paper/offline_effect.py',
  'sidecars/nautilus_paper/offline_execution.py',
  'sidecars/nautilus_paper/offline_receipt.py',
  'sidecars/nautilus_paper/offline_simulator.py',
  'sidecars/nautilus_paper/runtime.py',
  'sidecars/nautilus_paper/supervisor.py',
  'sidecars/nautilus_paper/supervisor_config.v1.schema.json',
  'sidecars/nautilus_paper/verify_release_environment.py',
  SIDECAR_RUNTIME_CONTRACT_PATH,
  SIDECAR_RUNTIME_LOCK_PATH,
  SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH,
  'package.json',
  'pnpm-lock.yaml',
  D1_RELEASE_BUNDLE_METADATA_PATH,
  SIDECAR_ENVIRONMENT_RECEIPT_PATH,
  PIPELINE_REGISTRY_METADATA_PATH,
  DEPENDENCY_LOCK_METADATA_PATH,
  STRATEGY_CONFIG_METADATA_PATH,
] as const

/**
 * D1 is a deliberately small PAPER_LOCAL release, not a general OpenAlice
 * deploy image.  These are names which are unsafe even when a publisher has
 * declared and hash-bound them: test harnesses can provision fixture state,
 * broad dependency inventories describe a different runtime, and generated
 * caches make the release content host-dependent.
 *
 * Keep this a path rule rather than a basename rule.  In particular,
 * `verify_release_environment.py` is the production verifier and must not be
 * confused with a dependency-verification helper.
 */
const D1_FORBIDDEN_CACHE_SEGMENTS = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.cache',
])
const D1_FORBIDDEN_TEST_SEGMENTS = new Set([
  'test', 'tests', '__tests__', 'integration', 'integrations',
])
const D1_FORBIDDEN_EXACT_FILENAMES = new Set([
  'runtime_crash_test_server.py',
  'uds_contract_test_server.py',
  'uds_offline_contract_test_server.py',
  'generate_proto.py',
  'dependency_lock.v1.json',
  'dependency_verification.v1.json',
  'requirements-macos-arm64-cp313.lock',
  'wheelhouse-macos-arm64-cp313.sha256',
])
const D1_RUNTIME_LOCK_PATH =
  'sidecars/nautilus_paper/requirements-paper-local-runtime-macos-arm64-cp313.lock'
const D1_RUNTIME_WHEEL_MANIFEST_PATH =
  'sidecars/nautilus_paper/wheelhouse-paper-local-runtime-macos-arm64-cp313.sha256'
const D1_GENERATED_PROTO_PATH = 'dist/proto/openalice_execution_v1.proto'

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/

const validationReceiptBindingSchema = z.object({
  checkId: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(1000),
  receiptHash: z.string().regex(SHA256_RE),
  sourceCommit: z.string().regex(COMMIT_RE),
  dirtyStateHash: z.string().regex(SHA256_RE),
  executedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  status: z.literal('pass'),
}).strict()

const sidecarEnvironmentTargetSchema = z.object({
  implementation: z.literal('CPython'),
  python: z.literal('3.13.5'),
  cacheTag: z.literal('cpython-313'),
  system: z.literal('Darwin'),
  macosMajor: z.literal(26),
  machine: z.literal('arm64'),
}).strict()

const paperOnlyFlagsSchema = z.object({
  paperOnly: z.literal(true),
  liveTradingAllowed: z.literal(false),
  liveExecutionArmed: z.literal(false),
}).strict()

export const sidecarEnvironmentReceiptV1Schema = z.object({
  schemaVersion: z.literal('openalice_sidecar_environment_receipt.v1'),
  contractHash: z.string().regex(SHA256_RE),
  interpreterHash: z.string().regex(SHA256_RE),
  pyvenvCfgHash: z.string().regex(SHA256_RE),
  baseRuntimeAggregate: z.string().regex(SHA256_RE),
  sitePackagesAggregate: z.string().regex(SHA256_RE),
  installedAggregate: z.string().regex(SHA256_RE),
  lockHash: z.string().regex(SHA256_RE),
  wheelManifestHash: z.string().regex(SHA256_RE),
  protoHash: z.string().regex(SHA256_RE),
  generatedAggregate: z.string().regex(SHA256_RE),
  target: sidecarEnvironmentTargetSchema,
  flags: paperOnlyFlagsSchema,
  executedAt: z.string().datetime(),
  status: z.literal('pass'),
}).strict()

export const sidecarEnvironmentBindingV1Schema = z.object({
  receiptPath: z.literal(SIDECAR_ENVIRONMENT_RECEIPT_PATH),
  receiptHash: z.string().regex(SHA256_RE),
  contractPath: z.literal(SIDECAR_RUNTIME_CONTRACT_PATH),
  receipt: sidecarEnvironmentReceiptV1Schema,
}).strict()

export const releaseManifestV1Schema = z.object({
  schemaVersion: z.literal(RELEASE_MANIFEST_V1),
  manifestHash: z.string().regex(SHA256_RE),
  releaseId: z.string().regex(COMMIT_RE),
  sourceCommit: z.string().regex(COMMIT_RE),
  dirtyStateHash: z.string().regex(SHA256_RE),
  builtAt: z.string().datetime(),
  runtimeEntry: z.string().trim().min(1).max(500),
  artifactHashes: z.record(z.string().trim().min(1), z.string().regex(SHA256_RE)),
  pipelineRegistryHash: z.string().regex(SHA256_RE),
  dependencyLockHash: z.string().regex(SHA256_RE),
  strategyConfigHash: z.string().regex(SHA256_RE),
  validationReceipts: z.array(validationReceiptBindingSchema).min(1),
  admissionDecisionId: z.string().regex(SHA256_RE).nullable(),
  engineeringChecks: z.array(z.string().trim().min(1).max(200)).min(1),
  liveExecutionArmed: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (value.releaseId !== value.sourceCommit) {
    ctx.addIssue({
      code: 'custom',
      path: ['releaseId'],
      message: 'releaseId must equal sourceCommit',
    })
  }
  if (!isSafeRelativePath(value.runtimeEntry)) {
    ctx.addIssue({
      code: 'custom',
      path: ['runtimeEntry'],
      message: 'runtimeEntry must be a safe relative path',
    })
  }
  if (!(value.runtimeEntry in value.artifactHashes)) {
    ctx.addIssue({
      code: 'custom',
      path: ['artifactHashes'],
      message: 'runtimeEntry must be covered by artifactHashes',
    })
  }
  for (const path of Object.keys(value.artifactHashes)) {
    if (!isSafeRelativePath(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifactHashes', path],
        message: 'artifact path must be safe and relative',
      })
    }
  }
  for (const receipt of value.validationReceipts) {
    if (receipt.sourceCommit !== value.sourceCommit) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} sourceCommit mismatch`,
      })
    }
    if (receipt.dirtyStateHash !== value.dirtyStateHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} dirtyStateHash mismatch`,
      })
    }
    if (Date.parse(receipt.expiresAt) <= Date.parse(value.builtAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} is stale at build time`,
      })
    }
  }
})

export const releaseManifestV2Schema = z.object({
  schemaVersion: z.literal(RELEASE_MANIFEST_V2),
  manifestHash: z.string().regex(SHA256_RE),
  releaseId: z.string().regex(COMMIT_RE),
  sourceCommit: z.string().regex(COMMIT_RE),
  dirtyStateHash: z.string().regex(SHA256_RE),
  builtAt: z.string().datetime(),
  runtimeEntry: z.string().trim().min(1).max(500),
  artifactHashes: z.record(z.string().trim().min(1), z.string().regex(SHA256_RE)),
  pipelineRegistryHash: z.string().regex(SHA256_RE),
  dependencyLockHash: z.string().regex(SHA256_RE),
  strategyConfigHash: z.string().regex(SHA256_RE),
  validationReceipts: z.array(validationReceiptBindingSchema).length(
    D1_RELEASE_CHECK_IDS.length,
  ),
  sidecarEnvironment: sidecarEnvironmentBindingV1Schema,
  admissionDecisionId: z.null(),
  engineeringChecks: z.array(z.string().trim().min(1).max(200)).length(
    D1_RELEASE_CHECK_IDS.length,
  ),
  liveExecutionArmed: z.literal(false),
}).strict().superRefine((value, ctx) => {
  refineCommonManifest(value, ctx)

  for (const path of Object.keys(value.artifactHashes)) {
    const forbiddenReason = d1ForbiddenReleasePath(path)
    if (forbiddenReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifactHashes', path],
        message: `D1 forbidden release artifact (${forbiddenReason}): ${path}`,
      })
    }
    if (!isD1ReleaseArtifactPathAllowed(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifactHashes', path],
        message: `D1 artifact is not in the exact allowlist: ${path}`,
      })
    }
  }

  if (!hasExactD1CheckIds(value.engineeringChecks)) {
    ctx.addIssue({
      code: 'custom',
      path: ['engineeringChecks'],
      message: 'engineeringChecks must be the exact D1 release gate set',
    })
  }
  if (!hasExactD1CheckIds(value.validationReceipts.map((receipt) => receipt.checkId))) {
    ctx.addIssue({
      code: 'custom',
      path: ['validationReceipts'],
      message: 'validationReceipts must bind the exact D1 release gate set',
    })
  }
  for (const path of D1_RELEASE_REQUIRED_ARTIFACT_PATHS) {
    if (!SHA256_RE.test(value.artifactHashes[path] ?? '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifactHashes', path],
        message: `D1 required artifact is missing: ${path}`,
      })
    }
  }

  const receiptPaths = new Set<string>()
  for (const receipt of value.validationReceipts) {
    const expectedPath = `release-metadata/validation-receipts/${receipt.checkId}.validation_receipt.v1.json`
    if (!isSafeRelativePath(receipt.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} path must be safe and release-relative`,
      })
    }
    if (receipt.path !== expectedPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} must use its exact D1 artifact path`,
      })
    }
    if (receiptPaths.has(receipt.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt path is duplicated: ${receipt.path}`,
      })
    }
    receiptPaths.add(receipt.path)
    if (value.artifactHashes[receipt.path] !== receipt.receiptHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} is not hash-bound as a release artifact`,
      })
    }
    if (Date.parse(receipt.executedAt) > Date.parse(value.builtAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} was executed after build time`,
      })
    }
  }

  const environment = value.sidecarEnvironment
  if (value.artifactHashes[environment.receiptPath] !== environment.receiptHash) {
    ctx.addIssue({
      code: 'custom',
      path: ['sidecarEnvironment', 'receiptHash'],
      message: 'environment receipt is not hash-bound as a release artifact',
    })
  }
  if (
    value.artifactHashes[environment.contractPath]
    !== environment.receipt.contractHash
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['sidecarEnvironment', 'receipt', 'contractHash'],
      message: 'environment contract hash does not match the release artifact',
    })
  }
  if (
    value.artifactHashes[SIDECAR_RUNTIME_LOCK_PATH]
    !== environment.receipt.lockHash
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['sidecarEnvironment', 'receipt', 'lockHash'],
      message: 'environment lock hash does not match the release artifact',
    })
  }
  if (
    value.artifactHashes[SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH]
    !== environment.receipt.wheelManifestHash
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['sidecarEnvironment', 'receipt', 'wheelManifestHash'],
      message: 'wheel manifest hash does not match the release artifact',
    })
  }
  if (value.artifactHashes[EXECUTION_PROTO_PATH] !== environment.receipt.protoHash) {
    ctx.addIssue({
      code: 'custom',
      path: ['sidecarEnvironment', 'receipt', 'protoHash'],
      message: 'execution proto hash does not match the release artifact',
    })
  }
  if (
    value.artifactHashes['dist/proto/openalice_execution_v1.proto']
    !== environment.receipt.protoHash
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['artifactHashes', 'dist/proto/openalice_execution_v1.proto'],
      message: 'generated execution proto hash does not match the release artifact',
    })
  }
  if (Date.parse(environment.receipt.executedAt) > Date.parse(value.builtAt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['sidecarEnvironment', 'receipt', 'executedAt'],
      message: 'environment receipt was executed after build time',
    })
  }
  if (!SHA256_RE.test(value.artifactHashes[D1_RELEASE_BUNDLE_METADATA_PATH] ?? '')) {
    ctx.addIssue({
      code: 'custom',
      path: ['artifactHashes', D1_RELEASE_BUNDLE_METADATA_PATH],
      message: 'D1 release bundle manifest must be hash-bound as a release artifact',
    })
  }
  for (const [path, expectedHash, field] of [
    [PIPELINE_REGISTRY_METADATA_PATH, value.pipelineRegistryHash, 'pipelineRegistryHash'],
    [DEPENDENCY_LOCK_METADATA_PATH, value.dependencyLockHash, 'dependencyLockHash'],
    [STRATEGY_CONFIG_METADATA_PATH, value.strategyConfigHash, 'strategyConfigHash'],
  ] as const) {
    if (value.artifactHashes[path] !== expectedHash) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} does not match its release metadata artifact`,
      })
    }
  }
})

export type ReleaseManifestV1 = z.infer<typeof releaseManifestV1Schema>
export type ReleaseManifestV2 = z.infer<typeof releaseManifestV2Schema>
export type ReleaseManifest = ReleaseManifestV1 | ReleaseManifestV2
export type ReleaseValidationReceiptBinding = z.infer<
  typeof validationReceiptBindingSchema
>
export type SidecarEnvironmentReceiptV1 = z.infer<
  typeof sidecarEnvironmentReceiptV1Schema
>
export type SidecarEnvironmentBindingV1 = z.infer<
  typeof sidecarEnvironmentBindingV1Schema
>

export type ReleaseManifestCore = Omit<
  ReleaseManifestV1,
  'schemaVersion' | 'manifestHash'
>
export type ReleaseManifestV2Core = Omit<
  ReleaseManifestV2,
  'schemaVersion' | 'manifestHash'
>

export function buildReleaseManifest(core: ReleaseManifestCore): ReleaseManifestV1 {
  return releaseManifestV1Schema.parse({
    schemaVersion: RELEASE_MANIFEST_V1,
    manifestHash: releaseManifestHash(core),
    ...core,
  })
}

export function validateReleaseManifest(input: unknown): ReleaseManifestV1 {
  const manifest = releaseManifestV1Schema.parse(input)
  const { schemaVersion: _schemaVersion, manifestHash, ...core } = manifest
  if (releaseManifestHash(core) !== manifestHash) {
    throw new Error('release_manifest_hash_mismatch')
  }
  return manifest
}

export function buildReleaseManifestV2(
  core: ReleaseManifestV2Core,
): ReleaseManifestV2 {
  return releaseManifestV2Schema.parse({
    schemaVersion: RELEASE_MANIFEST_V2,
    manifestHash: releaseManifestHash(core),
    ...core,
  })
}

export function validateReleaseManifestV2(input: unknown): ReleaseManifestV2 {
  const manifest = releaseManifestV2Schema.parse(input)
  const { schemaVersion: _schemaVersion, manifestHash, ...core } = manifest
  if (releaseManifestHash(core) !== manifestHash) {
    throw new Error('release_manifest_hash_mismatch')
  }
  return manifest
}

export function validateAnyReleaseManifest(input: unknown): ReleaseManifest {
  if (
    typeof input === 'object'
    && input !== null
    && 'schemaVersion' in input
    && input.schemaVersion === RELEASE_MANIFEST_V2
  ) {
    return validateReleaseManifestV2(input)
  }
  return validateReleaseManifest(input)
}

export function releaseManifestHash(
  core: ReleaseManifestCore | ReleaseManifestV2Core,
): string {
  return sha256Canonical(core)
}

/** Return a stable reason when a path is forbidden from a D1 release. */
export function d1ForbiddenReleasePath(path: string): string | null {
  if (!isSafeRelativePath(path)) return null
  const segments = path.split('/')
  const filename = segments.at(-1)!
  if (segments[0] === 'node_modules') return 'node_application_runtime'
  if (segments[0] === 'default') return 'general_default_bundle'
  if (segments[0] === 'dist' && path !== D1_GENERATED_PROTO_PATH) {
    return 'general_application_dist'
  }
  if (segments.some((segment) => D1_FORBIDDEN_CACHE_SEGMENTS.has(segment))) {
    return 'cache'
  }
  if (segments.some((segment) => D1_FORBIDDEN_TEST_SEGMENTS.has(segment))) {
    return 'test_or_integration'
  }
  if (filename === '.DS_Store' || filename.endsWith('.pyc')) return 'cache'
  if (
    filename.endsWith('.spec.ts')
    || filename.endsWith('.test.ts')
    || filename.endsWith('.integration.ts')
    || filename.endsWith('.integration.spec.ts')
    || filename.startsWith('test_') && filename.endsWith('.py')
    || filename.endsWith('_test.py')
    || filename.endsWith('_test_server.py')
  ) {
    return 'test_or_integration'
  }
  if (D1_FORBIDDEN_EXACT_FILENAMES.has(filename)) return 'test_or_helper'

  const isNautilusSidecar = segments.slice(0, 2).join('/') === 'sidecars/nautilus_paper'
  if (!isNautilusSidecar) return null
  if (
    filename.startsWith('provision_')
    || filename.startsWith('install_')
    || filename.startsWith('generate_')
    || filename.startsWith('verify_dependency')
  ) {
    return 'provision_or_dependency_helper'
  }
  if (
    filename.startsWith('requirements-')
    && filename.endsWith('.lock')
    && path !== D1_RUNTIME_LOCK_PATH
  ) {
    return 'broad_runtime_lock'
  }
  if (
    filename.startsWith('wheelhouse-')
    && filename.endsWith('.sha256')
    && path !== D1_RUNTIME_WHEEL_MANIFEST_PATH
  ) {
    return 'broad_wheel_manifest'
  }
  return null
}

/** D1 allows no additive artifacts: hash binding is not an authority grant. */
export function isD1ReleaseArtifactPathAllowed(path: string): boolean {
  if ((D1_RELEASE_REQUIRED_ARTIFACT_PATHS as readonly string[]).includes(path)) return true
  return D1_RELEASE_CHECK_IDS.some((checkId) => (
    path === `release-metadata/validation-receipts/${checkId}.validation_receipt.v1.json`
  ))
}

/** Reject D1 artifact declarations before any bytes are trusted or executed. */
export function assertNoForbiddenD1ReleaseArtifactPaths(paths: Iterable<string>): void {
  for (const path of paths) {
    const reason = d1ForbiddenReleasePath(path)
    if (reason) throw new Error(`d1_release_forbidden_artifact:${path}:${reason}`)
    if (!isD1ReleaseArtifactPathAllowed(path)) {
      throw new Error(`d1_release_artifact_not_in_allowlist:${path}`)
    }
  }
}

function refineCommonManifest(
  value: ReleaseManifestV2,
  ctx: z.RefinementCtx,
): void {
  if (value.releaseId !== value.sourceCommit) {
    ctx.addIssue({
      code: 'custom',
      path: ['releaseId'],
      message: 'releaseId must equal sourceCommit',
    })
  }
  if (!isSafeRelativePath(value.runtimeEntry)) {
    ctx.addIssue({
      code: 'custom',
      path: ['runtimeEntry'],
      message: 'runtimeEntry must be a safe relative path',
    })
  }
  if (!(value.runtimeEntry in value.artifactHashes)) {
    ctx.addIssue({
      code: 'custom',
      path: ['artifactHashes'],
      message: 'runtimeEntry must be covered by artifactHashes',
    })
  }
  for (const path of Object.keys(value.artifactHashes)) {
    if (!isSafeRelativePath(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifactHashes', path],
        message: 'artifact path must be safe and relative',
      })
    }
  }
  for (const receipt of value.validationReceipts) {
    if (receipt.sourceCommit !== value.sourceCommit) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} sourceCommit mismatch`,
      })
    }
    if (receipt.dirtyStateHash !== value.dirtyStateHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} dirtyStateHash mismatch`,
      })
    }
    if (Date.parse(receipt.expiresAt) <= Date.parse(value.builtAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationReceipts'],
        message: `receipt ${receipt.checkId} is stale at build time`,
      })
    }
  }
}

function hasExactD1CheckIds(values: readonly string[]): boolean {
  if (values.length !== D1_RELEASE_CHECK_IDS.length) return false
  const actual = new Set(values)
  return actual.size === D1_RELEASE_CHECK_IDS.length
    && D1_RELEASE_CHECK_IDS.every((checkId) => actual.has(checkId))
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false
  const segments = path.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}
