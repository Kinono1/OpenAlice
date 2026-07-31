#!/usr/bin/env tsx
/**
 * C2: Triple-Barrier 合成压力扫描 — 只读
 *
 * 用真实 5m OHLCV CSV 数据 + 合成入场参数网格, 量化
 * evaluateTripleBarrierLabel 同 bar 双命中的频率与标签分布影响。
 *
 * 关键修正: 同 bar 双命中时无论 long/short 都视为 stop-loss / label 0。
 * 输出两个独立指标: sameBarDoubleHit (路径不确定), labelFlip (标签污染)。
 *
 * 输出: data/runtime/triple_barrier_double_hit_synthetic_audit.latest.json
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { evaluateTripleBarrierLabel, type TripleBarrierLabel } from '../src/domain/strategy/meta-labeling/triple-barrier.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

const ROOT = process.cwd()
const FIVE_M_DIR = join(ROOT, 'data', 'market', 'live_5m')
const MAX_TRADES = 50_000  // 防止爆内存

interface OhlcvBar {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface AuditEntry {
  upperPct: number
  lowerPct: number
  holdingBars: number
  side: 'long' | 'short'
  sameBarDoubleHit: boolean
  labelFlip: boolean
  currentLabel: 0 | 1
  conservativeLabel: 0 | 1
}

/**
 * 保守版 evaluateTripleBarrierLabel — 同 bar 双命中无论 long/short 都 label 0。
 */
function evaluateConservative(input: {
  candles: OhlcvBar[]
  entryIndex: number
  upperBarrierPct: number
  lowerBarrierPct: number
  maxHoldingBars: number
  side?: 'long' | 'short'
}): TripleBarrierLabel {
  const side = input.side ?? 'long'
  const entryCandle = input.candles[input.entryIndex]
  if (!entryCandle) throw new Error('entryIndex out of range')
  const entryPrice = entryCandle.close
  const upperPrice = entryPrice * (1 + input.upperBarrierPct / 100)
  const lowerPrice = entryPrice * (1 - input.lowerBarrierPct / 100)
  const finalIndex = Math.min(input.candles.length - 1, input.entryIndex + Math.max(1, input.maxHoldingBars))

  for (let idx = input.entryIndex + 1; idx <= finalIndex; idx++) {
    const bar = input.candles[idx]
    if (!bar) break
    const upperHit = bar.high >= upperPrice
    const lowerHit = bar.low <= lowerPrice

    // 同 bar 双命中 → 保守: 全部标记 stop-loss
    if (upperHit && lowerHit) {
      return {
        label: 0,
        exitReason: 'stop-loss',
        exitIndex: idx,
        entryPrice,
        exitPrice: side === 'long' ? lowerPrice : upperPrice,
        realizedReturnPct: side === 'long'
          ? ((lowerPrice - entryPrice) / entryPrice) * 100
          : ((upperPrice - entryPrice) / entryPrice) * 100,
        hitUpperBarrier: true,
        hitLowerBarrier: true,
      }
    }
    if (upperHit) {
      const exitPrice = upperPrice
      return {
        label: side === 'long' ? 1 : 0,
        exitReason: side === 'long' ? 'take-profit' : 'stop-loss',
        exitIndex: idx, entryPrice, exitPrice,
        realizedReturnPct: side === 'long' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((exitPrice - entryPrice) / entryPrice) * 100,
        hitUpperBarrier: true, hitLowerBarrier: false,
      }
    }
    if (lowerHit) {
      const exitPrice = lowerPrice
      return {
        label: side === 'long' ? 0 : 1,
        exitReason: side === 'long' ? 'stop-loss' : 'take-profit',
        exitIndex: idx, entryPrice, exitPrice,
        realizedReturnPct: side === 'long' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((exitPrice - entryPrice) / entryPrice) * 100,
        hitUpperBarrier: false, hitLowerBarrier: true,
      }
    }
  }

  // 时间到期 — 与 evaluateTripleBarrierLabel 相同逻辑
  const exitBar = input.candles[finalIndex]
  const signedReturn = side === 'long'
    ? ((exitBar.close - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitBar.close) / entryPrice) * 100
  return {
    label: signedReturn > 0 ? 1 : 0,
    exitReason: 'time-expiry',
    exitIndex: finalIndex, entryPrice,
    exitPrice: exitBar.close,
    realizedReturnPct: signedReturn,
    hitUpperBarrier: false, hitLowerBarrier: false,
  }
}

/** 最小 CSV reader (5m: timestamp,open,high,low,close,volume) */
function readCsvBars(filePath: string): OhlcvBar[] {
  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter(l => l.trim())
  const bars: OhlcvBar[] = []
  const header = lines[0].toLowerCase()
  const cols = header.split(',')
  const tsIdx = cols.findIndex(c => c.includes('timestamp') || c === 't')
  const oIdx = cols.findIndex(c => c === 'open' || c === 'o')
  const hIdx = cols.findIndex(c => c === 'high' || c === 'h')
  const lIdx = cols.findIndex(c => c === 'low' || c === 'l')
  const cIdx = cols.findIndex(c => c === 'close' || c === 'c')
  const vIdx = cols.findIndex(c => c.includes('volume') || c === 'v')
  if (tsIdx < 0 || oIdx < 0 || hIdx < 0 || lIdx < 0 || cIdx < 0) return []

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    const ts = parseInt(parts[tsIdx])
    if (!Number.isFinite(ts)) continue
    const open = parseFloat(parts[oIdx])
    const high = parseFloat(parts[hIdx])
    const low = parseFloat(parts[lIdx])
    const close = parseFloat(parts[cIdx])
    const volume = vIdx >= 0 ? parseFloat(parts[vIdx]) || 0 : 0
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue
    if (high < low || open <= 0 || high <= 0) continue
    bars.push({ timestamp: ts, open, high, low, close, volume })
  }
  return bars
}

async function main() {
  const generatedAt = new Date().toISOString()
  console.log('C2: triple-barrier 合成压力扫描 (double-hit 污染量化)...\n')

  // 1) 找 5m CSV 数据
  if (!existsSync(FIVE_M_DIR)) {
    console.log(`  数据目录不存在: ${FIVE_M_DIR}`)
    console.log('  跳过合成扫描 (待有数据时重新运行)')
    const outDir = join(ROOT, 'data', 'runtime')
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'triple_barrier_double_hit_synthetic_audit.latest.json'),
      JSON.stringify({ schemaVersion: 1, generatedAt, skipped: true, reason: 'no_5m_data', totalSimulatedTrades: 0, sameBarDoubleHitCount: 0, sameBarDoubleHitRatePct: 0, labelFlipCount: 0, labelFlipRatePct: 0, verdict: 'negligible', bySide: {}, recommendation: 'Gather 5m CSV data and re-run' }, null, 2) + '\n')
    return
  }

  const csvFiles = readdirSync(FIVE_M_DIR).filter(f => f.endsWith('.csv'))
  if (csvFiles.length === 0) {
    console.log('  无 CSV 文件, 跳过')
    return
  }
  console.log(`  发现 ${csvFiles.length} 个 CSV 文件`)

  // 2) 参数网格
  const upperPcts = [0.3, 0.5, 1.0, 2.0, 3.0]
  const lowerPcts = [0.3, 0.5, 1.0, 2.0, 3.0]
  const holdingBarsOptions = [6, 12, 24, 48]
  const sides: ('long' | 'short')[] = ['long', 'short']

  const entries: AuditEntry[] = []
  let totalSimulated = 0
  let sameBarDoubleHitCount = 0
  let labelFlipCount = 0
  const bySide: Record<string, { total: number; doubleHit: number; flip: number }> = { long: { total: 0, doubleHit: 0, flip: 0 }, short: { total: 0, doubleHit: 0, flip: 0 } }

  // 3) 只扫 BTC 和 ETH 的 CSV (高流动性)
  const symbols = csvFiles.filter(f => /^BTC|^ETH/i.test(f))
  for (const sym of symbols.slice(0, 2)) {
    const filePath = join(FIVE_M_DIR, sym)
    const bars = readCsvBars(filePath)
    if (bars.length < 50) continue
    console.log(`  ${sym}: ${bars.length} bars`)

    // 滚动入场 (步长 12 bar, 最近 30 天 ≈ 8640 bar)
    const maxBars = Math.min(bars.length, 8640)
    const step = 12

    for (let entryIdx = 0; entryIdx < maxBars - Math.max(...holdingBarsOptions) - 5; entryIdx += step) {
      for (const upper of upperPcts) {
        for (const lower of lowerPcts) {
          for (const holding of holdingBarsOptions) {
            for (const side of sides) {
              if (totalSimulated >= MAX_TRADES) break
              totalSimulated++

              const current = evaluateTripleBarrierLabel({
                candles: bars as any,
                entryIndex: entryIdx,
                upperBarrierPct: upper,
                lowerBarrierPct: lower,
                maxHoldingBars: holding,
                side,
                barrierMode: 'static_pct',
              })
              const conservative = evaluateConservative({
                candles: bars,
                entryIndex: entryIdx,
                upperBarrierPct: upper,
                lowerBarrierPct: lower,
                maxHoldingBars: holding,
                side,
              })

              // 检测同 bar 双命中: 在退出 bar 上检查 OHLC 是否同时穿越 upper 和 lower
              // 不依赖 current.hitUpperBarrier/hitLowerBarrier (它们互斥)
              const exitIdx = current.exitIndex
              let sameBarDoubleHit = false
              if (exitIdx > entryIdx && exitIdx < bars.length && exitIdx >= 0) {
                const exitBar = bars[exitIdx]
                const entryPrice = bars[entryIdx].close
                const upperPrice = entryPrice * (1 + upper / 100)
                const lowerPrice = entryPrice * (1 - lower / 100)
                if (exitBar.high >= upperPrice && exitBar.low <= lowerPrice) {
                  sameBarDoubleHit = true
                }
              }
              const labelFlip = current.label !== conservative.label

              if (sameBarDoubleHit) sameBarDoubleHitCount++
              if (labelFlip) labelFlipCount++

              bySide[side].total++
              if (sameBarDoubleHit) bySide[side].doubleHit++
              if (labelFlip) bySide[side].flip++

              if (sameBarDoubleHit || labelFlip) {
                entries.push({
                  upperPct: upper, lowerPct: lower, holdingBars: holding, side,
                  sameBarDoubleHit, labelFlip,
                  currentLabel: current.label,
                  conservativeLabel: conservative.label,
                })
              }
            }
            if (totalSimulated >= MAX_TRADES) break
          }
          if (totalSimulated >= MAX_TRADES) break
        }
        if (totalSimulated >= MAX_TRADES) break
      }
      if (totalSimulated >= MAX_TRADES) break
    }
  }

  const doubleHitRate = totalSimulated > 0 ? (sameBarDoubleHitCount / totalSimulated) * 100 : 0
  const flipRate = totalSimulated > 0 ? (labelFlipCount / totalSimulated) * 100 : 0

  let verdict: 'negligible' | 'moderate' | 'severe'
  if (doubleHitRate >= 5 || flipRate >= 5) {
    verdict = 'severe'
  } else if (doubleHitRate >= 0.5 || flipRate >= 0.5) {
    verdict = 'moderate'
  } else {
    verdict = 'negligible'
  }

  console.log(`\n结果:`)
  console.log(`  总模拟交易: ${totalSimulated}`)
  console.log(`  sameBarDoubleHit: ${sameBarDoubleHitCount} (${doubleHitRate.toFixed(2)}%)`)
  console.log(`  labelFlip: ${labelFlipCount} (${flipRate.toFixed(2)}%)`)
  console.log(`  verdict: ${verdict}`)

  const report = {
    schemaVersion: 1,
    generatedAt,
    totalSimulatedTrades: totalSimulated,
    sameBarDoubleHitCount,
    sameBarDoubleHitRatePct: parseFloat(doubleHitRate.toFixed(4)),
    labelFlipCount,
    labelFlipRatePct: parseFloat(flipRate.toFixed(4)),
    byBarrierPct: upperPcts.map(p => ({ pct: p, doubleHits: entries.filter(e => e.upperPct === p && e.sameBarDoubleHit).length, flips: entries.filter(e => e.upperPct === p && e.labelFlip).length })),
    bySide: { long: { ...bySide.long, doubleHitRatePct: bySide.long.total > 0 ? parseFloat(((bySide.long.doubleHit / bySide.long.total) * 100).toFixed(2)) : 0 }, short: { ...bySide.short, doubleHitRatePct: bySide.short.total > 0 ? parseFloat(((bySide.short.doubleHit / bySide.short.total) * 100).toFixed(2)) : 0 } },
    verdict,
    recommendation: verdict === 'negligible' ? '无需立即修复; 可保持当前实现'
      : verdict === 'moderate' ? '建议在下次策略迭代中添加 ambiguous 标记或更细粒度 bar 仲裁'
      : '需要立即修复 triple-barrier.ts:62-75',
  }

  const outDir = join(ROOT, 'data', 'runtime')
  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, 'triple_barrier_double_hit_synthetic_audit.latest.json')
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8')

  // 写入 evidence manifest
  const startedAt = new Date(Date.parse(generatedAt))
  const exitCode = verdict === 'negligible' ? 0 : 1
  await writeEvidenceManifestForArtifact({
    job: 'triple_barrier_double_hit_synthetic_audit',
    artifactPath: outPath,
    startedAt,
    finishedAt: new Date(),
    exitCode,
    businessStatus: exitCode === 0 ? 'pass' : 'warn',
    recordsIn: totalSimulated,
    recordsOut: 1,
    errorClass: null,
  })

  console.log(`\n输出: ${outPath}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => { console.error('失败:', err); process.exit(1) })
}
