import { describe, expect, it } from 'vitest'
import { parseArgs } from './audit_credential_rotation.js'

describe('audit_credential_rotation CLI', () => {
  it('keeps secrets out of argv and accepts names plus revocation state only', () => {
    const args = parseArgs([
      '--credentialNames',
      'DEEPSEEK_API_KEY,OKX_SECRET_KEY',
      '--envFile',
      '/tmp/openalice.env',
      '--oldCredentialRevoked',
      'unknown',
      '--allowBlocked',
      'true',
    ])
    expect(args.credentialNames).toEqual(['DEEPSEEK_API_KEY', 'OKX_SECRET_KEY'])
    expect(args.oldCredentialRevoked).toBe('unknown')
    expect(args.allowBlocked).toBe(true)
    expect(JSON.stringify(args)).not.toContain('value-a-')
  })

  it('requires hashable external evidence before claiming old credentials were revoked', () => {
    expect(() => parseArgs([
      '--oldCredentialRevoked',
      'yes',
    ])).toThrow('--revocationReceiptPath is required')

    expect(parseArgs([
      '--oldCredentialRevoked',
      'yes',
      '--revocationReceiptPath',
      '/tmp/provider-revocation-receipt.json',
    ]).revocationReceiptPath).toBe('/tmp/provider-revocation-receipt.json')
  })
})
