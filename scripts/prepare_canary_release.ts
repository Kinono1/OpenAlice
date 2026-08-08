#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readlink, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { verifyReleaseDirectory } from '../src/runtime/release_manager.js'

const COMMIT_RE = /^[a-f0-9]{40}$/
const execFileAsync = promisify(execFile)

interface Args {
  sourceReleaseRoot: string
  releaseId: string
  canaryReleaseDir: string
  receipt: string
  legacyWipRoot?: string
  freezeReceiptPath?: string
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!COMMIT_RE.test(args.releaseId)) throw new Error('invalid_release_id')
  const legacyWipVerification = await verifyFrozenLegacyWip(args)
  const sourceRoot = await realpath(resolve(args.sourceReleaseRoot))
  const manifest = await verifyReleaseDirectory(sourceRoot, args.releaseId)
  assertFullClosure(manifest.artifactHashes)
  const canaryRoot = resolve(args.canaryReleaseDir)
  await mkdir(canaryRoot, { recursive: true })
  const pointer = join(canaryRoot, 'current')
  const sourcePath = resolve(sourceRoot, args.releaseId)
  const existing = await readPointer(pointer)
  if (existing !== null && existing !== sourcePath) {
    throw new Error(`canary_current_pointer_conflict:${existing}`)
  }
  if (existing === null) {
    const temporary = join(canaryRoot, `.current.${randomUUID()}.tmp`)
    await symlink(sourcePath, temporary, 'dir')
    await rename(temporary, pointer)
  }
  const receipt = {
    schemaVersion: 'canary_release_preparation_receipt.v1',
    status: 'pass',
    releaseId: args.releaseId,
    sourceReleaseRoot: sourceRoot,
    canaryReleaseDir: canaryRoot,
    pointer: 'current',
    manifestHash: manifest.manifestHash,
    preparedAt: new Date().toISOString(),
    telegramEnabled: false,
    cronOwner: false,
    sharedWrites: false,
    executionAllowed: false,
    legacyWipVerification,
  }
  const receiptPath = resolve(args.receipt)
  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(receipt, null, 2))
}

async function readPointer(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path)
    if (!stat.isSymbolicLink()) throw new Error('canary_current_not_symlink')
    return await realpath(resolve(path, '..', await readlink(path)))
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function assertFullClosure(hashes: Record<string, string>): void {
  for (const prefix of ['dist/', 'scripts/', 'src/', 'ops/', 'default/', 'package.json', 'pnpm-lock.yaml', 'release-metadata/']) {
    if (!Object.keys(hashes).some((path) => path === prefix || path.startsWith(prefix))) {
      throw new Error(`canary_release_closure_missing:${prefix}`)
    }
  }
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing_value:${token}`)
    values.set(token.slice(2), value)
    index += 1
  }
  const required = (key: keyof Args): string => {
    const value = values.get(key)
    if (!value) throw new Error(`missing --${key}`)
    return value
  }
  return {
    sourceReleaseRoot: required('sourceReleaseRoot'),
    releaseId: required('releaseId'),
    canaryReleaseDir: required('canaryReleaseDir'),
    receipt: required('receipt'),
    legacyWipRoot: values.get('legacyRepoRoot')
      ? resolve(values.get('legacyRepoRoot')!)
      : process.env.OPENALICE_LEGACY_WIP_ROOT
        ? resolve(process.env.OPENALICE_LEGACY_WIP_ROOT)
        : undefined,
    freezeReceiptPath: values.get('freezeReceipt')
      ? resolve(values.get('freezeReceipt')!)
      : process.env.OPENALICE_LEGACY_WIP_FREEZE_RECEIPT
        ? resolve(process.env.OPENALICE_LEGACY_WIP_FREEZE_RECEIPT)
        : undefined,
  }
}

async function verifyFrozenLegacyWip(args: Args): Promise<Record<string, unknown> | null> {
  if (!args.legacyWipRoot && !args.freezeReceiptPath) return null
  if (!args.legacyWipRoot || !args.freezeReceiptPath) {
    throw new Error('legacy_wip_freeze_inputs_required')
  }
  const { stdout } = await execFileAsync('python3', [
    resolve('scripts/verify_wip_freeze.py'),
    '--repo-root',
    resolve(args.legacyWipRoot),
    '--receipt',
    resolve(args.freezeReceiptPath),
  ], { cwd: resolve('.'), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  let verification: Record<string, unknown>
  try {
    verification = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new Error('legacy_wip_freeze_verification_invalid')
  }
  if (verification.status !== 'pass' || verification.driftDetected === true) {
    throw new Error('legacy_wip_drift_detected')
  }
  return verification
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
