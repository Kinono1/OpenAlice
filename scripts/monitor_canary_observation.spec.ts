import { describe, expect, it } from 'vitest'
import { evaluateCanaryObservation, type CanaryObservationRecord } from './monitor_canary_observation.js'

const releasePath = '/tmp/openalice-release/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const manifestHash = 'b'.repeat(64)

function safeObservation(overrides: Partial<CanaryObservationRecord> = {}): CanaryObservationRecord {
  return {
    schemaVersion: 'canary_observation.v1',
    observedAt: '2026-08-08T00:00:00.000Z',
    pid: 123,
    expectedPid: 123,
    listenerCount: 1,
    webHealthHttp: 200,
    mcpUnauthHttp: 401,
    cwd: releasePath,
    processCommand: `/usr/bin/node ${releasePath}/dist/main.js`,
    releasePath,
    releaseManifestHash: manifestHash,
    releaseManifestVerified: true,
    inputTreeHash: 'c'.repeat(64),
    inputTreeUnchanged: true,
    rssBytes: 1024 * 1024,
    resourceAnomaly: false,
    writableOpenPaths: [],
    unexpectedWritePaths: [],
    logIdentityValid: true,
    representativeTaskStatus: 'pass',
    pidStable: true,
    crashDetected: false,
    ...overrides,
  }
}

describe('monitor_canary_observation', () => {
  it('accepts an observation bound to the immutable release', () => {
    expect(evaluateCanaryObservation(safeObservation(), 123, releasePath, manifestHash)).toEqual([])
  })

  it('reports every material boundary failure without weakening the gate', () => {
    const reasons = evaluateCanaryObservation(safeObservation({
      pid: 999,
      listenerCount: 2,
      webHealthHttp: 503,
      mcpUnauthHttp: 200,
      cwd: '/tmp/legacy-wip',
      processCommand: 'tsx src/main.ts',
      releaseManifestVerified: false,
      inputTreeUnchanged: false,
      resourceAnomaly: true,
      unexpectedWritePaths: ['/tmp/unapproved-write'],
      logIdentityValid: false,
      representativeTaskStatus: 'invalid',
      pidStable: false,
      crashDetected: true,
    }), 123, releasePath, manifestHash)

    expect(reasons).toEqual(expect.arrayContaining([
      'pid_changed',
      'listener_count_invalid',
      'health_not_200',
      'mcp_auth_boundary_invalid',
      'working_directory_escape',
      'immutable_entry_not_running',
      'release_manifest_unverified',
      'shared_input_changed',
      'resource_growth_anomaly',
      'unexpected_write_path',
      'startup_log_identity_invalid',
      'representative_task_not_pass',
      'pid_not_stable',
      'crash_detected',
    ]))
  })
})
