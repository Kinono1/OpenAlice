#!/usr/bin/env tsx
/**
 * 签名工具 — 为 Manual Override JSON 计算 HMAC-SHA256 签名。
 *
 * 用法:
 *   ALICE_MANUAL_OVERRIDE_SECRET=$(openssl rand -hex 32) \
 *     corepack pnpm tsx scripts/sign_manual_override.ts \
 *       --in /tmp/unsigned.json \
 *       --out data/runtime/manual_override.json
 *
 * --in 文件格式（reason/issuedBy/issuedAt/expiresAt 必填）:
 *   {
 *     "reason": "系统升级窗口",
 *     "issuedBy": "ops-team",
 *     "issuedAt": "2026-06-01T12:00:00.000Z",
 *     "expiresAt": "2026-06-01T12:30:00.000Z",
 *     "pauseNewOpens": true,
 *     "forceDailyLossPct": 5,
 *     "approvedBy": ["alice", "bob"]
 *   }
 *
 * 输出在 --out 路径写入签名后的 JSON 文件，使用 writeJsonAtomic 确保原子写入。
 * 输出再用 ALICE_MANUAL_OVERRIDE_SECRET 验证签名通过后才退出 0。
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  canonicalizeManualOverride,
  signManualOverridePayload,
  verifyManualOverrideSignature,
} from '../src/runtime/manual_override.js'
import { resolveManualOverrideSecret } from '../src/core/manual-override-secret.js'
import { writeJsonAtomic } from '../src/runtime/atomic_write.js'

const OVERRIDE_SCHEMA = z
  .object({
    pauseNewOpens: z.boolean().optional(),
    ignoreReleaseGate: z.boolean().optional(),
    ignoreRegimeShift: z.boolean().optional(),
    forceCapitalRampStage: z.string().min(1).max(100).optional(),
    forceVolatilityQuantile: z.number().min(0).max(1).optional(),
    forceDailyLossPct: z.number().min(-100).max(100).optional(),
    forceCvarDailyLossPct: z.number().min(-100).max(100).optional(),
    forceConsecutiveLossDays: z.number().int().min(0).max(365).optional(),
    forceConsecutiveLossPct: z.number().min(-100).max(100).optional(),
    note: z.string().max(2000).optional(),
    updatedAt: z.string().optional(),
    reason: z.string().min(1).max(500),
    issuedBy: z.string().min(1).max(200),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    signature: z.string().optional(),
    approvedBy: z.array(z.string().min(1).max(200)).optional(),
  })
  .strict()

interface CliArgs {
  inPath: string
  outPath: string
}

function parseArgs(argv: string[]): CliArgs {
  let inPath = ''
  let outPath = ''
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--in' && i + 1 < argv.length) { inPath = argv[++i]; continue }
    if (argv[i] === '--out' && i + 1 < argv.length) { outPath = argv[++i]; continue }
  }
  if (!inPath) throw new Error('--in <unsigned.json> 必填')
  if (!outPath) throw new Error('--out <signed.json> 必填')
  return { inPath: resolve(inPath), outPath: resolve(outPath) }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const secret = resolveManualOverrideSecret()
  if (!secret) {
    console.error('错误: ALICE_MANUAL_OVERRIDE_SECRET 环境变量未设置')
    process.exit(1)
  }

  // 1) 读 unsigned JSON
  const raw = await readFile(args.inPath, 'utf-8')
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    console.error('错误: 输入不是合法 JSON')
    process.exit(1)
  }

  // 2) Zod schema 校验
  const parseResult = OVERRIDE_SCHEMA.safeParse(parsedJson)
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`)
    }
    process.exit(1)
  }

  // 3) 计算签名
  const unsigned = parseResult.data as Parameters<typeof signManualOverridePayload>[1]
  const signature = signManualOverridePayload(secret, unsigned)
  const signed = { ...unsigned, signature } as Parameters<typeof verifyManualOverrideSignature>[1]

  // 4) 原子写入
  await mkdirParent(args.outPath)
  writeJsonAtomic(args.outPath, signed)

  // 5) 验证签名正确
  if (!verifyManualOverrideSignature(secret, signed)) {
    console.error('错误: 签名验证失败 (内部不一致)')
    process.exit(1)
  }

  const canonical = canonicalizeManualOverride(signed)
  console.log(`签名已验证. 已写入: ${args.outPath}`)
  console.log(`签名校验和: ${canonical.length} bytes canonical / ${signature.length / 2} bytes HMAC`)
}

async function mkdirParent(filePath: string): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'))
  if (dir) {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true }).catch(() => {})
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    console.error('签名失败:', err)
    process.exit(2)
  })
}
