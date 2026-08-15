#!/usr/bin/env tsx
/**
 * C1: Triple-Barrier 调用点盘点 — 只读, 流式
 *
 * 扫描代码库 + 持久化数据, 确认现有 triple-barrier 标签是否已经存在。
 * 输出: data/runtime/triple_barrier_callsite_audit.latest.json
 */

import { readFileSync, readdirSync, statSync, existsSync, createReadStream } from 'node:fs'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { writeFile, mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

const ROOT = process.cwd()
const MAX_FILE_SIZE = 100 * 1024 * 1024  // 100MB

interface CallsiteEntry {
  file: string
  line: number
  pattern: string
  context: string
}

interface PersistedLabelLocation {
  path: string
  count: number
}

interface AuditReport {
  schemaVersion: 1
  generatedAt: string
  productionCallsites: CallsiteEntry[]
  testCallsites: CallsiteEntry[]
  persistedLabels: {
    byLocation: Record<string, number>
    totalLabeledRecords: number
    byLane: Record<string, number>
    filesScanned: number
    filesSkippedTooLarge: string[]
  }
  verdict: 'no_pollution_yet' | 'labels_present_but_unwired' | 'labels_used_in_production'
  notes: string[]
}

// 关键字: evaluateTripleBarrierLabel, tripleBarrierLabel, recordExit, TripleBarrierLabel
const KEYWORDS = [
  'evaluateTripleBarrierLabel',
  'tripleBarrierLabel',
  'TripleBarrierLabel',
  'recordExit',
]

function isLikelyProduction(filePath: string): boolean {
  const parts = filePath.split('/')
  return parts.some(p => p === '__test__' || p.endsWith('.spec.'))
    ? filePath.includes('spec') || filePath.includes('__test__')
    : false
}

function isSpecFile(filePath: string): boolean {
  return filePath.includes('.spec.') || filePath.includes('.test.') || filePath.includes('__test__')
}

function isTestOnly(relative: string): boolean {
  return relative.startsWith('src') && (relative.includes('.spec.') || relative.includes('__test__'))
}

function* walkFiles(dir: string, extensions?: RegExp): Generator<string> {
  const extFilter = extensions ?? /\.(ts|js|py)$/
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!['node_modules', '.git', 'dist', '.pytest_cache', '__pycache__', 'coverage'].includes(e.name)) {
          yield* walkFiles(full, extFilter)
        }
      } else if (e.isFile() && extFilter.test(e.name)) {
        yield full
      }
    }
  } catch { /* 跳过没有权限的目录 */ }
}

function scanSourceFiles(): { production: CallsiteEntry[], test: CallsiteEntry[] } {
  const production: CallsiteEntry[] = []
  const test: CallsiteEntry[] = []

  for (const file of walkFiles(join(ROOT, 'src'))) {
    try {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        for (const kw of KEYWORDS) {
          if (lines[i].includes(kw) && !lines[i].trim().startsWith('//') && !lines[i].trim().startsWith('*')) {
            const rel = relative(ROOT, file)
            const entry: CallsiteEntry = {
              file: rel,
              line: i + 1,
              pattern: kw,
              context: lines[i].trim().substring(0, 120),
            }
            if (isTestOnly(rel)) {
              test.push(entry)
            } else {
              production.push(entry)
            }
          }
        }
      }
    } catch { /* 跳过不可读文件 */ }
  }

  // 同样扫 scripts/
  for (const file of walkFiles(join(ROOT, 'scripts'))) {
    try {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        for (const kw of KEYWORDS) {
          if (lines[i].includes(kw) && !lines[i].trim().startsWith('//') && !lines[i].trim().startsWith('*')) {
            const rel = relative(ROOT, file)
            const entry: CallsiteEntry = {
              file: rel,
              line: i + 1,
              pattern: kw,
              context: lines[i].trim().substring(0, 120),
            }
            if (isSpecFile(rel)) {
              test.push(entry)
            } else {
              production.push(entry)
            }
          }
        }
      }
    } catch { /* */ }
  }

  return { production, test }
}

async function scanPersistedLabels(): Promise<{
  byLocation: Record<string, number>
  totalLabeledRecords: number
  byLane: Record<string, number>
  filesScanned: number
  filesSkippedTooLarge: string[]
}> {
  const byLocation: Record<string, number> = {}
  const byLane: Record<string, number> = {}
  let totalLabeledRecords = 0
  let filesScanned = 0
  const filesSkippedTooLarge: string[] = []

  // 扫 data/paper_trading/ data/research/ data/validation/ data/runtime/
  const dataDirs = [
    join(ROOT, 'data', 'paper_trading'),
    join(ROOT, 'data', 'research'),
    join(ROOT, 'data', 'validation'),
    join(ROOT, 'data', 'runtime'),
  ].filter(dir => existsSync(dir))

  for (const dir of dataDirs) {
    for (const file of walkFiles(dir, /\.(json|jsonl)$/)) {
      const s = statSync(file)
      if (s.size > MAX_FILE_SIZE) {
        filesSkippedTooLarge.push(relative(ROOT, file))
        continue
      }
      if (s.size === 0) continue
      filesScanned++

      // 流式读取 JSONL
      if (file.endsWith('.jsonl')) {
        const rl = createInterface({ input: createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity })
        let localCount = 0
        for await (const line of rl) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line)
            if (obj.tripleBarrierLabel !== undefined || obj.triple_barrier_label !== undefined) {
              localCount++
              const lane = obj.lane || 'unknown'
              byLane[lane] = (byLane[lane] || 0) + 1
            }
          } catch { /* 跳过损坏行 */ }
        }
        if (localCount > 0) {
          byLocation[relative(ROOT, file)] = localCount
          totalLabeledRecords += localCount
        }
      } else {
        // JSON 文件 — 尝试解析并找 tripleBarrierLabel
        try {
          const content = readFileSync(file, 'utf-8')
          const obj = JSON.parse(content)
          const count = countTripleBarrierLabelsDeep(obj)
          if (count > 0) {
            byLocation[relative(ROOT, file)] = count
            totalLabeledRecords += count
          }
        } catch { /* 跳过 */ }
      }
    }
  }

  return { byLocation, totalLabeledRecords, byLane, filesScanned, filesSkippedTooLarge }
}

function countTripleBarrierLabelsDeep(obj: unknown, depth = 0): number {
  if (depth > 10 || obj === null || obj === undefined) return 0
  if (typeof obj !== 'object') return 0
  let count = 0
  if (Array.isArray(obj)) {
    for (const item of obj) {
      count += countTripleBarrierLabelsDeep(item, depth + 1)
    }
  } else {
    const record = obj as Record<string, unknown>
    if (record.tripleBarrierLabel !== undefined || record.triple_barrier_label !== undefined) {
      count++
    }
    for (const val of Object.values(record)) {
      count += countTripleBarrierLabelsDeep(val, depth + 1)
    }
  }
  return count
}

async function main() {
  const generatedAt = new Date().toISOString()
  console.log('C1: triple-barrier 调用点盘点...\n')

  // 1) 静态扫描
  const { production, test } = scanSourceFiles()
  console.log(`  代码扫描: ${production.length} 个生产调用点, ${test.length} 个测试调用点`)

  for (const site of production) {
    console.log(`    ${site.file}:${site.line} — ${site.pattern}`)
  }

  // 2) 持久化数据扫描
  const persisted = await scanPersistedLabels()
  console.log(`  数据扫描: ${persisted.filesScanned} 个文件, ${persisted.totalLabeledRecords} 个持久化标签`)
  if (persisted.filesSkippedTooLarge.length > 0) {
    console.log(`  跳过 (过大): ${persisted.filesSkippedTooLarge.join(', ')}`)
  }

  // 3) verdict
  const inProdCallsites = production.filter(s => s.file.startsWith('src') && !s.file.includes('spec'))
  const hasProdConsumer = inProdCallsites.length > 0

  let verdict: AuditReport['verdict']
  const notes: string[] = []

  if (persisted.totalLabeledRecords > 0 && hasProdConsumer) {
    verdict = 'labels_used_in_production'
    notes.push(`发现 ${persisted.totalLabeledRecords} 个持久化标签, 且有 ${inProdCallsites.length} 个生产调用点`)
  } else if (persisted.totalLabeledRecords > 0) {
    verdict = 'labels_present_but_unwired'
    notes.push(`发现 ${persisted.totalLabeledRecords} 个持久化标签, 但无生产调用点 (可能来自回测/研究)`)
  } else {
    verdict = 'no_pollution_yet'
    notes.push('未发现持久化 triple-barrier 标签')
  }
  if (!hasProdConsumer && !persisted.totalLabeledRecords) {
    notes.push('三重屏障当前仅用于测试/研究路径, 不影响训练数据')
  }

  const report: AuditReport = {
    schemaVersion: 1,
    generatedAt,
    productionCallsites: production,
    testCallsites: test,
    persistedLabels: {
      byLocation: persisted.byLocation,
      totalLabeledRecords: persisted.totalLabeledRecords,
      byLane: persisted.byLane,
      filesScanned: persisted.filesScanned,
      filesSkippedTooLarge: persisted.filesSkippedTooLarge,
    },
    verdict,
    notes,
  }

  const outDir = join(ROOT, 'data', 'runtime')
  const outPath = join(outDir, 'triple_barrier_callsite_audit.latest.json')
  await mkdir(outDir, { recursive: true })
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8')

  // 写入 evidence manifest
  const startedAt = new Date(Date.parse(generatedAt))
  await writeEvidenceManifestForArtifact({
    job: 'triple_barrier_callsite_audit',
    artifactPath: outPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: 0,
    businessStatus: 'pass',
    recordsIn: production.length,
    recordsOut: 1,
    errorClass: null,
  })

  console.log(`\n输出: ${outPath}`)
  console.log(`Verdict: ${verdict}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => { console.error('失败:', err); process.exit(1) })
}
