import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  configureRuntimeEnvironment,
  resolveRuntimePaths,
  resolveRuntimeRole,
} from './runtime-paths.js'

describe('RuntimePaths', () => {
  it('keeps all primary defaults on the legacy paths', () => {
    const repoRoot = '/repo/OpenAlice'
    const paths = resolveRuntimePaths({ repoRoot, env: {} })

    expect(paths.role).toBe('primary')
    expect(paths.configDir).toBe(join(repoRoot, 'data/config'))
    expect(paths.sharedDataInputDir).toBe(join(repoRoot, 'data'))
    expect(paths.marketInputDir).toBe(join(repoRoot, 'data/market'))
    expect(paths.cronStateFile).toBe(join(repoRoot, 'data/cron/jobs.json'))
    expect(paths.capabilities).toMatchObject({
      ownsCron: true,
      initializesAccounts: true,
      orderSubmissionPathEnabled: true,
      writesPromotion: true,
      writesSharedData: true,
    })
    expect(paths.portOverrides).toEqual({})
  })

  it('isolates canary writes while retaining read-only primary inputs', () => {
    const repoRoot = '/repo/OpenAlice'
    const paths = resolveRuntimePaths({
      repoRoot,
      env: {
        OPENALICE_RUNTIME_ROLE: 'canary',
        OPENALICE_CANARY_ROOT: '/tmp/openalice-canary',
      },
    })

    expect(paths.configDir).toBe(join(repoRoot, 'data/config'))
    expect(paths.marketInputDir).toBe(join(repoRoot, 'data/market'))
    expect(paths.sharedDataInputDir).toBe(join(repoRoot, 'data'))
    expect(paths.stateDir).toBe('/tmp/openalice-canary/state')
    expect(paths.logDir).toBe('/tmp/openalice-canary/logs')
    expect(paths.capabilities).toEqual({
      ownsCron: false,
      initializesAccounts: false,
      orderSubmissionPathEnabled: false,
      writesPromotion: false,
      writesSharedData: false,
    })
    expect(paths.portOverrides).toEqual({ web: 3102, mcp: 3101, mcpAsk: undefined })
  })

  it('requires test state to live below the OS temporary directory', () => {
    expect(() => resolveRuntimePaths({
      repoRoot: '/repo/OpenAlice',
      osTmpDir: '/tmp',
      env: {
        OPENALICE_RUNTIME_ROLE: 'test',
        OPENALICE_TEST_ROOT: '/repo/OpenAlice/data/test',
      },
    })).toThrow('must be inside the OS temporary directory')

    const paths = resolveRuntimePaths({
      repoRoot: '/repo/OpenAlice',
      osTmpDir: '/tmp',
      env: {
        OPENALICE_RUNTIME_ROLE: 'test',
        OPENALICE_TEST_ROOT: '/tmp/openalice-test',
      },
    })
    expect(paths.configDir).toBe('/tmp/openalice-test/config')
    expect(paths.capabilities.ownsCron).toBe(false)
  })

  it('rejects unknown roles and unsafe port values', () => {
    expect(() => resolveRuntimeRole('shadow')).toThrow('invalid OPENALICE_RUNTIME_ROLE')
    expect(() => resolveRuntimePaths({
      repoRoot: '/repo/OpenAlice',
      env: {
        OPENALICE_RUNTIME_ROLE: 'canary',
        OPENALICE_CANARY_WEB_PORT: '80',
      },
    })).toThrow('invalid runtime port')
  })

  it('publishes resolved paths for legacy consumers without changing admission', () => {
    const previous = { ...process.env }
    try {
      const paths = resolveRuntimePaths({
        repoRoot: '/repo/OpenAlice',
        env: {
          OPENALICE_RUNTIME_ROLE: 'canary',
          OPENALICE_CANARY_ROOT: '/tmp/openalice-canary-env',
        },
      })
      configureRuntimeEnvironment(paths)
      expect(process.env.OPENALICE_RUNTIME_ROLE).toBe('canary')
      expect(process.env.OPENALICE_DATA_DIR).toBe('/tmp/openalice-canary-env/state')
      expect(process.env.OPENALICE_CONFIG_READ_ONLY).toBe('1')
    } finally {
      process.env = previous
    }
  })
})
