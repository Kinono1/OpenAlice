import { evaluateReplayGate, writeReplayGateVerdict } from '../src/runtime/replay_gate.js'

function parseArgs(): { json: boolean; baseDir: string | undefined } {
  const args = process.argv.slice(2)
  let json = false
  let baseDir: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') {
      json = true
    } else if (args[i] === '--base-dir' && i + 1 < args.length) {
      baseDir = args[++i]
    }
  }
  return { json, baseDir }
}

function printVerdict(verdict: ReturnType<typeof evaluateReplayGate>): void {
  console.log('========================================')
  console.log('  Replay Gate Verdict')
  console.log(`  Checked at: ${verdict.checked_at}`)
  console.log(`  Passed:     ${verdict.passed ? 'YES' : 'NO'}`)
  console.log('========================================')
  console.log()

  function printCheck(label: string, check: typeof verdict.replay): void {
    const statusIcon = check.status === 'ok' ? 'OK' : check.status === 'missing' ? 'MISS' : check.status === 'stale' ? 'STALE' : 'FAIL'
    console.log(`  ${label}: [${statusIcon}]`)
    console.log(`    Path:    ${check.path ?? 'N/A'}`)
    console.log(`    Present: ${check.present}`)
    console.log(`    Details: ${check.details ?? 'N/A'}`)
    console.log()
  }

  printCheck('Replay Evidence', verdict.replay)
  printCheck('Drift Evidence', verdict.drift)
  printCheck('Paper Evidence', verdict.paper)
  printCheck('Shortfall Evidence', verdict.shortfall)

  if (verdict.blockers.length > 0) {
    console.log('  Blockers:')
    for (const blocker of verdict.blockers) {
      console.log(`    - ${blocker}`)
    }
    console.log()
  }

  console.log(`  Result: ${verdict.passed ? 'REPLAY GATE PASSED' : 'REPLAY GATE BLOCKED'}`)
  console.log('========================================')
}

const { json, baseDir } = parseArgs()
const verdict = evaluateReplayGate(baseDir)

writeReplayGateVerdict(verdict)

if (json) {
  console.log(JSON.stringify(verdict, null, 2))
} else {
  printVerdict(verdict)
}

process.exit(verdict.passed ? 0 : 1)
