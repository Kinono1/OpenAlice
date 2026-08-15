import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('microstructure stop-loss replay cron wrapper', () => {
  it('keeps the formal report out of the cron log and bounds retained log history', async () => {
    const script = await readFile('scripts/cron_microstructure_stoploss_replay.sh', 'utf-8')

    expect(script).toContain('OPENALICE_CRON_LOG_MAX_BYTES')
    expect(script).toContain('OPENALICE_CRON_LOG_KEEP_LINES')
    expect(script).toContain('compact_log_if_oversized')
    expect(script).toContain('tail -n "$LOG_KEEP_LINES" "$LOG_FILE" > "$compact_path"')
    expect(script).toContain('--json true >/dev/null')
    expect(script).toContain('--outputPath "$REPORT_PATH"')
  })
})
