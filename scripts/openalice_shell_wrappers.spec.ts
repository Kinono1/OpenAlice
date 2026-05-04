import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const envLoadedWrappers = [
  'scripts/cron_dirty_worktree_audit.sh',
  'scripts/cron_eth_carry_refresh_pipeline.sh',
  'scripts/cron_external_derivatives_data_collect.sh',
  'scripts/cron_microstructure_stoploss_replay.sh',
  'scripts/cron_openalice_task.sh',
  'scripts/cron_p1_trading_evidence.sh',
  'scripts/cron_paper_pnl_diagnostics.sh',
  'scripts/cron_paper_policy_shadow_capture.sh',
  'scripts/cron_paper_policy_shadow_settle.sh',
  'scripts/cron_pro_policy_window.sh',
  'scripts/cron_scheduler_security_audit.sh',
  'scripts/launch_microstructure_stress_monitor.sh',
  'scripts/launch_openalice_main.sh',
  'scripts/launch_realtime_shadow_monitor.sh',
]

const lockGuardedCronWrappers = [
  'scripts/cron_dirty_worktree_audit.sh',
  'scripts/cron_eth_carry_refresh_pipeline.sh',
  'scripts/cron_microstructure_stoploss_replay.sh',
  'scripts/cron_openalice_task.sh',
  'scripts/cron_p1_trading_evidence.sh',
  'scripts/cron_paper_pnl_diagnostics.sh',
  'scripts/cron_paper_policy_shadow_capture.sh',
  'scripts/cron_paper_policy_shadow_settle.sh',
  'scripts/cron_pro_policy_window.sh',
  'scripts/cron_scheduler_security_audit.sh',
]

describe('OpenAlice shell wrappers', () => {
  it('loads local secrets only through the shared restricted env-file loader', async () => {
    for (const path of envLoadedWrappers) {
      const script = await readFile(path, 'utf-8')

      expect(script, path).toContain('source "$REPO_ROOT/scripts/openalice_env.sh"')
      expect(script, path).not.toMatch(/DEEPSEEK_API_KEY\s*=/)
      expect(script, path).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/)
    }
  })

  it('fails closed when the env file is group or other accessible', async () => {
    const loader = await readFile('scripts/openalice_env.sh', 'utf-8')

    expect(loader).toContain('must not be group/other-accessible')
    expect(loader).toContain('chmod 600')
    expect(loader).toContain('! -f "$env_file" || -L "$env_file"')
  })

  it('does not run ungated paper lanes unless explicitly requested', async () => {
    const cron = await readFile('scripts/cron_openalice_task.sh', 'utf-8')
    const microstructureLaunch = await readFile('scripts/launch_microstructure_stress_monitor.sh', 'utf-8')

    expect(cron).toContain('${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}')
    expect(microstructureLaunch).toContain('${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}')
    expect(microstructureLaunch).toContain('skip paper:microstructure-stress')
    expect(microstructureLaunch).toMatch(
      /if \[\[ "\$\{OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false\}" != "true" \]\]; then\s+echo "[^"]*skip paper:microstructure-stress:[^"]*"\s+return 0\s+fi/,
    )
    expect(microstructureLaunch).toContain('local -a microstructure_paper_cmd=(')
    expect(microstructureLaunch).toContain('"${microstructure_paper_cmd[@]}"')
  })

  it('refreshes P1.5 meta-labeling readiness from P1 evidence without training or trading', async () => {
    const script = await readFile('scripts/cron_p1_trading_evidence.sh', 'utf-8')

    expect(script).toContain('scripts/build_p1_trading_evidence.ts')
    expect(script).toContain('scripts/build_meta_labeling_shadow_readiness.ts')
    expect(script).toContain('META_LABEL_READINESS_PATH=')
    expect(script).toContain('scripts/build_p1_trading_evidence_notification.ts')
    expect(script).not.toContain('research:meta:train')
    expect(script).not.toContain('research/ml-training/train_meta_labeling.py')
    expect(script).not.toContain('paper:cross-sectional')
    expect(script).not.toContain('paper:volume-breakout')
    expect(script).not.toContain('paper:microstructure-stress')

    const notificationBuilder = await readFile('scripts/build_p1_trading_evidence_notification.ts', 'utf-8')
    expect(notificationBuilder).toContain('trialSourceCoverage')
    expect(notificationBuilder).toContain('trialSourceTargets')
    expect(notificationBuilder).toContain('openPositionReadiness')
    expect(notificationBuilder).toContain('metaTrainingAllowed')
    expect(notificationBuilder).toContain('routeCostShadowEligibility')
  })

  it('refreshes runtime manifest coverage from dirty-worktree audit without mutating git', async () => {
    const script = await readFile('scripts/cron_dirty_worktree_audit.sh', 'utf-8')

    expect(script).toContain('MANIFEST_COVERAGE_PATH=')
    expect(script).toContain('scripts/audit_runtime_manifest_coverage.ts')
    expect(script).toContain('runtime_manifest_coverage reported blockers')
    expect(script).toContain('Runtime manifest coverage=')
    expect(script).not.toMatch(/^\s*git\s+reset\s+--hard\b/m)
    expect(script).not.toMatch(/^\s*git\s+clean\s+-fd\b/m)
    expect(script).not.toMatch(/^\s*git\s+add\s+\.\b/m)
  })

  it('writes fresh lock-overlap notification artifacts through the shared cron lock helper', async () => {
    const helper = await readFile('scripts/openalice_cron_lock.sh', 'utf-8')
    expect(helper).toContain('openalice_acquire_cron_lock')
    expect(helper).toContain('OPENALICE_CRON_LOCK_STALE_AFTER_SECONDS')
    expect(helper).toContain('lockAgeSeconds')

    for (const path of lockGuardedCronWrappers) {
      const script = await readFile(path, 'utf-8')
      expect(script, path).toContain('source "$REPO_ROOT/scripts/openalice_cron_lock.sh"')
      expect(script, path).toContain('openalice_acquire_cron_lock')
      expect(script, path).toContain('openalice_release_cron_lock "$LOCK_DIR"')
      expect(script, path).not.toMatch(/if ! mkdir "\$LOCK_DIR"/)
      expect(script, path).not.toContain('lock exists, skipping overlap"\n  exit 0')
    }
  })

  it('suppresses normal overlaps but notifies on stale cron locks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-cron-lock-helper-'))
    const scriptsDir = join(root, 'scripts')
    const lockDir = join(root, 'data', 'runtime', 'locks', 'test.lock')
    const notificationPath = join(root, 'data', 'runtime', 'test_notification.json')
    const logPath = join(root, 'logs', 'test.log')
    const runnerPath = join(root, 'run-helper.sh')
    await mkdir(scriptsDir, { recursive: true })
    await mkdir(lockDir, { recursive: true })
    await writeFile(
      join(scriptsDir, 'openalice_cron_lock.sh'),
      await readFile('scripts/openalice_cron_lock.sh', 'utf-8'),
      'utf-8',
    )
    await writeFile(runnerPath, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'source "$1"',
      'if openalice_acquire_cron_lock test_job "$2" "$3" "$4"; then',
      '  openalice_release_cron_lock "$2"',
      'fi',
      '',
    ].join('\n'), 'utf-8')
    await chmod(runnerPath, 0o755)

    await runScript(runnerPath, [
      join(scriptsDir, 'openalice_cron_lock.sh'),
      lockDir,
      notificationPath,
      logPath,
    ], {
      ...process.env,
      OPENALICE_CRON_LOCK_STALE_AFTER_SECONDS: '3600',
    })
    let notification = JSON.parse(await readFile(notificationPath, 'utf-8')) as Record<string, unknown>
    expect(notification).toMatchObject({
      shouldNotify: false,
      deliveryDecision: 'suppress',
      lockHeld: true,
      stale: false,
    })

    await runScript(runnerPath, [
      join(scriptsDir, 'openalice_cron_lock.sh'),
      lockDir,
      notificationPath,
      logPath,
    ], {
      ...process.env,
      OPENALICE_CRON_LOCK_STALE_AFTER_SECONDS: '0',
    })
    notification = JSON.parse(await readFile(notificationPath, 'utf-8')) as Record<string, unknown>
    expect(notification).toMatchObject({
      shouldNotify: true,
      deliveryDecision: 'notify',
      lockHeld: true,
      stale: true,
    })
    expect(String(notification.fullText)).toContain('test_job skipped because a previous run still holds the cron lock')
  })
})

function runScript(path: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.on('error', reject)
    child.on('close', code => resolve(code ?? 1))
  })
}
