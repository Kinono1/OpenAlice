import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import {
  archiveSealedWarehouse,
  enrollArchiveVolume,
  inspectArchiveStatus,
  restoreArchiveRange,
  verifyArchiveBatch,
} from './lib/okx_ssd_archive.js'
import { atomicWriteJson } from './lib/okx_warehouse.js'

export async function runOkxSsdStorage(argv = process.argv.slice(2)): Promise<unknown> {
  const command = argv[0] ?? 'status'
  const raw = parseRawArgs(argv.slice(1))
  const config = await loadOkxMarketDataConfig(raw.get('configPath'))
  const warehouseRoot = resolveOkxWarehouseRoot(config)
  const enrollmentPath = raw.get('enrollmentPath') ?? config.archive.enrollmentPath
  if (command === 'enroll') {
    const mountPoint = raw.get('mount')
    if (!mountPoint) throw new Error('enroll requires --mount /Volumes/shield')
    return enrollArchiveVolume({ mountPoint, config, warehouseRoot, enrollmentPath })
  }
  if (command === 'status') {
    const result = await inspectArchiveStatus({ config, warehouseRoot, enrollmentPath })
    await atomicWriteJson(resolve(config.dataRoot, 'runtime', 'storage', 'ssd_archive_state.json'), result.status)
    return result.status
  }
  if (command === 'archive' || command === 'probe') {
    const result = await archiveSealedWarehouse({
      config, warehouseRoot, enrollmentPath,
      dryRun: parseBool(raw.get('dryRun'), false),
      minAgeMs: Number(raw.get('minAgeMs') ?? 2 * 60 * 60 * 1000),
    })
    await writeNotification(config.dataRoot, result.status, result.batch)
    return result
  }
  if (command === 'verify' || command === 'integrity') {
    const inspected = await inspectArchiveStatus({ config, warehouseRoot, enrollmentPath })
    const batchId = raw.get('batchId') ?? inspected.status.lastCommittedBatchId
    if (!batchId) {
      const result = { verified: false, checkedFiles: 0, errors: [inspected.status.status === 'blocked_ssd_not_mounted' ? 'blocked_ssd_not_mounted' : 'no_committed_batch'] }
      await writeIntegrityNotification(config.dataRoot, result)
      return result
    }
    const result = await verifyArchiveBatch({ config, warehouseRoot, enrollmentPath, batchId })
    await writeIntegrityNotification(config.dataRoot, result)
    return result
  }
  if (command === 'restore') {
    const dataset = raw.get('dataset')
    const from = raw.get('from')
    const to = raw.get('to')
    if (!dataset || !from || !to) throw new Error('restore requires --dataset, --from YYYY-MM-DD, and --to YYYY-MM-DD')
    return restoreArchiveRange({ config, warehouseRoot, enrollmentPath, dataset, from, to, outputRoot: raw.get('outputRoot') })
  }
  throw new Error(`unknown SSD storage command: ${command}`)
}

async function writeIntegrityNotification(dataRoot: string, result: { verified: boolean; checkedFiles: number; errors: string[] }): Promise<void> {
  const actionable = result.errors.some(error => !['blocked_ssd_not_mounted', 'no_committed_batch'].includes(error))
  await atomicWriteJson(resolve(dataRoot, 'runtime', 'okx_warehouse', 'ssd_integrity_notification.json'), {
    shouldNotify: actionable,
    deliveryDecision: actionable ? 'notify' : 'suppress',
    headline: `OpenAlice SSD integrity: ${result.verified ? 'pass' : result.errors[0] ?? 'blocked'}`,
    fullText: `OpenAlice SSD integrity verified=${result.verified} checkedFiles=${result.checkedFiles} errors=${result.errors.join(',') || 'none'}`,
  })
}

async function writeNotification(dataRoot: string, status: Awaited<ReturnType<typeof inspectArchiveStatus>>['status'], batch: Awaited<ReturnType<typeof archiveSealedWarehouse>>['batch']): Promise<void> {
  const shouldNotify = ['blocked_volume_identity_mismatch', 'blocked_cold_storage_full', 'archive_verification_failed'].includes(status.status) || status.status === 'archive_complete'
  await atomicWriteJson(resolve(dataRoot, 'runtime', 'storage', 'ssd_archive_notification.json'), {
    shouldNotify,
    deliveryDecision: shouldNotify ? 'notify' : 'suppress',
    headline: `OpenAlice SSD archive: ${status.status}`,
    fullText: status.status === 'archive_complete'
      ? `OpenAlice SSD archive complete. batch=${batch?.batchId ?? 'unknown'} files=${batch?.files.length ?? 0} bytes=${batch?.totalBytes ?? 0}`
      : `OpenAlice SSD archive status=${status.status} pendingFiles=${status.pendingFiles} pendingBytes=${status.pendingBytes} blockers=${status.blockers.join(',') || 'none'}`,
  })
}

function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token?.startsWith('--')) continue; const next = argv[i + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); i += 1 } } return out }
function parseBool(value: string | undefined, fallback: boolean): boolean { return value == null ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()) }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runOkxSsdStorage().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => { console.error(error); process.exitCode = 1 })
