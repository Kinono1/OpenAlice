import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { readKillSwitch, type KillSwitch, type KillState } from '../src/risk/kill-switch.js'

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = process.argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i++
    } else {
      args[key] = 'true'
    }
  }
  return args
}

const args = parseArgs()

const reviewedBy = args['reviewed-by']
const reason = args['reason']
const confirm = args['confirm']
const dryRunRaw = args['dry-run'] ?? args['dryRun'] ?? 'true'
const isDryRun = dryRunRaw !== 'false'

if (!reviewedBy) {
  console.error('ERROR: --reviewed-by is required')
  process.exit(64)
}
if (!reason) {
  console.error('ERROR: --reason is required')
  process.exit(64)
}
if (confirm !== 'true') {
  console.error('ERROR: --confirm is required')
  process.exit(64)
}

const KILL_SWITCH_PATH = 'data/runtime/KILL_SWITCH.json'
const AUDIT_PATH = 'data/runtime/kill_switch_audit.jsonl'

const ks = readKillSwitch()
const oldState: KillState = ks?.state ?? 'normal'
const oldEnabled = ks?.enabled ?? false

console.log('=== Kill Switch Admin Reset ===')
console.log(`Current state:    ${oldState} (enabled: ${oldEnabled})`)
console.log(`Reviewed by:      ${reviewedBy}`)
console.log(`Reason:           ${reason}`)

const snapshotCandidates = [
  'data/runtime/system_fuse.json',
  'data/runtime/global_exposure_reservations.jsonl',
  'data/runtime/sidecar_signal_intake.latest.json',
]
const runtimeSnapshotPaths = snapshotCandidates.filter(p => existsSync(p))

const auditEntry = {
  old_state: oldState,
  new_state: 'normal' as const,
  trigger: 'admin_reset',
  reviewed_by: reviewedBy,
  reason,
  runtime_snapshot_paths: runtimeSnapshotPaths,
  reset_at: new Date().toISOString(),
}

console.log('\nAudit entry:')
console.log(JSON.stringify(auditEntry, null, 2))

if (isDryRun) {
  console.log('\nDRY RUN - no files changed')
  process.exit(0)
}

const newKillSwitch: KillSwitch = {
  enabled: false,
  state: 'normal',
  reason: `reset by ${reviewedBy}: ${reason}`,
  created_at: new Date().toISOString(),
  allow_close_only: false,
  block_new_positions: false,
}

mkdirSync(dirname(KILL_SWITCH_PATH), { recursive: true })
writeFileSync(KILL_SWITCH_PATH, JSON.stringify(newKillSwitch, null, 2) + '\n')
console.log(`\nWrote ${KILL_SWITCH_PATH}`)

mkdirSync(dirname(AUDIT_PATH), { recursive: true })
appendFileSync(AUDIT_PATH, JSON.stringify(auditEntry) + '\n')
console.log(`Appended audit to ${AUDIT_PATH}`)

console.log('\nKill switch reset complete.')
