import { readdir, readFile } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

export const ADMISSION_AUTHORITY_FIELDS = [
  'paperTradingAllowed',
  'liveTradingAllowed',
  'liveExecutionArmed',
] as const

export interface AdmissionAuthorityViolation {
  path: string
  line: number
  column: number
  field: (typeof ADMISSION_AUTHORITY_FIELDS)[number]
  kind: 'property_assignment' | 'direct_assignment' | 'text_assignment'
  snippet: string
}

export interface AdmissionAuthorityAudit {
  schemaVersion: 'admission_authority_audit.v1'
  generatedAt: string
  repoRoot: string
  scannedFiles: number
  violations: AdmissionAuthorityViolation[]
  status: 'pass' | 'fail'
}

const SOURCE_DIRS = ['src', 'scripts', 'ops'] as const
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const TEXT_EXTENSIONS = new Set(['.py', '.json', '.yaml', '.yml'])
const ALLOWED_AUTHORITY_PATHS = new Set(['src/runtime/admission.ts'])

export async function auditAdmissionAuthority(
  repoRoot = process.cwd(),
): Promise<AdmissionAuthorityAudit> {
  const absoluteRoot = resolve(repoRoot)
  const files = (
    await Promise.all(SOURCE_DIRS.map((dir) => collectFiles(resolve(absoluteRoot, dir))))
  ).flat()
  const violations: AdmissionAuthorityViolation[] = []
  let scannedFiles = 0

  for (const absolutePath of files.sort()) {
    const repoPath = normalizeRepoPath(relative(absoluteRoot, absolutePath))
    if (isExcluded(repoPath)) continue
    const extension = extname(repoPath).toLowerCase()
    if (!SCRIPT_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) continue
    scannedFiles += 1
    const source = await readFile(absolutePath, 'utf-8')
    if (ALLOWED_AUTHORITY_PATHS.has(repoPath)) continue
    violations.push(
      ...(SCRIPT_EXTENSIONS.has(extension)
        ? scanJavaScriptAuthorityWrites(repoPath, source)
        : scanTextAuthorityWrites(repoPath, source)),
    )
  }

  return {
    schemaVersion: 'admission_authority_audit.v1',
    generatedAt: new Date().toISOString(),
    repoRoot: absoluteRoot,
    scannedFiles,
    violations: violations.sort(compareViolations),
    status: violations.length === 0 ? 'pass' : 'fail',
  }
}

export function scanJavaScriptAuthorityWrites(
  path: string,
  source: string,
): AdmissionAuthorityViolation[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path),
  )
  const violations: AdmissionAuthorityViolation[] = []

  const addViolation = (
    node: ts.Node,
    field: (typeof ADMISSION_AUTHORITY_FIELDS)[number],
    kind: AdmissionAuthorityViolation['kind'],
  ) => {
    const start = node.getStart(sourceFile)
    const location = sourceFile.getLineAndCharacterOfPosition(start)
    violations.push({
      path,
      line: location.line + 1,
      column: location.character + 1,
      field,
      kind,
      snippet: node.getText(sourceFile).slice(0, 240),
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      const field = authorityFieldFromPropertyName(node.name)
      if (field) addViolation(node, field, 'property_assignment')
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && node.right.kind === ts.SyntaxKind.TrueKeyword
    ) {
      const field = authorityFieldFromAssignmentTarget(node.left)
      if (field) addViolation(node, field, 'direct_assignment')
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

export function scanTextAuthorityWrites(
  path: string,
  source: string,
): AdmissionAuthorityViolation[] {
  const violations: AdmissionAuthorityViolation[] = []
  const fields = new Set<string>(ADMISSION_AUTHORITY_FIELDS)
  const lines = source.split(/\r?\n/)
  const patterns = [
    /["']?(paperTradingAllowed|liveTradingAllowed|liveExecutionArmed)["']?\s*:\s*(?:true|True)\b/g,
    /(?:\.|\[['"])(paperTradingAllowed|liveTradingAllowed|liveExecutionArmed)(?:['"]\])?\s*=\s*(?:true|True)\b/g,
  ]
  lines.forEach((line, lineIndex) => {
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of line.matchAll(pattern)) {
        const field = match[1]
        if (!field || !fields.has(field)) continue
        violations.push({
          path,
          line: lineIndex + 1,
          column: (match.index ?? 0) + 1,
          field: field as AdmissionAuthorityViolation['field'],
          kind: 'text_assignment',
          snippet: line.trim().slice(0, 240),
        })
      }
    }
  })
  return violations
}

async function collectFiles(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'generated', '__pycache__'].includes(entry.name)) continue
      files.push(...await collectFiles(path))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

function authorityFieldFromPropertyName(
  name: ts.PropertyName,
): (typeof ADMISSION_AUTHORITY_FIELDS)[number] | null {
  const value = ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : null
  return value && ADMISSION_AUTHORITY_FIELDS.includes(
    value as (typeof ADMISSION_AUTHORITY_FIELDS)[number],
  )
    ? value as (typeof ADMISSION_AUTHORITY_FIELDS)[number]
    : null
}

function authorityFieldFromAssignmentTarget(
  target: ts.Expression,
): (typeof ADMISSION_AUTHORITY_FIELDS)[number] | null {
  if (ts.isPropertyAccessExpression(target)) {
    return authorityFieldFromPropertyName(target.name)
  }
  if (ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression)) {
    return authorityFieldFromPropertyName(target.argumentExpression)
  }
  return null
}

function isExcluded(path: string): boolean {
  const lower = path.toLowerCase()
  return (
    /(?:^|\/)(?:fixtures?|__fixtures__)(?:\/|$)/.test(lower)
    || /\.(?:spec|test)\.[^.]+$/.test(lower)
    || lower.endsWith('.d.ts')
  )
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function normalizeRepoPath(path: string): string {
  return path.split(sep).join('/')
}

function compareViolations(
  left: AdmissionAuthorityViolation,
  right: AdmissionAuthorityViolation,
): number {
  return left.path.localeCompare(right.path)
    || left.line - right.line
    || left.column - right.column
}

function parseRoot(argv: string[]): string {
  if (argv.length === 0) return process.cwd()
  if (argv.length === 2 && argv[0] === '--root' && argv[1]) return argv[1]
  throw new Error('usage: audit_admission_authority [--root <repo-root>]')
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const audit = await auditAdmissionAuthority(parseRoot(argv))
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`)
  if (audit.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
