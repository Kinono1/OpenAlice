import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  dataLineageGraphFromJson,
  validateDataLineageGraph,
} from '../src/data/data_lineage.js'

export interface ValidateEvidenceTrustArgs {
  json: boolean
  manifestInputs: string[]
  requireLineageGraph: boolean
}

export interface EvidenceTrustManifestResult {
  path: string
  job: string | null
  evidenceTrust: string | null
  dqStatus: string | null
  businessStatus: string | null
  errorClass: string | null
  reason: string | null
}

export interface EvidenceTrustValidationReport {
  schemaVersion: 'evidence_trust_validation.v1'
  generatedAt: string
  passed: boolean
  checkedCount: number
  missingInputs: string[]
  missingEvidence: string[]
  blockingManifests: EvidenceTrustManifestResult[]
  blockingLineageGraphs: EvidenceTrustLineageResult[]
  manifests: EvidenceTrustManifestResult[]
  lineageGraphs: EvidenceTrustLineageResult[]
}

export interface EvidenceTrustLineageResult {
  path: string
  schemaVersion: string | null
  hash: string | null
  passed: boolean
  blockingReasons: string[]
  errorClass: string | null
}

type UnknownRecord = Record<string, unknown>

export function parseValidateEvidenceTrustArgs(argv: string[]): ValidateEvidenceTrustArgs {
  const raw = parseRawArgs(argv)
  const json = parseBool(raw.options.get('json'), false)
  return {
    json,
    requireLineageGraph: parseBool(raw.options.get('requireLineageGraph'), true),
    manifestInputs: raw.positionals,
  }
}

export async function buildEvidenceTrustValidationReport(
  manifestInputs: string[],
  opts: { cwd?: string; generatedAt?: string; requireLineageGraph?: boolean } = {},
): Promise<EvidenceTrustValidationReport> {
  const cwd = opts.cwd ?? process.cwd()
  const resolved = await resolveManifestInputs(manifestInputs, cwd)
  const manifests: EvidenceTrustManifestResult[] = []
  const lineageGraphs: EvidenceTrustLineageResult[] = []

  for (const path of resolved.paths) {
    if (isDataLineageFile(path)) {
      lineageGraphs.push(await readLineageTrust(path))
    } else {
      manifests.push(await readManifestTrust(path))
    }
  }

  const blockingManifests = manifests.filter((manifest) => manifest.reason !== null)
  const blockingLineageGraphs = lineageGraphs.filter((lineage) => !lineage.passed)
  const missingEvidence =
    opts.requireLineageGraph === false || lineageGraphs.length > 0
      ? []
      : ['DATA_LINEAGE_GRAPH_MISSING']
  return {
    schemaVersion: 'evidence_trust_validation.v1',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    passed: resolved.missingInputs.length === 0 &&
      missingEvidence.length === 0 &&
      blockingManifests.length === 0 &&
      blockingLineageGraphs.length === 0,
    checkedCount: manifests.length + lineageGraphs.length,
    missingInputs: resolved.missingInputs,
    missingEvidence,
    blockingManifests,
    blockingLineageGraphs,
    manifests,
    lineageGraphs,
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseValidateEvidenceTrustArgs(argv)
  if (args.manifestInputs.length === 0) {
    throw new Error('At least one evidence manifest path or glob is required.')
  }

  const report = await buildEvidenceTrustValidationReport(args.manifestInputs, {
    requireLineageGraph: args.requireLineageGraph,
  })
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderEvidenceTrustValidationReport(report))
  }
  if (!report.passed) {
    process.exitCode = 2
  }
}

export function renderEvidenceTrustValidationReport(report: EvidenceTrustValidationReport): string {
  const lines: string[] = []
  lines.push('# Evidence Trust Validation')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Passed: ${report.passed}`)
  lines.push(`Checked inputs: ${report.checkedCount}`)
  lines.push(`Missing inputs: ${report.missingInputs.length}`)
  lines.push(`Missing evidence: ${report.missingEvidence.length}`)
  lines.push(`Blocking manifests: ${report.blockingManifests.length}`)
  lines.push(`Blocking lineage graphs: ${report.blockingLineageGraphs.length}`)
  lines.push('')
  if (report.missingInputs.length > 0) {
    lines.push('## Missing Inputs')
    lines.push('')
    for (const input of report.missingInputs) lines.push(`- \`${input}\``)
    lines.push('')
  }
  if (report.blockingManifests.length > 0) {
    lines.push('## Blocking Manifests')
    lines.push('')
    lines.push('| path | job | evidenceTrust | dqStatus | businessStatus | reason |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const manifest of report.blockingManifests) {
      lines.push(
        `| \`${escapePipe(manifest.path)}\` | ${escapePipe(manifest.job ?? '')} | ` +
        `${escapePipe(manifest.evidenceTrust ?? '')} | ${escapePipe(manifest.dqStatus ?? '')} | ` +
        `${escapePipe(manifest.businessStatus ?? '')} | ${escapePipe(manifest.reason ?? '')} |`,
      )
    }
    lines.push('')
  }
  if (report.missingEvidence.length > 0) {
    lines.push('## Missing Evidence')
    lines.push('')
    for (const evidence of report.missingEvidence) lines.push(`- \`${evidence}\``)
    lines.push('')
  }
  if (report.blockingLineageGraphs.length > 0) {
    lines.push('## Blocking Lineage Graphs')
    lines.push('')
    lines.push('| path | schemaVersion | hash | reasons |')
    lines.push('| --- | --- | --- | --- |')
    for (const lineage of report.blockingLineageGraphs) {
      lines.push(
        `| \`${escapePipe(lineage.path)}\` | ${escapePipe(lineage.schemaVersion ?? '')} | ` +
        `${escapePipe(lineage.hash ?? '')} | ${escapePipe(lineage.blockingReasons.join(', '))} |`,
      )
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

async function resolveManifestInputs(
  inputs: string[],
  cwd: string,
): Promise<{ paths: string[]; missingInputs: string[] }> {
  const paths = new Set<string>()
  const missingInputs: string[] = []
  for (const input of inputs) {
    const expanded = hasGlob(input)
      ? await expandGlobInput(input, cwd)
      : await resolveLiteralInput(input, cwd)
    if (expanded.length === 0) {
      missingInputs.push(input)
      continue
    }
    for (const path of expanded) paths.add(path)
  }
  return { paths: [...paths].sort(), missingInputs }
}

async function resolveLiteralInput(input: string, cwd: string): Promise<string[]> {
  const path = resolve(cwd, input)
  try {
    const info = await stat(path)
    if (info.isFile()) return [path]
    if (info.isDirectory()) return listManifestFiles(path)
  } catch {
    return []
  }
  return []
}

async function expandGlobInput(input: string, cwd: string): Promise<string[]> {
  const normalized = input.replaceAll('\\', '/')
  const firstWildcard = findFirstWildcardIndex(normalized)
  const slashBeforeWildcard = normalized.slice(0, firstWildcard).lastIndexOf('/')
  const basePattern = slashBeforeWildcard >= 0 ? normalized.slice(0, slashBeforeWildcard) : '.'
  const baseDir = resolve(cwd, basePattern || '.')
  const matcher = globToRegExp(resolve(cwd, normalized).replaceAll('\\', '/'))
  const candidates = await listManifestFiles(baseDir)
  return candidates
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => matcher.test(path))
}

async function listManifestFiles(root: string): Promise<string[]> {
  const out: string[] = []
  try {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) {
        out.push(...await listManifestFiles(path))
      } else if (entry.isFile() && isEvidenceTrustInputFile(entry.name)) {
        out.push(resolve(path))
      }
    }
  } catch {
    return []
  }
  return out
}

function isEvidenceTrustInputFile(name: string): boolean {
  return name.endsWith('.manifest.json') || name === 'data_lineage.latest.json'
}

function isDataLineageFile(path: string): boolean {
  return path.replaceAll('\\', '/').endsWith('/data_lineage.latest.json') ||
    path.endsWith('data_lineage.latest.json')
}

async function readManifestTrust(path: string): Promise<EvidenceTrustManifestResult> {
  try {
    const manifest = asRecord(JSON.parse(await readFile(path, 'utf-8')))
    const evidenceTrust = readString(manifest.evidenceTrust)
    const dqStatus = readString(manifest.dqStatus)
    const reason = evidenceTrust === 'pass'
      ? dqStatus && dqStatus !== 'pass'
        ? `dq_status_not_pass:${dqStatus}`
        : null
      : evidenceTrust
        ? `evidence_trust_not_pass:${evidenceTrust}`
        : 'evidence_trust_missing'
    return {
      path,
      job: readString(manifest.job),
      evidenceTrust,
      dqStatus,
      businessStatus: readString(manifest.businessStatus),
      errorClass: readString(manifest.errorClass),
      reason,
    }
  } catch (error) {
    return {
      path,
      job: null,
      evidenceTrust: null,
      dqStatus: null,
      businessStatus: null,
      errorClass: error instanceof Error ? error.message : String(error),
      reason: 'manifest_unreadable_or_invalid_json',
    }
  }
}

async function readLineageTrust(path: string): Promise<EvidenceTrustLineageResult> {
  try {
    const graph = dataLineageGraphFromJson(JSON.parse(await readFile(path, 'utf-8')) as unknown)
    const validation = validateDataLineageGraph(graph)
    return {
      path,
      schemaVersion: graph.schemaVersion,
      hash: validation.hash,
      passed: validation.passed,
      blockingReasons: validation.blockingReasons.map((reason) => reason.code),
      errorClass: null,
    }
  } catch (error) {
    return {
      path,
      schemaVersion: null,
      hash: null,
      passed: false,
      blockingReasons: ['data_lineage_unreadable_or_invalid_json'],
      errorClass: error instanceof Error ? error.message : String(error),
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    const next = pattern[index + 1]
    const afterNext = pattern[index + 2]
    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?'
      index += 2
    } else if (char === '*' && next === '*') {
      source += '.*'
      index += 1
    } else if (char === '*') {
      source += '[^/]*'
    } else {
      source += escapeRegExp(char)
    }
  }
  source += '$'
  return new RegExp(source)
}

function findFirstWildcardIndex(input: string): number {
  const index = input.indexOf('*')
  return index >= 0 ? index : input.length
}

function hasGlob(input: string): boolean {
  return input.includes('*')
}

function parseRawArgs(argv: string[]): { options: Map<string, string>; positionals: string[] } {
  const options = new Map<string, string>()
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const withoutPrefix = arg.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      options.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    if (withoutPrefix === 'json') {
      options.set(withoutPrefix, 'true')
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      options.set(withoutPrefix, next)
      index += 1
    } else {
      options.set(withoutPrefix, 'true')
    }
  }
  return { options, positionals }
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')
}

function escapePipe(value: string): string {
  return value.replaceAll('|', '\\|')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
