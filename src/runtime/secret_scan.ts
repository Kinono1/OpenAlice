import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

export type SecretScanKind =
  | 'argv'
  | 'plist'
  | 'log'
  | 'api'
  | 'git'
  | 'artifact'
  | 'fixture'

export interface SecretScanResultV1 {
  schemaVersion: 'secret_scan_result.v1'
  kind: SecretScanKind
  status: 'pass' | 'fail'
  scannedSources: number
  findingCount: number
  findingFingerprints: string[]
  evidenceRef: string
}

export interface CredentialStorageInspection {
  stored: boolean
  secretValues: string[]
  evidenceRef: string
  reasonCodes: string[]
}

interface ScanAccumulator {
  kind: SecretScanKind
  secretValues: string[]
  findings: Set<string>
  evidence: ReturnType<typeof createHash>
  scannedSources: number
}

const PRIVATE_KEY_MARKERS = [
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
] as const

const SENSITIVE_KEY_RE = /(?:api[_-]?key|secret|token|passphrase|password|private[_-]?key)/i
const ARG_CREDENTIAL_RE = /(?:^|\s)(--?(?:[a-z0-9]+[-_])*(?:api[-_]?key|secret|token|passphrase|password|private[-_]?key)|[A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSPHRASE|PASSWORD|PRIVATE_KEY))(?:=|\s+)([^\s]+)/gi
const BEARER_RE = /\bAuthorization\s*:\s*Bearer\s+([^\s"'<>]+)/gi
const PLIST_PAIR_RE = /<key>\s*([^<]+?)\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/gi
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi

export async function inspectCredentialEnvFile(options: {
  path: string
  credentialNames: string[]
}): Promise<CredentialStorageInspection> {
  const path = resolve(options.path)
  const names = [...new Set(options.credentialNames.map((value) => value.trim()))]
    .filter(Boolean)
    .sort()
  try {
    const pathStat = await lstat(path)
    const reasonCodes: string[] = []
    if (pathStat.isSymbolicLink()) {
      return unsafeCredentialStoreInspection(path, ['credential_store_symlink_forbidden'])
    }
    if (!pathStat.isFile()) {
      return unsafeCredentialStoreInspection(path, ['credential_store_not_regular_file'])
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) {
        return unsafeCredentialStoreInspection(path, ['credential_store_not_regular_file'])
      }
      if ((stat.mode & 0o077) !== 0) reasonCodes.push('credential_store_permissions_not_private')
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        reasonCodes.push('credential_store_wrong_owner')
      }
      bytes = await handle.readFile()
    } finally {
      await handle.close()
    }
    const parsed = parseEnvAssignments(bytes.toString('utf8'))
    const secretValues: string[] = []
    for (const name of names) {
      const value = parsed.get(name)
      if (!value || isPlaceholderValue(value)) {
        reasonCodes.push(`credential_missing_or_placeholder:${name}`)
        continue
      }
      secretValues.push(value)
    }
    return {
      stored: reasonCodes.length === 0 && secretValues.length === names.length,
      secretValues,
      evidenceRef: `credential_store:sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      reasonCodes: [...new Set(reasonCodes)].sort(),
    }
  } catch (error) {
    return {
      stored: false,
      secretValues: [],
      evidenceRef: `credential_store:missing:sha256:${sha256Text(path)}`,
      reasonCodes: [isEnoent(error) ? 'credential_store_missing' : 'credential_store_unreadable'],
    }
  }
}

export function scanSecretText(options: {
  kind: SecretScanKind
  text: string
  sourceLabel: string
  secretValues?: string[]
}): SecretScanResultV1 {
  const accumulator = createAccumulator(options.kind, options.secretValues ?? [])
  scanTextChunk(accumulator, options.text, options.sourceLabel)
  accumulator.evidence.update(options.sourceLabel)
  accumulator.evidence.update('\0')
  accumulator.evidence.update(options.text)
  accumulator.scannedSources = 1
  return finalizeAccumulator(accumulator)
}

export async function scanSecretPaths(options: {
  kind: SecretScanKind
  paths: string[]
  secretValues?: string[]
  repoRoot?: string
  exclude?: string[]
  allowExternalFiles?: boolean
}): Promise<SecretScanResultV1> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd())
  const accumulator = createAccumulator(options.kind, options.secretValues ?? [])
  const exclude = new Set((options.exclude ?? []).map((value) => value.replaceAll('\\', '/')))
  const files = new Map<string, string>()
  for (const rawPath of options.paths) {
    const path = resolve(repoRoot, rawPath)
    accumulator.evidence.update('requested_path\0')
    accumulator.evidence.update(sha256Text(path))
    try {
      if (isWithin(repoRoot, path)) {
        await collectFiles(repoRoot, path, files, exclude)
      } else {
        if (!options.allowExternalFiles) assertWithin(repoRoot, path)
        const stat = await lstat(path)
        if (stat.isSymbolicLink()) throw new Error('secret_scan_external_symlink_forbidden')
        if (!stat.isFile()) throw new Error('secret_scan_external_path_must_be_file')
        files.set(path, `external:${sha256Text(path)}`)
      }
    } catch (error) {
      addFinding(accumulator, rawPath, error instanceof Error ? error.message : String(error))
    }
  }
  for (const [path, label] of [...files.entries()].sort(([left], [right]) => (
    compareUnicodeCodePoints(left, right)
  ))) {
    await scanFile(accumulator, path, label)
  }
  return finalizeAccumulator(accumulator)
}

export function buildSecretScanFailure(
  kind: SecretScanKind,
  reasonCode: string,
): SecretScanResultV1 {
  const accumulator = createAccumulator(kind, [])
  addFinding(accumulator, 'scan_source', reasonCode)
  accumulator.evidence.update('scan_failure\0')
  accumulator.evidence.update(reasonCode)
  return finalizeAccumulator(accumulator)
}

function createAccumulator(kind: SecretScanKind, secretValues: string[]): ScanAccumulator {
  return {
    kind,
    secretValues: [...new Set(secretValues.filter((value) => value.length >= 8))],
    findings: new Set<string>(),
    evidence: createHash('sha256'),
    scannedSources: 0,
  }
}

async function scanFile(
  accumulator: ScanAccumulator,
  path: string,
  label: string,
): Promise<void> {
  const fileHash = createHash('sha256')
  let carry = ''
  try {
    const stream = createReadStream(path)
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      fileHash.update(bytes)
      const text = carry + bytes.toString('utf8')
      scanTextChunk(accumulator, text, label)
      carry = text.slice(-4096)
    }
    accumulator.evidence.update(label)
    accumulator.evidence.update('\0')
    accumulator.evidence.update(fileHash.digest('hex'))
    accumulator.scannedSources += 1
  } catch (error) {
    addFinding(accumulator, label, error instanceof Error ? error.message : String(error))
  }
}

function scanTextChunk(
  accumulator: ScanAccumulator,
  text: string,
  sourceLabel: string,
): void {
  for (const marker of PRIVATE_KEY_MARKERS) {
    if (text.includes(marker)) addFinding(accumulator, sourceLabel, 'private_key_material')
  }
  for (const secret of accumulator.secretValues) {
    if (text.includes(secret)) {
      addFinding(accumulator, sourceLabel, `known_secret:${sha256Text(secret)}`)
    }
  }
  if (accumulator.kind === 'argv') {
    scanCredentialAssignments(accumulator, text, sourceLabel)
  }
  if (accumulator.kind === 'plist') {
    scanPlist(accumulator, text, sourceLabel)
  }
  if (accumulator.kind === 'log' || accumulator.kind === 'api') {
    for (const match of text.matchAll(BEARER_RE)) {
      const value = normalizeCandidate(match[1] ?? '')
      if (!isPlaceholderValue(value)) {
        addFinding(accumulator, sourceLabel, `bearer_token:${sha256Text(value)}`)
      }
    }
  }
}

function scanCredentialAssignments(
  accumulator: ScanAccumulator,
  text: string,
  sourceLabel: string,
): void {
  for (const match of text.matchAll(ARG_CREDENTIAL_RE)) {
    const value = normalizeCandidate(match[2] ?? '')
    if (!isPlaceholderValue(value)) {
      addFinding(accumulator, sourceLabel, `credential_argument:${sha256Text(value)}`)
    }
  }
}

function scanPlist(
  accumulator: ScanAccumulator,
  text: string,
  sourceLabel: string,
): void {
  for (const match of text.matchAll(PLIST_PAIR_RE)) {
    const key = (match[1] ?? '').trim()
    const value = (match[2] ?? '').trim()
    const credentialNameReference = key.endsWith('_ENV') && /^[A-Z][A-Z0-9_]+$/.test(value)
    if (SENSITIVE_KEY_RE.test(key) && !credentialNameReference && !isPlaceholderValue(value)) {
      addFinding(accumulator, sourceLabel, `plist_credential:${sha256Text(key + '\0' + value)}`)
    }
  }
  for (const match of text.matchAll(URL_RE)) {
    try {
      const url = new URL(match[0])
      if (url.username || url.password) {
        addFinding(accumulator, sourceLabel, `credential_url:${sha256Text(url.origin)}`)
      }
    } catch {
      // Ignore malformed non-URL text. Structural plist checks still apply.
    }
  }
}

async function collectFiles(
  repoRoot: string,
  path: string,
  files: Map<string, string>,
  exclude: Set<string>,
): Promise<void> {
  assertWithin(repoRoot, path)
  const relativePath = relative(repoRoot, path).replaceAll('\\', '/')
  if (exclude.has(relativePath)) return
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error(`secret_scan_symlink_forbidden:${relativePath}`)
  if (stat.isFile()) {
    files.set(path, relativePath)
    return
  }
  if (!stat.isDirectory()) throw new Error(`secret_scan_type_unsupported:${relativePath}`)
  for (const name of await readdir(path)) {
    const childRelative = relativePath ? `${relativePath}/${name}` : name
    if (
      exclude.has(childRelative)
      || name === '.git'
      || name === 'node_modules'
      || name === '.pnpm-store'
    ) {
      continue
    }
    await collectFiles(repoRoot, resolve(path, name), files, exclude)
  }
}

function finalizeAccumulator(accumulator: ScanAccumulator): SecretScanResultV1 {
  const findingFingerprints = [...accumulator.findings].sort()
  const evidenceHash = accumulator.evidence.digest('hex')
  return {
    schemaVersion: 'secret_scan_result.v1',
    kind: accumulator.kind,
    status: findingFingerprints.length === 0 ? 'pass' : 'fail',
    scannedSources: accumulator.scannedSources,
    findingCount: findingFingerprints.length,
    findingFingerprints,
    evidenceRef: `secret_scan:${accumulator.kind}:sha256:${evidenceHash}`,
  }
}

function addFinding(accumulator: ScanAccumulator, source: string, category: string): void {
  accumulator.findings.add(sha256Text(`${accumulator.kind}\0${source}\0${category}`))
}

function parseEnvAssignments(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    let value = match[2] ?? ''
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    out.set(match[1], value)
  }
  return out
}

function normalizeCandidate(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function isPlaceholderValue(value: string): boolean {
  const normalized = normalizeCandidate(value)
  if (!normalized) return true
  if (/^\$\{?[A-Z][A-Z0-9_]*\}?$/.test(normalized)) return true
  if (/^[A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSPHRASE|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*$/.test(normalized)) {
    return true
  }
  return /(?:example|placeholder|redacted|dummy|fixture|fake|test-only|changeme|<[^>]+>)/i.test(normalized)
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function assertWithin(parent: string, child: string): void {
  if (isWithin(parent, child)) return
  throw new Error(`secret_scan_path_escape:${child}`)
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

function unsafeCredentialStoreInspection(
  path: string,
  reasonCodes: string[],
): CredentialStorageInspection {
  return {
    stored: false,
    secretValues: [],
    evidenceRef: `credential_store:unsafe:sha256:${sha256Text(path)}`,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index]
  }
  return leftPoints.length - rightPoints.length
}
