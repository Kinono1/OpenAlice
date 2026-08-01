import { z } from 'zod'
import { sha256Canonical } from '../sidecar/contracts.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const REVOCATION_EVIDENCE_RE = /^credential_revocation:[a-z0-9_.-]+:sha256:[a-f0-9]{64}$/
const scanStatusSchema = z.enum(['pass', 'fail'])

export const PRIMARY_CREDENTIAL_ROTATION_NAMES = [
  'DEEPSEEK_API_KEY',
  'OKX_API_KEY',
  'OKX_SECRET_KEY',
  'OKX_PASSPHRASE',
  'OPENALICE_WEB_AUTH_TOKEN',
  'TELEGRAM_BOT_TOKEN',
] as const

export const credentialRotationReceiptV1Schema = z.object({
  schemaVersion: z.literal('credential_rotation_receipt.v1'),
  receiptId: z.string().regex(SHA256_RE),
  scope: z.enum(['production', 'isolated_test']),
  credentialNames: z.array(z.string().trim().min(1).max(300)).min(1),
  rotatedAt: z.string().datetime(),
  newCredentialStored: z.boolean(),
  oldCredentialRevoked: z.enum(['yes', 'no', 'unknown']),
  argvScan: scanStatusSchema,
  plistScan: scanStatusSchema,
  logScan: scanStatusSchema,
  apiScan: scanStatusSchema,
  gitScan: scanStatusSchema,
  artifactScan: scanStatusSchema,
  fixtureScan: scanStatusSchema,
  status: z.enum(['pass', 'blocked']),
  evidenceRefs: z.array(z.string().trim().min(1).max(2000)).min(1),
}).strict().superRefine((value, ctx) => {
  const expected = computeCredentialRotationStatus(value)
  if (value.status !== expected) {
    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message: `status must be ${expected}`,
    })
  }
  if (
    value.oldCredentialRevoked === 'yes'
    && !value.evidenceRefs.some((reference) => REVOCATION_EVIDENCE_RE.test(reference))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidenceRefs'],
      message: 'confirmed revocation requires a hash-bound external evidence reference',
    })
  }
})

export type CredentialRotationReceiptV1 = z.infer<
  typeof credentialRotationReceiptV1Schema
>

export type CredentialRotationReceiptCore = Omit<
  CredentialRotationReceiptV1,
  'schemaVersion' | 'receiptId' | 'status'
>

export function buildCredentialRotationReceipt(
  input: CredentialRotationReceiptCore,
): CredentialRotationReceiptV1 {
  const normalized = {
    ...input,
    credentialNames: [...new Set(input.credentialNames.map((value) => value.trim()))]
      .filter(Boolean)
      .sort(),
    evidenceRefs: [...new Set(input.evidenceRefs.map((value) => value.trim()))]
      .filter(Boolean)
      .sort(),
  }
  const status = computeCredentialRotationStatus(normalized)
  const core = { ...normalized, status }
  return credentialRotationReceiptV1Schema.parse({
    schemaVersion: 'credential_rotation_receipt.v1',
    receiptId: sha256Canonical(core),
    ...core,
  })
}

export function validateCredentialRotationReceipt(
  input: unknown,
): CredentialRotationReceiptV1 {
  const receipt = credentialRotationReceiptV1Schema.parse(input)
  const { schemaVersion: _schemaVersion, receiptId, ...core } = receipt
  if (sha256Canonical(core) !== receiptId) {
    throw new Error('credential_rotation_receipt_hash_mismatch')
  }
  return receipt
}

export function assertCredentialRotationReady(
  input: unknown,
): CredentialRotationReceiptV1 {
  const receipt = validateCredentialRotationReceipt(input)
  if (receipt.status !== 'pass') {
    throw new Error('credential_rotation_receipt_blocked')
  }
  return receipt
}

export function assertPrimaryCredentialRotationReady(
  input: unknown,
  requiredScope: CredentialRotationReceiptV1['scope'] = 'production',
): CredentialRotationReceiptV1 {
  const receipt = assertCredentialRotationReady(input)
  if (receipt.scope !== requiredScope) {
    throw new Error('credential_rotation_receipt_scope_mismatch')
  }
  const present = new Set(receipt.credentialNames)
  const missing = PRIMARY_CREDENTIAL_ROTATION_NAMES.filter((name) => !present.has(name))
  if (missing.length > 0) {
    throw new Error(`credential_rotation_receipt_scope_missing:${missing.join(',')}`)
  }
  return receipt
}

function computeCredentialRotationStatus(input: {
  newCredentialStored: boolean
  oldCredentialRevoked: 'yes' | 'no' | 'unknown'
  argvScan: 'pass' | 'fail'
  plistScan: 'pass' | 'fail'
  logScan: 'pass' | 'fail'
  apiScan: 'pass' | 'fail'
  gitScan: 'pass' | 'fail'
  artifactScan: 'pass' | 'fail'
  fixtureScan: 'pass' | 'fail'
}): 'pass' | 'blocked' {
  return input.newCredentialStored
    && input.oldCredentialRevoked === 'yes'
    && [
      input.argvScan,
      input.plistScan,
      input.logScan,
      input.apiScan,
      input.gitScan,
      input.artifactScan,
      input.fixtureScan,
    ].every((value) => value === 'pass')
    ? 'pass'
    : 'blocked'
}
