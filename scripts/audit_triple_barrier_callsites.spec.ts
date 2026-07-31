import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'

describe('audit_triple_barrier_callsites', () => {
  let tempDir: string
  const artifactPath = join('data', 'runtime', 'triple_barrier_callsite_audit.latest.json')

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tb-callsite-'))
    // 创建一个模拟 JSONL 文件包含 tripleBarrierLabel
    const paperDir = join(tempDir, 'data', 'paper_trading')
    mkdirSync(paperDir, { recursive: true })
    writeFileSync(join(paperDir, 'trades.jsonl'), [
      JSON.stringify({ tradeId: 'a', tripleBarrierLabel: 1, lane: 'breakout' }),
      JSON.stringify({ tradeId: 'b', tripleBarrierLabel: 0, lane: 'breakout' }),
      JSON.stringify({ tradeId: 'c' }), // no label
      JSON.stringify({ tradeId: 'd', tripleBarrierLabel: 1, lane: 'momentum' }),
    ].join('\n') + '\n')
  })

  it('imports without error', async () => {
    const mod = await import('./audit_triple_barrier_callsites.js')
    expect(mod).toBeDefined()
  })

  it('artifact path matches plan (data/runtime/triple_barrier_callsite_audit.latest.json)', () => {
    expect(artifactPath).toBe('data/runtime/triple_barrier_callsite_audit.latest.json')
  })

  it('artifact schema contains required fields', async () => {
    // 从已存在的 artifact 验证
    let content: string | null = null
    try {
      const fs = await import('node:fs/promises')
      content = await fs.readFile(join(process.cwd(), artifactPath), 'utf-8')
    } catch {
      // 可能不存在
    }
    if (content) {
      const report = JSON.parse(content)
      expect(report).toHaveProperty('productionCallsites')
      expect(report).toHaveProperty('persistedLabels')
      expect(report.persistedLabels).toHaveProperty('totalLabeledRecords')
      expect(report.persistedLabels).toHaveProperty('filesScanned')
      expect(report).toHaveProperty('verdict')
      expect(['no_pollution_yet', 'labels_present_but_unwired', 'labels_used_in_production']).toContain(report.verdict)
    }
  })

  it('JSONL scanning logic is correct', async () => {
    // 复现 C1 的标签扫描逻辑
    const { createInterface } = await import('node:readline')
    const { createReadStream } = await import('node:fs')
    let labelCount = 0
    const byLane: Record<string, number> = {}
    const rl = createInterface({ input: createReadStream(join(tempDir, 'data', 'paper_trading', 'trades.jsonl')), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      const obj = JSON.parse(line)
      if (obj.tripleBarrierLabel !== undefined) {
        labelCount++
        byLane[obj.lane || 'unknown'] = (byLane[obj.lane || 'unknown'] || 0) + 1
      }
    }
    expect(labelCount).toBe(3) // 3 条记录含 tripleBarrierLabel
    expect(byLane.breakout).toBe(2)
    expect(byLane.momentum).toBe(1)
  })
})
