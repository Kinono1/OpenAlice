import { describe, expect, it } from 'vitest'
import {
  D1_RELEASE_BUNDLE_METADATA_PATH,
  D1_RELEASE_CHECK_IDS,
  D1_RELEASE_REQUIRED_ARTIFACT_PATHS,
  DEPENDENCY_LOCK_METADATA_PATH,
  EXECUTION_PROTO_PATH,
  PIPELINE_REGISTRY_METADATA_PATH,
  SIDECAR_ENVIRONMENT_RECEIPT_PATH,
  SIDECAR_RUNTIME_CONTRACT_PATH,
  SIDECAR_RUNTIME_LOCK_PATH,
  SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH,
  STRATEGY_CONFIG_METADATA_PATH,
  buildReleaseManifest,
  buildReleaseManifestV2,
  validateAnyReleaseManifest,
  validateReleaseManifest,
  validateReleaseManifestV2,
  type ReleaseManifestCore,
  type ReleaseManifestV2Core,
} from './release_manifest.js'

const COMMIT = '1'.repeat(40)
const HASH = '2'.repeat(64)
const BUILT_AT = '2026-08-01T12:00:00.000Z'

describe('ReleaseManifestV1', () => {
  it('binds an engineering release to source, artifacts, registry and receipts', () => {
    const manifest = buildReleaseManifest(makeCore())
    expect(validateReleaseManifest(manifest)).toEqual(manifest)
    expect(manifest.releaseId).toBe(COMMIT)
    expect(manifest.liveExecutionArmed).toBe(false)
  })

  it('rejects tampering and stale or mismatched receipts', () => {
    const manifest = buildReleaseManifest(makeCore())
    expect(() => validateReleaseManifest({
      ...manifest,
      runtimeEntry: 'dist/other.js',
    })).toThrow()

    expect(() => buildReleaseManifest({
      ...makeCore(),
      validationReceipts: [{
        ...makeCore().validationReceipts[0],
        sourceCommit: '3'.repeat(40),
      }],
    })).toThrow('sourceCommit mismatch')
  })

  it('forbids unsafe paths and any armed engineering release', () => {
    expect(() => buildReleaseManifest({
      ...makeCore(),
      runtimeEntry: '../dist/main.js',
      artifactHashes: { '../dist/main.js': HASH },
    })).toThrow('safe relative path')

    expect(() => buildReleaseManifest({
      ...makeCore(),
      liveExecutionArmed: true,
    } as never)).toThrow()
  })
})

describe('ReleaseManifestV2', () => {
  it('binds the exact D1 checks and PAPER_LOCAL environment evidence', () => {
    const manifest = buildReleaseManifestV2(makeV2Core())

    expect(validateReleaseManifestV2(manifest)).toEqual(manifest)
    expect(validateAnyReleaseManifest(manifest)).toEqual(manifest)
    expect(manifest.sidecarEnvironment.receipt.flags).toEqual({
      paperOnly: true,
      liveTradingAllowed: false,
      liveExecutionArmed: false,
    })
  })

  it('rejects missing D1 evidence and environment evidence not bound as artifacts', () => {
    const core = makeV2Core()
    expect(() => buildReleaseManifestV2({
      ...core,
      engineeringChecks: core.engineeringChecks.slice(1),
    } as never)).toThrow()

    expect(() => buildReleaseManifestV2({
      ...core,
      artifactHashes: {
        ...core.artifactHashes,
        [SIDECAR_ENVIRONMENT_RECEIPT_PATH]: 'f'.repeat(64),
      },
    })).toThrow('environment receipt is not hash-bound')
  })

  it('rejects absolute validation receipt paths and post-build evidence', () => {
    const core = makeV2Core()
    expect(() => buildReleaseManifestV2({
      ...core,
      validationReceipts: core.validationReceipts.map((receipt, index) => (
        index === 0 ? { ...receipt, path: '/tmp/receipt.json' } : receipt
      )),
    })).toThrow('release-relative')

    expect(() => buildReleaseManifestV2({
      ...core,
      sidecarEnvironment: {
        ...core.sidecarEnvironment,
        receipt: {
          ...core.sidecarEnvironment.receipt,
          executedAt: '2026-08-01T12:00:01.000Z',
        },
      },
    })).toThrow('after build time')
  })

  it.each([
    'sidecars/nautilus_paper/test_supervisor.py',
    'scripts/runtime.integration.spec.ts',
    'sidecars/nautilus_paper/requirements-macos-arm64-cp313.lock',
    'sidecars/nautilus_paper/dependency_verification.v1.json',
    'sidecars/nautilus_paper/__pycache__/runtime.cpython-313.pyc',
    'dist/main.js',
  ])('rejects a hash-bound forbidden D1 artifact: %s', (path) => {
    const core = makeV2Core()
    expect(() => buildReleaseManifestV2({
      ...core,
      artifactHashes: { ...core.artifactHashes, [path]: 'f'.repeat(64) },
    })).toThrow('D1 forbidden release artifact')
  })

  it('rejects a non-test broker-shaped artifact even when it is hash-bound', () => {
    const core = makeV2Core()
    expect(() => buildReleaseManifestV2({
      ...core,
      artifactHashes: {
        ...core.artifactHashes,
        'src/domain/trading/brokers/ccxt/evil.ts': 'f'.repeat(64),
      },
    })).toThrow('exact allowlist')
  })

  it('binds both committed and generated execution protobuf bytes to the receipt', () => {
    const core = makeV2Core()
    expect(() => buildReleaseManifestV2({
      ...core,
      artifactHashes: {
        ...core.artifactHashes,
        'dist/proto/openalice_execution_v1.proto': '0'.repeat(64),
      },
    })).toThrow('generated execution proto hash')
  })
})

function makeCore(): ReleaseManifestCore {
  return {
    releaseId: COMMIT,
    sourceCommit: COMMIT,
    dirtyStateHash: HASH,
    builtAt: BUILT_AT,
    runtimeEntry: 'dist/main.js',
    artifactHashes: {
      'dist/main.js': '3'.repeat(64),
      'package.json': '4'.repeat(64),
      [D1_RELEASE_BUNDLE_METADATA_PATH]: '4'.repeat(64),
    },
    pipelineRegistryHash: '5'.repeat(64),
    dependencyLockHash: '6'.repeat(64),
    strategyConfigHash: '7'.repeat(64),
    validationReceipts: [{
      checkId: 'typescript',
      path: 'runtime/control-plane/receipts/typescript.json',
      receiptHash: '8'.repeat(64),
      sourceCommit: COMMIT,
      dirtyStateHash: HASH,
      executedAt: BUILT_AT,
      expiresAt: '2026-08-02T12:00:00.000Z',
      status: 'pass',
    }],
    admissionDecisionId: null,
    engineeringChecks: ['build', 'typecheck', 'tests'],
    liveExecutionArmed: false,
  }
}

function makeV2Core(): ReleaseManifestV2Core {
  const validationReceipts = D1_RELEASE_CHECK_IDS.map((checkId, index) => ({
    checkId,
    path: `release-metadata/validation-receipts/${checkId}.validation_receipt.v1.json`,
    receiptHash: `${index + 1}`.repeat(64),
    sourceCommit: COMMIT,
    dirtyStateHash: HASH,
    executedAt: '2026-08-01T11:50:00.000Z',
    expiresAt: '2026-08-02T12:00:00.000Z',
    status: 'pass' as const,
  }))
  const environmentReceiptHash = 'e'.repeat(64)
  const contractHash = 'a'.repeat(64)
  const lockHash = 'b'.repeat(64)
  const wheelManifestHash = 'c'.repeat(64)
  const protoHash = 'd'.repeat(64)
  return {
    releaseId: COMMIT,
    sourceCommit: COMMIT,
    dirtyStateHash: HASH,
    builtAt: BUILT_AT,
    runtimeEntry: 'ops/release/launch_nautilus_paper.sh',
    artifactHashes: {
      ...Object.fromEntries(D1_RELEASE_REQUIRED_ARTIFACT_PATHS.map((path) => [path, 'f'.repeat(64)])),
      'package.json': '4'.repeat(64),
      [D1_RELEASE_BUNDLE_METADATA_PATH]: '4'.repeat(64),
      [SIDECAR_ENVIRONMENT_RECEIPT_PATH]: environmentReceiptHash,
      [SIDECAR_RUNTIME_CONTRACT_PATH]: contractHash,
      [SIDECAR_RUNTIME_LOCK_PATH]: lockHash,
      [SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH]: wheelManifestHash,
      [EXECUTION_PROTO_PATH]: protoHash,
      'dist/proto/openalice_execution_v1.proto': protoHash,
      [PIPELINE_REGISTRY_METADATA_PATH]: '5'.repeat(64),
      [DEPENDENCY_LOCK_METADATA_PATH]: '6'.repeat(64),
      [STRATEGY_CONFIG_METADATA_PATH]: '7'.repeat(64),
      ...Object.fromEntries(
        validationReceipts.map((receipt) => [receipt.path, receipt.receiptHash]),
      ),
    },
    pipelineRegistryHash: '5'.repeat(64),
    dependencyLockHash: '6'.repeat(64),
    strategyConfigHash: '7'.repeat(64),
    validationReceipts,
    sidecarEnvironment: {
      receiptPath: SIDECAR_ENVIRONMENT_RECEIPT_PATH,
      receiptHash: environmentReceiptHash,
      contractPath: SIDECAR_RUNTIME_CONTRACT_PATH,
      receipt: {
        schemaVersion: 'openalice_sidecar_environment_receipt.v1',
        contractHash,
        interpreterHash: '8'.repeat(64),
        pyvenvCfgHash: '9'.repeat(64),
        baseRuntimeAggregate: 'a'.repeat(64),
        sitePackagesAggregate: 'b'.repeat(64),
        installedAggregate: '0'.repeat(64),
        lockHash,
        wheelManifestHash,
        protoHash,
        generatedAggregate: 'f'.repeat(64),
        target: {
          implementation: 'CPython',
          python: '3.13.5',
          cacheTag: 'cpython-313',
          system: 'Darwin',
          macosMajor: 26,
          machine: 'arm64',
        },
        flags: {
          paperOnly: true,
          liveTradingAllowed: false,
          liveExecutionArmed: false,
        },
        executedAt: '2026-08-01T11:49:00.000Z',
        status: 'pass',
      },
    },
    admissionDecisionId: null,
    engineeringChecks: [...D1_RELEASE_CHECK_IDS],
    liveExecutionArmed: false,
  }
}
