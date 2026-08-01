#!/usr/bin/env tsx

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  buildCredentialRotationReceipt,
  PRIMARY_CREDENTIAL_ROTATION_NAMES,
} from '../src/runtime/credential_rotation.js'
import {
  buildSecretScanFailure,
  inspectCredentialEnvFile,
  scanSecretPaths,
  scanSecretText,
  type SecretScanResultV1,
} from '../src/runtime/secret_scan.js'

const execFileAsync = promisify(execFile)

export interface CredentialAuditArgs {
  credentialNames: string[]
  envFile: string
  oldCredentialRevoked: 'yes' | 'no' | 'unknown'
  revocationReceiptPath?: string
  rotatedAt: string
  output?: string
  allowBlocked: boolean
  plistPaths: string[]
  logPaths: string[]
  apiPaths: string[]
  artifactPaths: string[]
  fixturePaths: string[]
}

export function parseArgs(argv: string[]): CredentialAuditArgs {
  const values = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    const value = !next || next.startsWith('--') ? 'true' : next
    values.set(key, [...(values.get(key) ?? []), value])
    if (next && !next.startsWith('--')) index += 1
  }
  const get = (key: string) => values.get(key)?.at(-1)
  const list = (key: string, fallback: readonly string[] = []) => {
    const raw = values.get(key)
    const source = raw && raw.length > 0 ? raw : [...fallback]
    return source
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean)
  }
  const revoked = get('oldCredentialRevoked') ?? 'unknown'
  if (!['yes', 'no', 'unknown'].includes(revoked)) {
    throw new Error('--oldCredentialRevoked must be yes, no, or unknown')
  }
  const revocationReceiptPath = get('revocationReceiptPath')
    ? resolve(get('revocationReceiptPath')!)
    : undefined
  if (revoked === 'yes' && !revocationReceiptPath) {
    throw new Error('--revocationReceiptPath is required when oldCredentialRevoked=yes')
  }
  return {
    credentialNames: list('credentialNames', PRIMARY_CREDENTIAL_ROTATION_NAMES),
    envFile: resolve(
      get('envFile')
        ?? process.env.OPENALICE_ENV_FILE
        ?? join(homedir(), '.config/openalice/openalice.env'),
    ),
    oldCredentialRevoked: revoked as CredentialAuditArgs['oldCredentialRevoked'],
    revocationReceiptPath,
    rotatedAt: get('rotatedAt') ?? new Date().toISOString(),
    output: get('output') ? resolve(get('output')!) : undefined,
    allowBlocked: parseBoolean(get('allowBlocked'), false),
    plistPaths: list('plist'),
    logPaths: list('logPath', ['logs']),
    apiPaths: list('apiPath', ['src/connectors/web', 'ui/src']),
    artifactPaths: list('artifactPath', ['runtime/control-plane']),
    fixturePaths: list('fixturePath', ['src/sidecar/fixtures']),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const repoRoot = resolve(process.cwd())
  const storage = await inspectCredentialEnvFile({
    path: args.envFile,
    credentialNames: args.credentialNames,
  })
  const revocationEvidenceRef = args.revocationReceiptPath
    ? await hashExternalEvidence(args.revocationReceiptPath)
    : null
  const plistPaths = args.plistPaths.length > 0
    ? args.plistPaths
    : await discoverOpenAlicePlists()
  const argvInput = await readProcessArguments()
  const gitInput = await readGitDiff(repoRoot)

  const argvScan = argvInput.ok
    ? scanSecretText({
      kind: 'argv',
      sourceLabel: 'process_table',
      text: argvInput.text,
      secretValues: storage.secretValues,
    })
    : buildSecretScanFailure('argv', 'process_table_unreadable')
  const gitScan = gitInput.ok
    ? scanSecretText({
      kind: 'git',
      sourceLabel: 'working_tree_diff',
      text: gitInput.text,
      secretValues: storage.secretValues,
    })
    : buildSecretScanFailure('git', 'git_diff_unreadable')
  const [plistScan, logScan, apiScan, artifactScan, fixtureScan] = await Promise.all([
    scanOptionalPaths('plist', plistPaths, storage.secretValues, repoRoot),
    scanOptionalPaths('log', args.logPaths, storage.secretValues, repoRoot),
    scanOptionalPaths('api', args.apiPaths, storage.secretValues, repoRoot),
    scanOptionalPaths('artifact', args.artifactPaths, storage.secretValues, repoRoot),
    scanOptionalPaths('fixture', args.fixturePaths, storage.secretValues, repoRoot),
  ])

  const scans = { argvScan, plistScan, logScan, apiScan, gitScan, artifactScan, fixtureScan }
  const receipt = buildCredentialRotationReceipt({
    credentialNames: args.credentialNames,
    rotatedAt: args.rotatedAt,
    newCredentialStored: storage.stored,
    oldCredentialRevoked: args.oldCredentialRevoked,
    argvScan: argvScan.status,
    plistScan: plistScan.status,
    logScan: logScan.status,
    apiScan: apiScan.status,
    gitScan: gitScan.status,
    artifactScan: artifactScan.status,
    fixtureScan: fixtureScan.status,
    evidenceRefs: [
      storage.evidenceRef,
      ...(revocationEvidenceRef ? [revocationEvidenceRef] : []),
      ...storage.reasonCodes.map((code) => `credential_store_reason:${code}`),
      ...Object.values(scans).map((scan) => scan.evidenceRef),
    ],
  })
  const output = args.output ?? resolve(
    'runtime/security/credential_rotation',
    `${args.rotatedAt.replaceAll(':', '-')}.${receipt.receiptId}.json`,
  )
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o444,
  })
  console.log(JSON.stringify({
    receipt,
    output,
    scans: Object.fromEntries(Object.entries(scans).map(([key, value]) => [key, {
      status: value.status,
      scannedSources: value.scannedSources,
      findingCount: value.findingCount,
      evidenceRef: value.evidenceRef,
    }])),
  }, null, 2))
  if (receipt.status !== 'pass' && !args.allowBlocked) process.exitCode = 1
}

async function hashExternalEvidence(path: string): Promise<string> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error('revocation_receipt_symlink_forbidden')
  if (!stat.isFile()) throw new Error('revocation_receipt_not_regular_file')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile()) throw new Error('revocation_receipt_not_regular_file')
    const hash = createHash('sha256').update(await handle.readFile()).digest('hex')
    return `credential_revocation:external_receipt:sha256:${hash}`
  } finally {
    await handle.close()
  }
}

async function scanOptionalPaths(
  kind: Parameters<typeof scanSecretPaths>[0]['kind'],
  paths: string[],
  secretValues: string[],
  repoRoot: string,
): Promise<SecretScanResultV1> {
  return scanSecretPaths({
    kind,
    paths,
    secretValues,
    repoRoot,
    allowExternalFiles: kind === 'plist',
  })
}

async function discoverOpenAlicePlists(): Promise<string[]> {
  const dir = join(homedir(), 'Library/LaunchAgents')
  try {
    return (await readdir(dir))
      .filter((name) => /openalice/i.test(name) && name.endsWith('.plist'))
      .map((name) => join(dir, name))
      .sort()
  } catch {
    return []
  }
}

type ReadInput = { ok: true; text: string } | { ok: false }

async function readProcessArguments(): Promise<ReadInput> {
  try {
    const result = await execFileAsync('/bin/ps', ['-axo', 'command='], {
      maxBuffer: 64 * 1024 * 1024,
    })
    return { ok: true, text: result.stdout }
  } catch {
    return { ok: false }
  }
}

async function readGitDiff(repoRoot: string): Promise<ReadInput> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--no-ext-diff', '--binary', 'HEAD'],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    )
    return { ok: true, text: stdout }
  } catch {
    return { ok: false }
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  throw new Error(`invalid boolean: ${value}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
