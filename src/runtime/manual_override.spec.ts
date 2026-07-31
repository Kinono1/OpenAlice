import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveManualOverrideSecret } from '../core/manual-override-secret.js'
import {
  DEFAULT_MANUAL_OVERRIDE,
  loadManualOverride,
  signManualOverridePayload,
  type SignedManualOverride,
} from './manual_override.js'

function fixtureSecret(): string {
  return `fixture-${'a'.repeat(40)}`
}

function signedFixture(
  overrides: Partial<SignedManualOverride> = {},
): SignedManualOverride {
  const issuedAt = '2026-07-31T00:00:00.000Z'
  const unsigned: SignedManualOverride = {
    pauseNewOpens: true,
    reason: 'fixture',
    issuedBy: 'operator-a',
    issuedAt,
    expiresAt: '2026-07-31T00:30:00.000Z',
    signature: '',
    ...overrides,
  }
  return {
    ...unsigned,
    signature: signManualOverridePayload(fixtureSecret(), unsigned),
  }
}

describe('manual override secret resolution', () => {
  it('reads a protected external file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manual-override-secret-'))
    const path = join(dir, 'hmac')
    await writeFile(path, fixtureSecret(), { mode: 0o600 })
    await chmod(path, 0o600)

    expect(
      resolveManualOverrideSecret({
        ALICE_MANUAL_OVERRIDE_SECRET_FILE: path,
      }),
    ).toBe(fixtureSecret())
  })

  it('rejects an external file readable by group or others', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manual-override-permissions-'))
    const path = join(dir, 'hmac')
    await writeFile(path, fixtureSecret(), { mode: 0o644 })
    await chmod(path, 0o644)

    expect(
      resolveManualOverrideSecret({
        ALICE_MANUAL_OVERRIDE_SECRET_FILE: path,
      }),
    ).toBeNull()
  })

  it('allows the legacy inline variable only in tests', () => {
    expect(
      resolveManualOverrideSecret({
        NODE_ENV: 'production',
        ALICE_MANUAL_OVERRIDE_SECRET: fixtureSecret(),
      }),
    ).toBeNull()
    expect(
      resolveManualOverrideSecret({
        NODE_ENV: 'test',
        ALICE_MANUAL_OVERRIDE_SECRET: fixtureSecret(),
      }),
    ).toBe(fixtureSecret())
  })
})

describe('manual override loading', () => {
  it('preserves the legacy string path and fails closed when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manual-override-missing-'))
    await expect(loadManualOverride(join(dir, 'missing.json'))).resolves.toEqual(
      DEFAULT_MANUAL_OVERRIDE,
    )
  })

  it('rejects an unsigned legacy payload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manual-override-unsigned-'))
    const path = join(dir, 'override.json')
    await writeFile(path, JSON.stringify({ pauseNewOpens: true }), 'utf-8')

    await expect(
      loadManualOverride({
        filePath: path,
        env: { NODE_ENV: 'test', ALICE_MANUAL_OVERRIDE_SECRET: fixtureSecret() },
        now: new Date('2026-07-31T00:10:00.000Z'),
      }),
    ).resolves.toEqual(DEFAULT_MANUAL_OVERRIDE)
  })

  it('accepts a valid bounded signed pause', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manual-override-valid-'))
    const path = join(dir, 'override.json')
    await writeFile(path, JSON.stringify(signedFixture()), 'utf-8')

    await expect(
      loadManualOverride({
        filePath: path,
        env: { NODE_ENV: 'test', ALICE_MANUAL_OVERRIDE_SECRET: fixtureSecret() },
        now: new Date('2026-07-31T00:10:00.000Z'),
      }),
    ).resolves.toMatchObject({ pauseNewOpens: true })
  })

  it('requires two distinct approvals for a high-risk field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manual-override-approval-'))
    const path = join(dir, 'override.json')
    await writeFile(
      path,
      JSON.stringify(
        signedFixture({
          ignoreReleaseGate: true,
          approvedBy: ['operator-a'],
        }),
      ),
      'utf-8',
    )

    await expect(
      loadManualOverride({
        filePath: path,
        env: { NODE_ENV: 'test', ALICE_MANUAL_OVERRIDE_SECRET: fixtureSecret() },
        now: new Date('2026-07-31T00:10:00.000Z'),
      }),
    ).resolves.toEqual(DEFAULT_MANUAL_OVERRIDE)
  })
})
