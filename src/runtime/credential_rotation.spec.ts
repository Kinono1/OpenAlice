import { describe, expect, it } from 'vitest'
import {
  assertCredentialRotationReady,
  assertPrimaryCredentialRotationReady,
  buildCredentialRotationReceipt,
  validateCredentialRotationReceipt,
  type CredentialRotationReceiptCore,
} from './credential_rotation.js'

describe('CredentialRotationReceiptV1', () => {
  it('passes only with stored credentials, confirmed revocation and all scans', () => {
    const receipt = buildCredentialRotationReceipt(makeCore())
    expect(validateCredentialRotationReceipt(receipt)).toEqual(receipt)
    expect(assertCredentialRotationReady(receipt)).toEqual(receipt)
    expect(receipt.status).toBe('pass')
  })

  it.each([
    ['new credential missing', { newCredentialStored: false }],
    ['old credential revocation unknown', { oldCredentialRevoked: 'unknown' }],
    ['one scan failed', { argvScan: 'fail' }],
  ] as const)('blocks when %s', (_label, patch) => {
    const receipt = buildCredentialRotationReceipt({ ...makeCore(), ...patch })
    expect(receipt.status).toBe('blocked')
    expect(() => assertCredentialRotationReady(receipt)).toThrow(
      'credential_rotation_receipt_blocked',
    )
  })

  it('detects receipt tampering', () => {
    const receipt = buildCredentialRotationReceipt(makeCore())
    expect(() => validateCredentialRotationReceipt({
      ...receipt,
      oldCredentialRevoked: 'unknown',
      status: 'blocked',
    })).toThrow('credential_rotation_receipt_hash_mismatch')
  })

  it('does not let a partial credential scope authorize primary activation', () => {
    const receipt = buildCredentialRotationReceipt(makeCore())
    expect(() => assertPrimaryCredentialRotationReady(receipt)).toThrow(
      'credential_rotation_receipt_scope_missing',
    )
  })
})

function makeCore(): CredentialRotationReceiptCore {
  return {
    credentialNames: ['OKX_SECRET_KEY', 'DEEPSEEK_API_KEY'],
    rotatedAt: '2026-08-01T12:00:00.000Z',
    newCredentialStored: true,
    oldCredentialRevoked: 'yes',
    argvScan: 'pass',
    plistScan: 'pass',
    logScan: 'pass',
    apiScan: 'pass',
    gitScan: 'pass',
    artifactScan: 'pass',
    fixtureScan: 'pass',
    evidenceRefs: [
      'credential_revocation:external_receipt:sha256:' + '1'.repeat(64),
    ],
  }
}
