import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import { archiveSealedWarehouse, inspectArchiveStatus } from './lib/okx_ssd_archive.js'
import { appendJsonLine, atomicWriteJson } from './lib/okx_warehouse.js'

export interface ReminderResult {
  schemaVersion: 'okx_ssd_reminder.v1'
  generatedAt: string
  weekId: string
  messageType: 'connect_ssd' | 'archive_summary' | 'archive_failed' | 'identity_mismatch' | 'cold_storage_full' | 'suppressed'
  shouldNotify: boolean
  reason: string
  fullText: string
  pendingBytes: number
  localFreeBytes: number | null
  ssdState: string
  fallback: { attempted: boolean; delivered: boolean; reason: string }
}

export async function runOkxSsdReminder(argv = process.argv.slice(2)): Promise<ReminderResult> {
  const raw = parseRawArgs(argv)
  const mode = raw.get('mode') ?? 'weekly'
  const config = await loadOkxMarketDataConfig(raw.get('configPath'))
  const warehouseRoot = resolveOkxWarehouseRoot(config)
  const now = raw.get('now') ? new Date(raw.get('now')!) : new Date()
  const weekId = isoWeekId(now)
  const inspected = await inspectArchiveStatus({ config, warehouseRoot })
  const previous = await readState(config.dataRoot)
  const lastAt = previous?.lastNotifiedAt ? Date.parse(previous.lastNotifiedAt) : 0
  const sameState = previous?.lastMessageType === messageTypeFor(inspected.status.status)
  const rateLimited = sameState && now.getTime() - lastAt < 24 * 60 * 60 * 1000
  const alreadyConnectedThisWeek = previous?.weekId === weekId && previous.connectedThisWeek === true
  let messageType = messageTypeFor(inspected.status.status)
  let shouldNotify = true
  let reason = inspected.status.status
  let batch: Awaited<ReturnType<typeof archiveSealedWarehouse>>['batch'] = null

  if (inspected.status.connected && inspected.status.identityVerified && ['archive_pending', 'ready'].includes(inspected.status.status)) {
    const archived = await archiveSealedWarehouse({ config, warehouseRoot })
    batch = archived.batch
    messageType = archived.status.status === 'archive_complete' ? 'archive_summary' : messageTypeFor(archived.status.status)
    reason = archived.status.status
    shouldNotify = archived.status.status === 'archive_complete' || ['archive_verification_failed', 'blocked_cold_storage_full'].includes(archived.status.status)
  } else if (mode === 'followup' && alreadyConnectedThisWeek) {
    shouldNotify = false
    messageType = 'suppressed'
    reason = 'connected_this_week'
  } else if (rateLimited) {
    shouldNotify = false
    messageType = 'suppressed'
    reason = 'same_state_rate_limited_24h'
  }

  const localFreeBytes = inspected.status.freeBytes == null ? await localFreeSpace(warehouseRoot) : await localFreeSpace(warehouseRoot)
  const fullText = renderMessage(messageType, inspected.status, batch, localFreeBytes)
  const fallback = { attempted: false, delivered: false, reason: shouldNotify ? 'deferred_to_cron_listener' : 'suppressed' }
  const result: ReminderResult = {
    schemaVersion: 'okx_ssd_reminder.v1', generatedAt: now.toISOString(), weekId,
    messageType, shouldNotify, reason, fullText, pendingBytes: inspected.status.pendingBytes,
    localFreeBytes, ssdState: inspected.status.status, fallback,
  }
  await atomicWriteJson(resolve(config.dataRoot, 'runtime', 'storage', 'ssd_reminder_state.json'), {
    schemaVersion: 'okx_ssd_reminder_state.v1', weekId,
    connectedThisWeek: deriveConnectedThisWeek(alreadyConnectedThisWeek, inspected.status),
    lastMessageType: shouldNotify ? messageType : previous?.lastMessageType ?? null,
    lastNotifiedAt: shouldNotify ? now.toISOString() : previous?.lastNotifiedAt ?? null,
    lastResult: result,
  })
  await atomicWriteJson(resolve(config.dataRoot, 'runtime', 'storage', 'ssd_reminder_notification.json'), {
    shouldNotify,
    deliveryDecision: shouldNotify ? 'notify' : 'suppress',
    headline: `OpenAlice SSD reminder: ${messageType}`,
    fullText,
    macosFallback: true,
    deliveryReceiptPath: resolve(config.dataRoot, 'runtime', 'storage', 'ssd_delivery_receipts.jsonl'),
    receiptContext: { weekId, messageType, pendingBytes: inspected.status.pendingBytes, localFreeBytes, ssdState: inspected.status.status },
  })
  return result
}

export function deriveConnectedThisWeek(
  alreadyConnectedThisWeek: boolean,
  status: Pick<Awaited<ReturnType<typeof inspectArchiveStatus>>['status'], 'connected' | 'identityVerified'>,
): boolean {
  return alreadyConnectedThisWeek || (status.connected && status.identityVerified)
}

function messageTypeFor(status: string): ReminderResult['messageType'] {
  if (status === 'blocked_volume_identity_mismatch') return 'identity_mismatch'
  if (status === 'blocked_cold_storage_full') return 'cold_storage_full'
  if (status === 'archive_verification_failed') return 'archive_failed'
  return 'connect_ssd'
}

function renderMessage(type: ReminderResult['messageType'], status: Awaited<ReturnType<typeof inspectArchiveStatus>>['status'], batch: Awaited<ReturnType<typeof archiveSealedWarehouse>>['batch'], localFreeBytes: number | null): string {
  const localFreeGiB = localFreeBytes == null ? 'unknown' : (localFreeBytes / 1024 ** 3).toFixed(1)
  const pendingGiB = (status.pendingBytes / 1024 ** 3).toFixed(2)
  const earliest = status.earliestPendingDate ?? 'unknown'
  if (type === 'archive_summary') return `OpenAlice 已将 OKX 冷数据归档到 shield。batch=${batch?.batchId ?? 'unknown'}，files=${batch?.files.length ?? 0}，bytes=${batch?.totalBytes ?? 0}，本机剩余=${localFreeGiB} GiB。`
  if (type === 'identity_mismatch') return `OpenAlice 检测到外接磁盘，但 UUID 或 archiveId 与已登记的 shield 不一致。未写入、未删除本机数据。待归档=${pendingGiB} GiB。`
  if (type === 'cold_storage_full') return `OpenAlice 的 shield 冷存储已达到容量保护门槛，自动归档暂停，冷数据未自动删除。待归档=${pendingGiB} GiB，本机剩余=${localFreeGiB} GiB。`
  if (type === 'archive_failed') return `OpenAlice SSD 归档校验失败。本机源数据完整保留。待归档=${pendingGiB} GiB，本机剩余=${localFreeGiB} GiB。`
  if (type === 'suppressed') return 'OpenAlice SSD 提醒已按本周状态或 24 小时限频规则抑制。'
  if (!status.enrolled) return `请连接 shield SSD，并首次手工运行 OpenAlice enrollment。首次登记成功后将自动归档。待归档=${pendingGiB} GiB，文件=${status.pendingFiles}，最早未归档日期=${earliest}，本机剩余=${localFreeGiB} GiB。`
  return `请连接已登记的 shield SSD，让 OpenAlice 自动归档 OKX 数据。待归档=${pendingGiB} GiB，文件=${status.pendingFiles}，最早未归档日期=${earliest}，本机剩余=${localFreeGiB} GiB。`
}

async function readState(dataRoot: string): Promise<{ weekId?: string; connectedThisWeek?: boolean; lastMessageType?: string; lastNotifiedAt?: string } | null> {
  try { return JSON.parse(await readFile(resolve(dataRoot, 'runtime', 'storage', 'ssd_reminder_state.json'), 'utf-8')) } catch { return null }
}

async function localFreeSpace(path: string): Promise<number | null> { try { const { statfs } = await import('node:fs/promises'); const fs = await statfs(path); return fs.bavail * fs.bsize } catch { return null } }
function isoWeekId(date: Date): string { const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); const day = utc.getUTCDay() || 7; utc.setUTCDate(utc.getUTCDate() + 4 - day); const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1)); const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7); return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}` }
function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token?.startsWith('--')) continue; const next = argv[i + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); i += 1 } } return out }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runOkxSsdReminder().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => { console.error(error); process.exitCode = 1 })
