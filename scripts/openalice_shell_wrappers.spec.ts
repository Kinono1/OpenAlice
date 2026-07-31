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

  it('normalizes proxy variables after loading the restricted env file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-env-loader-'))
    const scriptsDir = join(root, 'scripts')
    const envDir = join(root, 'env')
    const loaderPath = join(scriptsDir, 'openalice_env.sh')
    const envPath = join(envDir, 'openalice.env')
    const runnerPath = join(root, 'run-env-loader.sh')
    await mkdir(scriptsDir, { recursive: true })
    await mkdir(envDir, { recursive: true })
    await writeFile(loaderPath, await readFile('scripts/openalice_env.sh', 'utf-8'), 'utf-8')
    await writeFile(envPath, [
      'https_proxy=http://127.0.0.1:7892',
      'http_proxy=http://127.0.0.1:7892',
      'no_proxy=localhost,127.0.0.1',
      '',
    ].join('\n'), 'utf-8')
    await chmod(envPath, 0o600)
    await writeFile(runnerPath, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'source "$1"',
      'printf "%s\\n" "$HTTPS_PROXY" "$HTTP_PROXY" "$NO_PROXY" "$https_proxy" "$http_proxy" "$no_proxy"',
      '',
    ].join('\n'), 'utf-8')
    await chmod(runnerPath, 0o755)

    const output = await runScriptForOutput(runnerPath, [loaderPath], {
      HOME: root,
      OPENALICE_ENV_FILE: envPath,
      PATH: process.env.PATH ?? '',
    })

    expect(output.trim().split('\n')).toEqual([
      'http://127.0.0.1:7892',
      'http://127.0.0.1:7892',
      'localhost,127.0.0.1',
      'http://127.0.0.1:7892',
      'http://127.0.0.1:7892',
      'localhost,127.0.0.1',
    ])
  })

  it('does not run ungated paper lanes unless explicitly requested', async () => {
    const cron = await readFile('scripts/cron_openalice_task.sh', 'utf-8')
    const microstructureLaunch = await readFile('scripts/launch_microstructure_stress_monitor.sh', 'utf-8')
    const realtimeLaunch = await readFile('scripts/launch_realtime_shadow_monitor.sh', 'utf-8')

    expect(cron).toContain('${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}')
    expect(cron).toContain('run_pnpm paper:cross-sectional -- --dataMode live_only --skipSecondLevel true --requirePromotionV2 true --dryRun false')
    expect(cron).toContain('run_pnpm paper:cross-sectional -- --dataMode live_only --skipSecondLevel true --requirePromotionV2 false --dryRun false')
    expect(microstructureLaunch).toContain('${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}')
    expect(microstructureLaunch).toContain('skip paper:microstructure-stress')
    expect(microstructureLaunch).toMatch(
      /if \[\[ "\$\{OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false\}" != "true" \]\]; then\s+echo "[^"]*skip paper:microstructure-stress:[^"]*"\s+return 0\s+fi/,
    )
    expect(microstructureLaunch).toContain('local -a microstructure_paper_cmd=(')
    expect(microstructureLaunch).toContain('"${microstructure_paper_cmd[@]}"')
    expect(realtimeLaunch).toContain('OPENALICE_PAPER_MONITOR_SKIP_DATA:-true')
    expect(realtimeLaunch).toContain('OPENALICE_PAPER_MONITOR_SKIP_PAPER:-true')
    expect(realtimeLaunch).toContain('OPENALICE_PAPER_MONITOR_SKIP_OPTIMIZE:-true')
    expect(realtimeLaunch).toContain('OPENALICE_PAPER_MONITOR_SKIP_VALIDATION:-true')
    expect(realtimeLaunch).toContain('OPENALICE_PAPER_MONITOR_REQUIRE_PROMOTION_V2:-true')
    expect(realtimeLaunch).toContain('OPENALICE_PAPER_MONITOR_ENABLE_DIRECT_PAPER:-false')
    expect(realtimeLaunch).toContain('OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false')
    expect(realtimeLaunch).toContain('skip direct paper lanes')
    expect(realtimeLaunch).toContain('--dryRun true --allowUngatedPaperLane true')
    expect(realtimeLaunch).not.toContain('--dryRun false --allowUngatedPaperLane true')
  })

  it('refreshes market intel context explicitly outside dry-run mode from cron', async () => {
    const cron = await readFile('scripts/cron_openalice_task.sh', 'utf-8')

    expect(cron).toContain('refresh_market_intel_context)')
    expect(cron).toContain('run_pnpm market:intel:refresh -- --dryRun false')
  })

  it('ticks prospective evidence capture and settlement without routing to paper or live orders', async () => {
    const cron = await readFile('scripts/cron_openalice_task.sh', 'utf-8')
    const prospectiveCase = cron.slice(
      cron.indexOf('prospective_evidence_tick)'),
      cron.indexOf('continuous_improvement_loop)'),
    )

    expect(prospectiveCase).toContain('run_pnpm research:liquidity-conditioned:prospective-observation:capture')
    expect(prospectiveCase).toContain('run_pnpm research:eth-carry:okx-snapshot')
    expect(prospectiveCase).toContain('run_pnpm research:okx:orderbook-spread-snapshot')
    expect(prospectiveCase).toContain('run_pnpm research:okx:runtime-route-cost-budget')
    expect(prospectiveCase).toContain('run_pnpm paper:execution-future-telemetry-watchdog')
    expect(prospectiveCase).toContain('run_pnpm research:okx:route-cost-slippage-readiness')
    expect(prospectiveCase).toContain('run_pnpm research:eth-carry:pit-features')
    expect(prospectiveCase).toContain('run_pnpm data:features:eth-carry:materialize')
    expect(prospectiveCase).toContain('run_pnpm research:eth-carry:pit-audit')
    expect(prospectiveCase).toContain('run_pnpm research:liquidity-conditioned:prospective-observation:settle')
    expect(prospectiveCase).toContain('run_pnpm research:liquidity-conditioned:prospective-evidence:status')
    expect(prospectiveCase).toContain('run_pnpm research:cross-sectional:prospective-observation:capture')
    expect(prospectiveCase).toContain('run_pnpm research:cross-sectional:prospective-observation:settle')
    expect(prospectiveCase).toContain('run_pnpm research:cross-sectional:prospective-evidence:status')
    expect(prospectiveCase).toContain('run_pnpm research:eth-carry:prospective-observation:settle')
    expect(prospectiveCase).toContain('run_pnpm research:eth-carry:prospective-observation:capture')
    expect(prospectiveCase).toContain('run_pnpm research:eth-carry:prospective-evidence:status')
    expect(prospectiveCase).toContain('run_pnpm research:eth-carry:signal-diagnostics')
    expect(prospectiveCase).toContain('run_pnpm research:eth-carry:data-gap-status')
    expect(prospectiveCase).toContain('run_pnpm research:eth-carry:prospective-watchdog')
    expect(prospectiveCase).toContain('run_pnpm research:eth-carry:evidence-status')
    expect(prospectiveCase).toContain('run_pnpm research:ai-scientist:crypto-intake')
    expect(prospectiveCase).toContain('run_pnpm research:ai-scientist:second-validation-queue')
    expect(prospectiveCase).toContain('run_pnpm research:ai-scientist:source-manifest')
    expect(prospectiveCase).toContain('run_pnpm research:ai-scientist:second-validation-readiness')
    expect(prospectiveCase).toContain('run_pnpm research:ai-scientist:pit-reproduction-plan')
    expect(prospectiveCase).toContain('run_pnpm research:ai-scientist:pit-input-dataset')
    expect(prospectiveCase).toContain('run_pnpm research:ai-scientist:pit-contract-status')
    expect(prospectiveCase).toContain('run_pnpm data:warehouse:manifest-index')
    expect(prospectiveCase).toContain('run_pnpm data:warehouse:normalized-index')
    expect(prospectiveCase).toContain('run_pnpm data:warehouse:catalog -- --allowBlockedExitZero true')
    expect(prospectiveCase).toContain('run_pnpm data:monitor')
    expect(prospectiveCase).toContain('run_pnpm research:strategy:defect-monitor')
    expect(prospectiveCase).toContain('run_pnpm research:strategy:defect-registry')
    expect(prospectiveCase).toContain('run_pnpm research:quant-framework:benchmark')
    expect(prospectiveCase).toContain('run_pnpm status:reason-chain')
    expect(prospectiveCase).not.toContain('paper:cross-sectional')
    expect(prospectiveCase).not.toContain('paper:volume-breakout')
    expect(prospectiveCase).not.toContain('live')
  })

  it('provides a lightweight ETH carry prospective tick without broad AI-Scientist or order routes', async () => {
    const cron = await readFile('scripts/cron_openalice_task.sh', 'utf-8')
    const packageJson = JSON.parse(await readFile('package.json', 'utf-8')) as { scripts: Record<string, string> }
    const ethCarryCase = cron.slice(
      cron.indexOf('eth_carry_prospective_tick)'),
      cron.indexOf('continuous_improvement_loop)'),
    )
    const tickScript = packageJson.scripts['research:eth-carry:prospective-tick']
    const statusResearchEvidence = packageJson.scripts['status:research-evidence']

    expect(ethCarryCase).toContain('run_pnpm research:eth-carry:prospective-tick')
    expect(tickScript).toContain('tsx scripts/collect_okx_carry_snapshot.ts')
    expect(tickScript).toContain('tsx scripts/collect_okx_orderbook_spread_snapshot.ts')
    expect(tickScript).toContain('tsx scripts/build_paper_execution_quality.ts')
    expect(tickScript).toContain('tsx scripts/build_paper_execution_producer_contract_status.ts')
    expect(tickScript).toContain('tsx scripts/build_paper_execution_future_telemetry_watchdog.ts')
    expect(tickScript).toContain('tsx scripts/build_runtime_route_cost_budget.ts')
    expect(tickScript).toContain('tsx scripts/build_okx_route_cost_slippage_readiness.ts')
    expect(tickScript.indexOf('tsx scripts/build_paper_execution_future_telemetry_watchdog.ts')).toBeLessThan(
      tickScript.indexOf('tsx scripts/build_runtime_route_cost_budget.ts'),
    )
    expect(tickScript.indexOf('tsx scripts/build_runtime_route_cost_budget.ts')).toBeLessThan(
      tickScript.indexOf('tsx scripts/build_okx_route_cost_slippage_readiness.ts'),
    )
    expect(tickScript).toContain('tsx scripts/build_eth_carry_pit_feature_dataset.ts')
    expect(tickScript).toContain('data/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl')
    expect(tickScript).not.toContain('/Volumes/shield')
    expect(tickScript).not.toContain('binance_usdm')
    expect(tickScript).toContain('tsx scripts/build_eth_carry_pit_audit.ts')
    expect(tickScript).toContain('tsx scripts/settle_eth_carry_prospective_observations.ts')
    expect(tickScript).toContain('tsx scripts/capture_eth_carry_prospective_observation.ts')
    expect(tickScript).toContain('tsx scripts/build_eth_carry_prospective_evidence_status.ts')
    expect(tickScript).toContain('tsx scripts/build_eth_carry_prospective_watchdog.ts')
    expect(tickScript).toContain('tsx scripts/build_strategy_defect_monitor.ts')
    expect(tickScript).toContain('tsx scripts/build_openalice_goal_completion_audit.ts')
    expect(tickScript).toContain('tsx scripts/build_system_status_reason_chain.ts')
    expect(tickScript).not.toContain('pnpm ')
    expect(tickScript).not.toContain('research:ai-scientist:')
    expect(tickScript).not.toContain('data:warehouse:catalog')
    expect(tickScript).not.toContain('paper:cross-sectional')
    expect(tickScript).not.toContain('paper:volume-breakout')
    expect(tickScript).not.toContain('paper:microstructure-stress')
    expect(tickScript).not.toContain('live:order')
    expect(tickScript).not.toContain('place-order')
    expect(tickScript).not.toContain('createOrder')
    expect(statusResearchEvidence).toContain('tsx scripts/build_openalice_data_catalog.ts --allowBlockedExitZero true')
    expect(statusResearchEvidence).toContain('tsx scripts/monitor_openalice_data_downloads.ts')
    expect(statusResearchEvidence).toContain('data/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl')
    expect(statusResearchEvidence).not.toContain('/Volumes/shield')
    expect(statusResearchEvidence).not.toContain('binance_usdm')
    expect(statusResearchEvidence.indexOf('tsx scripts/build_openalice_data_catalog.ts --allowBlockedExitZero true')).toBeLessThan(
      statusResearchEvidence.indexOf('tsx scripts/monitor_openalice_data_downloads.ts'),
    )
  })

  it('keeps archived external automation entry points fail-closed', async () => {
    const cron = await readFile('scripts/cron_openalice_task.sh', 'utf-8')

    expect(cron).toContain('cp_intake|crypto_dl_predict)')
    expect(cron).toContain('archived_manual_only')
    expect(cron).toContain('exit 78')
    expect(cron).not.toContain('run_pnpm cp:intake')
    expect(cron).not.toContain('bash scripts/run_prediction.sh')
  })

  it('ticks OKX private auth and runtime fee snapshot without routing to orders', async () => {
    const cron = await readFile('scripts/cron_openalice_task.sh', 'utf-8')
    const feeAuthCase = cron.slice(
      cron.indexOf('runtime_fee_auth_tick)'),
      cron.indexOf('prospective_evidence_tick)'),
    )

    expect(feeAuthCase).toContain('run_pnpm fees:okx:auth-diagnose')
    expect(feeAuthCase).toContain('run_pnpm fees:runtime:snapshot')
    expect(feeAuthCase).toContain('run_pnpm research:okx:runtime-route-cost-budget')
    expect(feeAuthCase).toContain('run_pnpm research:okx:route-cost-slippage-readiness')
    expect(feeAuthCase.indexOf('run_pnpm fees:runtime:snapshot')).toBeLessThan(
      feeAuthCase.indexOf('run_pnpm research:okx:runtime-route-cost-budget'),
    )
    expect(feeAuthCase.indexOf('run_pnpm research:okx:runtime-route-cost-budget')).toBeLessThan(
      feeAuthCase.indexOf('run_pnpm research:okx:route-cost-slippage-readiness'),
    )
    expect(feeAuthCase).toContain('run_pnpm research:cross-sectional:route-cost:live-fwd72-median-filter')
    expect(feeAuthCase).toContain('run_pnpm research:liquidity-conditioned:live-factors')
    expect(feeAuthCase).toContain('run_pnpm research:candidates:summarize')
    expect(feeAuthCase).toContain('run_pnpm research:incubation-plan')
    expect(feeAuthCase).toContain('run_pnpm research:cross-sectional:prospective-lane:live-fwd72-median-filter')
    expect(feeAuthCase).toContain('run_pnpm status:reason-chain')
    expect(feeAuthCase).not.toContain('paper:cross-sectional')
    expect(feeAuthCase).not.toContain('paper:volume-breakout')
    expect(feeAuthCase).not.toContain('paper:microstructure-stress')
    expect(feeAuthCase).not.toContain('live:order')
    expect(feeAuthCase).not.toContain('place-order')
    expect(feeAuthCase).not.toContain('createOrder')
  })

  it('runs paper policy shadow capture through the launchd-safe pnpm fallback', async () => {
    const script = await readFile('scripts/cron_paper_policy_shadow_capture.sh', 'utf-8')

    expect(script).toContain('run_pnpm()')
    expect(script).toContain('/opt/homebrew/Cellar/node/*/bin/corepack')
    expect(script).toContain('command -v pnpm')
    expect(script).toContain('if run_pnpm paper:policy-shadow:capture -- --json true --outputPath "$REPORT_PATH"; then')
    expect(script).not.toContain('if corepack pnpm paper:policy-shadow:capture')
  })

  it('runs OKX warehouse tasks through the shared launchd-safe pnpm resolver', async () => {
    const script = await readFile('scripts/cron_okx_warehouse_task.sh', 'utf-8')
    const resolver = await readFile('scripts/openalice_pnpm.sh', 'utf-8')

    expect(script).toContain('source "$REPO_ROOT/scripts/openalice_pnpm.sh"')
    expect(script).toContain('openalice_run_pnpm data:okx:warehouse:instrument')
    expect(script).toContain('openalice_run_pnpm data:okx:warehouse:fast')
    expect(script).toContain('openalice_run_pnpm data:okx:warehouse:broad')
    expect(script).not.toMatch(/^\s*corepack pnpm data:okx:/m)
    expect(resolver).toContain('/opt/homebrew/bin/pnpm')
    expect(resolver).toContain('command -v pnpm')
    expect(resolver).not.toContain('corepack enable')
    expect(resolver).not.toContain('corepack prepare')
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

  it('refuses full Binance backfill when macOS system proxy is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-binance-proxy-gate-'))
    const binDir = join(root, 'bin')
    await mkdir(binDir, { recursive: true })
    const scutilPath = join(binDir, 'scutil')
    await writeFile(scutilPath, [
      '#!/usr/bin/env bash',
      'cat <<SCUTIL_PROXY',
      '<dictionary> {',
      '  HTTPEnable : 1',
      '  HTTPProxy : 127.0.0.1',
      '  HTTPPort : 7890',
      '}',
      'SCUTIL_PROXY',
      '',
    ].join('\n'), 'utf-8')
    await chmod(scutilPath, 0o755)

    const result = await runScriptForResult('scripts/run_fast_binance_data_vision_full_backfill.sh', [], {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      BINANCE_BACKFILL_CONCURRENCY: '1',
      BINANCE_BACKFILL_RETRY_CONCURRENCY: '1',
      BINANCE_BACKFILL_LIST_CONCURRENCY: '1',
      BINANCE_BACKFILL_RETRY_ROUNDS: '1',
    })

    expect(result.code).toBe(4)
    expect(result.stderr).toContain('refusing to start Binance backfill because macOS system proxy is enabled')
    expect(result.stderr).toContain('BINANCE_BACKFILL_ALLOW_SYSTEM_PROXY=1')
    expect(result.stdout).toBe('')
  })

  it('suppresses live overlaps and recovers stale orphan cron locks', async () => {
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
      ownerAlive: false,
      lockRecovered: false,
    })

    await writeFile(join(lockDir, 'owner_pid'), `${process.pid}\n`, 'utf-8')
    await writeFile(join(lockDir, 'owner_token'), 'live-owner\n', 'utf-8')
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
      ownerPid: process.pid,
      ownerAlive: true,
      lockRecovered: false,
    })
    expect(String(notification.fullText)).toContain('test_job skipped because a previous run still holds the cron lock')

    await writeFile(join(lockDir, 'owner_pid'), '99999999\n', 'utf-8')
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
      lockHeld: false,
      stale: true,
      ownerPid: 99999999,
      ownerAlive: false,
      lockRecovered: true,
    })
    expect(String(notification.fullText)).toContain('recovered a stale cron lock because its owner process was not alive')
    expect(typeof notification.recoveryPath).toBe('string')
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

function runScriptForOutput(path: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    const child = spawn('bash', [path, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf-8'))
      } else {
        reject(new Error(Buffer.concat(errors).toString('utf-8') || `script exited with ${code}`))
      }
    })
  })
}

function runScriptForResult(path: string, args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    const child = spawn('bash', [path, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(chunks).toString('utf-8'),
        stderr: Buffer.concat(errors).toString('utf-8'),
      })
    })
  })
}
