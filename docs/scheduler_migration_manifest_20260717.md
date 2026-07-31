# OpenAlice scheduler migration manifest

- Migration time: `2026-07-17` (Asia/Shanghai)
- Source backup: `/Users/kino/.local/share/openalice/backups/20260717T024655Z`
- Runtime boundary: research plus paper/shadow only; live trading remains disabled.
- Rollback policy: restore only the named scheduler registration from the backup after manual review. Do not restore the entire dirty worktree and do not use `git reset` or `git clean`.

| Original scheduler/task | Action | Reason | Replacement | Rollback |
|---|---|---|---|---|
| User crontab managed block | Remove whole managed block | OpenAlice CronEngine is the single business scheduler | Internal deterministic script jobs | Restore `crontab.before.txt`, then manually re-add only the required line(s) |
| `paper_pnl_diagnostics` crontab | Remove | Duplicates the internal 30-minute job | `paper_pnl_diagnostics_30m` | Re-add the saved crontab line only if the internal job is disabled |
| `refresh_market_intel_context` crontab | Remove | Migrated to internal scheduler | `market_intel_refresh_15m` | Disable internal preset before restoring the saved line |
| CurrencyPurchases `cp_intake` crontab | Stop and archive | Bridge is stale and the task is not part of the approved OpenAlice runtime | None; manual re-enable only after bridge review | Restore the saved crontab line after an explicit bridge-health approval |
| `ai.openalice.okx-market-data` | Bootout and remove plist | Duplicates internal OKX collection and was exiting with code 1 | Internal OKX 1h/5m/1s/freshness jobs | Copy backed-up plist to `~/Library/LaunchAgents`, then `launchctl bootstrap gui/$UID <plist>` after disabling replacements |
| `ai.openalice.low-vol-observer` | Bootout and remove plist | Hard-coded external disk and produced misleading zero-data output | `low_vol_research_daily` | Restore only after disabling the internal job; the old external-disk path remains unsupported |
| `ai.openalice.microstructure-stress` | Remove unloaded plist | Stale external registration | Internal `microstructure_stoploss_replay_hourly` | Restore backed-up plist only after disabling the internal job |
| `ai.openalice.paper-monitor` | Remove unloaded plist | Stale external registration | Internal paper/shadow jobs | Restore backed-up plist only after disabling the internal jobs |
| `com.openalice.crypto.fast-binance-spot-klines` | Remove unloaded plist | Retired Binance automation entry | Canonical OKX collectors | Restore only for an explicitly approved offline historical workflow |
| Binance Futures online derivatives | Retire HTTP source, preserve historical files | HTTP 451 and venue/source ambiguity | OKX public derivatives under the same logical job name | Switch the wrapper command manually; never relabel old Binance rows as OKX |
| Unrestricted continuous improvement schedule | Keep disabled | Could mutate best config/risk/runtime artifacts | Gated observe/candidate/promote workflow; candidate Cron disabled until 24-hour stability | No automatic rollback to unrestricted mode; manual invocation requires a new safety review |

Historical paper ledgers, Binance raw history, model files, research artifacts, CurrencyPurchases logs/bridge state, and execution IDs are not deleted by this migration.

## Follow-up implementation record

The following targeted repairs were completed after the scheduler registrations were converged. They do not relax the research plus paper/shadow boundary.

| Area | Implemented state | Evidence and rollback boundary |
|---|---|---|
| Cron overlap and stale locks | Every retained script job has one internal owner and one lock. Orphaned stale locks are moved to `data/runtime/lock_recovery/` before a replacement lock is acquired; a live owner still causes an overlap skip. | Keep recovery artifacts as diagnosis evidence. Roll back only the lock helper change; never delete a live lock to force a run. |
| ETH carry and derivatives venue | Daily carry refresh normalizes/audits canonical OKX derivatives rows and exports OKX BTC/ETH funding histories. `external_derivatives_data_collect_8h` uses the OKX collector while retaining the generic downstream job name. | Historical Binance rows remain source-labelled and read-only. Restoring Binance Futures REST requires a separate venue review and must not relabel old data. |
| Runtime data root | Internal wrappers default `OPENALICE_DATA_ROOT` to the repository-local `data` directory. External storage is allowed only through an explicit operator-supplied override for offline work. | Do not restore an implicit `/Volumes/shield` runtime default. An offline override must be named in the manual command. |
| Runtime online market clients | The shared live market fetcher and manual multi-asset/live download helpers are OKX-only. The embedded Binance Futures `fapi.binance.com` client was removed so enabled OKX tasks cannot inherit a retired online client through an import. | Binance Data Vision scripts remain available as explicit offline historical workflows. |
| CoinMetrics canonical data | CoinMetrics Community BTC/ETH asset metrics now land under `data/onchain/coinmetrics` and `data/normalized/onchain/coinmetrics`; collect, normalize, and audit reports are complete. | Preserve the raw and normalized append logs. Re-run through the canonical collect/normalize/audit commands instead of editing rows in place. |
| CoinMetrics PIT visibility | `availableAt` is the actual observation/fetch time, not the historical metric event time. | Never reconstruct `availableAt` from an old `eventTime`; that would introduce look-ahead evidence. |
| AI-Scientist warehouse contract | Required layers are `market`, `external/derivatives`, `normalized`, `manifests`, `derived`, `runtime`, and `research`. `onchain` and `metadata` are candidate-dependent; logs are operational optional; Binance public history is offline manual. | This is an intake contract only. PIT, WFO/OOS, FDR, cost, risk, prospective, paper telemetry, and human approval gates remain mandatory. |
| Offline Binance inventory | All 81 planned Binance Data Vision datasets remain in the catalog as `lifecycle=offline_manual` and `runtimeBlocking=false`. Default runtime health does not treat their missing backfills as a blocker. | Use `--monitorOfflineBackfills true` for a strict manual historical-backfill audit; do not delete inventory records. |
| Normalized candidate placeholder | The zero-row AI-Scientist PIT input is classified as `candidate_placeholder`, not as broken normalized infrastructure. It remains fail-closed for candidate readiness. | Do not fill it with synthetic rows or mark it complete without a real candidate and PIT lineage. |
| Evidence manifest integrity | The OKX collector writes its final report once and hashes that final content. Runtime manifest audit currently has 29 required artifacts, 29 present manifests, 29 matching hashes, zero mismatches, and zero invalid manifests. | All 29 remain `evidenceTrust=quarantine` because the worktree is dirty; hash coverage must not be presented as promotion trust. |
| Proposal and IC runtime persistence | Config proposal paths and IC snapshot paths resolve the current data root at call time. IC snapshots use serialized atomic temp-write plus rename and complete before the strategy evaluation returns. | `applyConfigProposal()` remains prohibited; this repair does not authorize automatic production config mutation. |
| Enabled runtime call graph | The 20 enabled jobs were expanded through their wrappers, selected task cases, 51 package scripts, and 183 local entry/import files. No enabled path contains an external-volume default or an online Binance Futures host. `binance_usdm_http_451` remains only as retired-source metadata. | Re-run the enabled call-graph audit after changing a job, wrapper, package script, or shared market-data import. Do not infer runtime failure from historical/offline files elsewhere in the repository. |

## Current post-migration gates

- Internal Cron store: 21 named jobs, 20 enabled, no duplicate names. `gated_improvement_candidate_daily` is the only disabled job and must remain disabled until the post-restart 24-hour stability gate passes.
- Scheduler security audit: no OpenAlice crontab entries, no retired LaunchAgent plist, no second resident OpenAlice service, no circuit-open job, and no plaintext Telegram token in connector config.
- Execution boundary: account count is zero, enabled account count is zero, `agent.evolutionMode=false`, and no trade token is configured. The release gate remains `NO_GO`; paper/live execution flags remain false.
- Data governance: default catalog excludes offline Binance download gaps from runtime blockers; CoinMetrics is complete; active normalized PIT field coverage is 100%; candidate/trust/promotion blockers remain intentionally active.
- Telegram: the operator explicitly deferred BotFather rotation and chose to reuse the existing `@DDTmet_bot` token. The token is stored only as `TELEGRAM_BOT_TOKEN` in the mode-`0600` env file; `connectors.json` contains only `botTokenEnv`. Because OpenClaw remains the polling owner for the same bot, OpenAlice runs it in `outbound_only_shared_bot` mode with inbound polling and command registration disabled. The residual risk that this historical token was previously exposed is accepted for now.

## Final controlled restart and observation baseline

This section is populated only from the final controlled `launchctl kickstart -k` and its immediate probes. The restart establishes the observation baseline; it does not itself satisfy the 24-hour acceptance gate.

| Field | Value |
|---|---|
| Controlled restart time | `2026-07-18T06:33:18Z` / `2026-07-18T14:33:18+08:00` (final restart after enabling shared-bot outbound delivery) |
| LaunchAgent wrapper PID | `39742` |
| Node PID(s) | `39757` (child runtime serving MCP/Web) |
| LaunchAgent runs | `8` |
| Approximate restart count | `7` (historical launchd runs minus the initial run; this is the post-restart baseline, not a new fault) |
| Last exit code | `143` from the deliberate preceding `kickstart -k`; the replacement service is running and healthy |
| Web health/readiness | `/api/health` HTTP 200 `status=ok`; `/api/readiness` HTTP 200 `ready=true` |
| Listening ports | Node PID `39757`: TCP `3001` MCP and `3002` Web |
| Telegram | `ready`, detail `outbound_only_shared_bot`; manual push probe at `2026-07-18T06:34:02.750Z` returned `delivered=true`, reason `delivered`, HTTP 200 |
| Scheduler health | `pass`, zero blockers and zero warnings |
| Scheduler security | `pass`, no findings; one resident label `ai.openalice.main`, no duplicate jobs, no circuit-open jobs, writable repo-local data root |
| 24-hour observation start | `2026-07-18T06:33:18Z`; earliest full acceptance check is after `2026-07-19T06:33:18Z` if `runs=8` and restart count remain unchanged |

Immediate post-restart verification also confirmed 21 internal jobs, 20 enabled, no duplicates, no consecutive errors, and no open circuit. `gated_improvement_candidate_daily` remains disabled. Accounts remain empty, `evolutionMode=false`, no trade token is configured, and the release gate remains `NO_GO` with paper/live trading false.

The shared-bot mode is intentionally outbound-only. OpenClaw continues to own Telegram long polling and inbound commands; OpenAlice only performs `getMe` readiness checks and outbound `sendMessage` calls. This avoids Telegram `getUpdates` conflict errors while allowing Heartbeat, Cron, and manual notifications to use the existing bot. Rotating the historical token remains recommended but is not required by the operator's current availability decision.
