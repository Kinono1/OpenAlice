import { resolveRuntimePaths } from '../src/runtime/runtime-paths.js'
import { loadSystemStatus, serializeSystemStatus } from '../src/runtime/system_status.js'

async function main(): Promise<void> {
  const runtime = resolveRuntimePaths()
  const status = await loadSystemStatus({ runtime })
  process.stdout.write(`${serializeSystemStatus(status)}\n`)
}

main().catch(() => {
  console.error('system status unavailable')
  process.exitCode = 1
})
