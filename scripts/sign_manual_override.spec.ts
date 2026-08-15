import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeManualOverride,
  signManualOverridePayload,
  verifyManualOverrideSignature,
} from '../src/runtime/manual_override.js'
import type { SignedManualOverride } from '../src/runtime/manual_override.js'

const TEST_SECRET = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'

function unsigned(overrides: Partial<SignedManualOverride> = {}): SignedManualOverride {
  return {
    pauseNewOpens: true,
    reason: 'test',
    issuedBy: 'spec',
    issuedAt: '2026-06-01T12:00:00.000Z',
    expiresAt: '2026-06-01T12:30:00.000Z',
    signature: '',
    ...overrides,
  } as SignedManualOverride
}

describe('sign_manual_override', () => {
  it('signs and verifies roundtrip', () => {
    const input = unsigned()
    const sig = signManualOverridePayload(TEST_SECRET, input)
    const signed = { ...input, signature: sig }
    expect(verifyManualOverrideSignature(TEST_SECRET, signed)).toBe(true)
  })

  it('same payload produces same signature (deterministic canonical)', () => {
    const a = signManualOverridePayload(TEST_SECRET, unsigned({ note: 'x' }))
    const b = signManualOverridePayload(TEST_SECRET, unsigned({ note: 'x' }))
    expect(a).toBe(b)
  })

  it('approvedBy ordering does not affect signature', () => {
    const a = signManualOverridePayload(TEST_SECRET, unsigned({ approvedBy: ['z', 'a'] }))
    const b = signManualOverridePayload(TEST_SECRET, unsigned({ approvedBy: ['a', 'z'] }))
    expect(a).toBe(b)
  })

  it('rejects wrong secret', () => {
    const sig = signManualOverridePayload(TEST_SECRET, unsigned())
    const signed = { ...unsigned(), signature: sig }
    const wrong = '0000000000000000000000000000000000000000000000000000000000000000'
    expect(verifyManualOverrideSignature(wrong, signed)).toBe(false)
  })

  it('rejects tampered payload', () => {
    const sig = signManualOverridePayload(TEST_SECRET, unsigned({ pauseNewOpens: false }))
    const signed = { ...unsigned({ pauseNewOpens: true }), signature: sig }
    expect(verifyManualOverrideSignature(TEST_SECRET, signed)).toBe(false)
  })
})
