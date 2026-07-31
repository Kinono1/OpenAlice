# OpenAlice OKX Runtime Repair Manifest — 2026-07-20

## Scope and safety boundary

- Repair window: `2026-07-20` Asia/Shanghai.
- Pre-change backup: `/Users/kino/.local/share/openalice/backups/20260720T061342Z_okx_runtime_repair`.
- The existing dirty worktree was preserved. No `git reset`, `git clean`, bulk rollback, or unrelated formatting was used.
- Runtime remains `research + paper/shadow` only.
- `data/config/agent.json` remains `evolutionMode=false`.
- `data/config/accounts.json` remains an empty account list.
- `gated_improvement_candidate_daily` remains disabled.
- OKX private API, private WebSocket login, margin data, option-chain data, P1 streams, and live trading remain disabled.
- The existing Telegram token was not rotated at the operator's request. `connectors.json` contains no plaintext token and the restricted env file remains the secret source.
- The OpenAlice service was not restarted during this repair. The runtime observation baseline is preserved.

## Incident and repair record

| Incident | Root cause | Targeted repair | Validation | Rollback boundary |
|---|---|---|---|---|
| `okx_instrument_master_refresh_15m` opened its circuit with `OKX instrument is missing instId`. | OKX FUTURES returned a real pre-open placeholder row with an empty `instId`. It was not yet an addressable instrument. | Filter only empty or whitespace-only `instId` placeholders before mapping. Preserve pre-open instruments that already have a valid ID. Keep the mapper fail-closed for invalid identified rows. | Real collector canary completed with 4,534 instruments, zero empty IDs, identified pre-open instruments retained, zero conflicts, and zero errors. The CronEngine-owned job returned to `ok`, `consecutiveErrors=0`, circuit closed. | Restore only `scripts/collect_okx_instrument_master.ts` and its spec from the named backup after review. Do not weaken the mapper or admit anonymous rows. |
| `external_derivatives_data_collect_8h` failed with `Invalid string length`. | Full stablecoin-SWAP history expansion attempted hundreds of instruments in one run, while append, normalize, and audit paths materialized large arrays or whole files. | Rotate through the full universe in batches, default 25 instruments per run; persist `universeSize`, `symbolBatchSize`, `batchCursor`, and `nextBatchCursor`; stream JSONL append, normalize, and audit operations. Add `OPENALICE_EXTERNAL_SYMBOL_BATCH_SIZE` to the wrapper. | Real runs processed a 412-instrument universe in 25-symbol batches. The current run fetched and persisted 31,192 rows with zero errors or conflicts. Normalize processed 65,159 rows with zero drops. The prior `Invalid string length` failure did not recur. | Backed-up collector, wrapper, normalize, and audit files are in the named backup. Restore only named files after disabling the job; do not restore one-shot full-universe materialization. |
| `AI-USDT-SWAP` Rubik history returned `51012 Token does not exist`. | OKX exposes current funding, mark/index, and OI for the instrument, but the Rubik `openInterestHist` and `longShort` histories are unavailable for that token. | Classify only the explicit Rubik `51012 Token does not exist` response for those metrics as `metric_not_available`, `permanent=true`; do not retry, fill zero, fabricate coverage, or fail the whole batch. | A canary run completed with `errors=[]`, retained the unavailable endpoints as evidence, and did not reopen the task circuit. The latest audit remains correctly `partial` with explicit AIUSDT history blockers; it is not promoted to a false `complete`. | Remove only the narrow classification branch to roll back. Do not suppress the audit blockers or convert missing metrics into zero-valued observations. |
| Scheduler health reported Telegram `degraded_missing_secret` outside the launchd environment. | The report inspected only its caller environment, not the restricted OpenAlice env file or the live connector registry. | Read variable-name presence only from a current-user-owned mode-`0600` env file, never return secret values, and prefer the live runtime registry state when available. | `scheduler_health.latest.json` reports `status=pass`; Telegram and Web are `ready`; 32 jobs have no duplicates, error jobs, or open circuits. | Restore `scripts/build_scheduler_health.ts` and its spec only. Never log or return token values while troubleshooting health. |
| Compatibility canary showed every overlapping candle shifted by eight hours. | DuckDB Node returned a zone-less timestamp that Node interpreted as Asia/Shanghai local time although warehouse timestamps are UTC. | Parse zone-less DuckDB timestamps explicitly as UTC and normalize `availableAt` to UTC ISO. Raw warehouse events were not rewritten. | BTC/ETH/SOL/BNB/XRP 5m and 1h comparison produced 1,796 overlapping rows and zero mismatches. | Restore `scripts/materialize_okx_compatibility.ts` and its spec only; do not rewrite warehouse history to compensate for a presentation-layer timezone bug. |
| Compatibility output lagged the latest hourly compaction. | The materializer queried only compacted Parquet, excluding sealed raw segments written since the most recent compaction. | Union compacted Parquet with sealed uncompacted raw JSONL.gz using `UNION ALL BY NAME`, then apply the existing source-priority and timestamp deduplication. | The hot-data canary included uncompacted segments, generated 824 outputs without errors or blockers, and retained zero comparison mismatches. | Remove only the uncompacted-raw union path. Do not increase compaction frequency merely to hide query incompleteness. |
| Three SSD tests failed after the calendar date advanced. | Fixtures wrote segments using the real current clock while their injected `now` was hard-coded to the previous day, so valid segments appeared to come from the future. | Make the test clock relative to `Date.now()` plus one day. Production enrollment, identity, hash, commit, and retention logic was not changed. | The three targeted files passed 12/12 tests; the complete scripts suite passed 1,002 tests with zero failures and three intentional golden skips. | Revert only the three test clock expressions. Do not weaken any production archive eligibility or deletion condition. |

## Files in this repair set

### Runtime and collector logic

- `scripts/collect_okx_instrument_master.ts`
- `scripts/collect_okx_external_derivatives_data.ts`
- `scripts/cron_external_derivatives_data_collect.sh`
- `scripts/normalize_external_derivatives_data.ts`
- `scripts/audit_external_derivatives_data.ts`
- `scripts/build_scheduler_health.ts`
- `scripts/materialize_okx_compatibility.ts`
- `scripts/compare_okx_compatibility_canary.ts`

### Tests

- `scripts/collect_okx_instrument_master.spec.ts`
- `scripts/collect_okx_external_derivatives_data.spec.ts`
- `scripts/cron_external_derivatives_data_collect.spec.ts`
- `scripts/normalize_external_derivatives_data.spec.ts`
- `scripts/audit_external_derivatives_data.spec.ts`
- `scripts/build_scheduler_health.spec.ts`
- `scripts/materialize_okx_compatibility.spec.ts`
- `scripts/lib/okx_ssd_archive.spec.ts`
- `scripts/run_okx_warehouse_retention.spec.ts`
- `scripts/query_okx_warehouse.spec.ts`

Rollback must remain targeted. For files present in the pre-change backup, compare and restore only the named file after stopping its owning task. New implementation files must be removed only after confirming that no package script, Cron job, or evidence path depends on them. Never restore the entire binary diff over the current dirty worktree.

## Verification evidence

### Automated verification

- Targeted SSD regression: 3 files, 12 tests passed.
- Full scripts regression: 193 files total; 190 passed, 3 intentionally skipped; 1,002 tests passed, 3 skipped, 0 failed.
- Repository core/UI regression from the same repair chain: 216 files passed; 2,151 tests passed; 1 skipped.
- TypeScript: `corepack pnpm typecheck` passed.
- Build: OpenTypeBB, IBKR, UI production build, and backend production build passed.
- Patch hygiene: `git diff --check` passed.
- Dirty worktree intentionally preserved: 125 modified/staged paths and 345 untracked paths at the final static check.

### Runtime verification at approximately `2026-07-20T06:49Z`

- `ai.openalice.main`: running, PID `92976`, launchd `runs=5`, last exit code `0`, start time `2026-07-18T12:26:45Z`.
- OpenAlice resident LaunchAgents: only `ai.openalice.main`.
- User crontab: no OpenAlice/OKX entries.
- Scheduler health: `pass`, 32 named jobs, each with one instance, zero error jobs, zero open circuits, zero blockers, zero warnings.
- A sampled `okx_public_broad_refresh_5m` and `okx_public_fast_refresh_1m` fire both naturally reached `ok`; no state was manually edited and no service restart was used.
- Scheduler security audit: `pass`, no findings.
- Connectors: Telegram `ready`, Web `ready`.
- OKX warehouse health: `ready`; 4,534 live instruments; 1,847/1,848 eligible tickers (99.945887%); 427 live swaps; no collector errors, circuits, blockers, hash mismatches, invalid manifests, or conflicting duplicates.
- Local storage: warehouse approximately 1.24 GiB; filesystem free approximately 138.5 GiB; storage state `healthy`.
- Safety: private API call count 0; active private accounts 0; evolution disabled; trade token absent; trading authorization disabled; streams disabled.

Evidence artifacts:

- `data/runtime/okx_market_data_health.latest.json`
- `data/runtime/scheduler_health.latest.json`
- `data/runtime/scheduler_security_audit.latest.json`
- `data/runtime/external_derivatives_data_collect.latest.json`
- `data/runtime/external_derivatives_data_normalize.latest.json`
- `data/runtime/external_derivatives_data_audit.latest.json`
- `data/runtime/verification/okx_compatibility_compare_fixed_20260720T0637.json`
- `data/runtime/verification/okx_compatibility_compare_hot_20260720T0640.json`

## Gates that remain open

### Post-repair 24-hour P0 stability

The previous 24-hour window contained the instrument circuit and its scheduler-security cascade. It cannot be reused as post-repair evidence. The new observation baseline is approximately `2026-07-20T06:29Z` / `2026-07-20T14:29+08:00`. Earliest valid re-check is after `2026-07-21T14:29+08:00`, provided:

- launchd `runs` remains `5` and the service PID/start record shows no unexplained restart;
- instrument, fast, broad, health, compaction, external derivatives, and security jobs stay within freshness bounds;
- no circuit opens and no source-linked fire loses its terminal receipt;
- the compatibility comparison remains zero-mismatch for the required canary symbols.

Until this gate passes:

- do not enable the production compatibility materializer;
- do not remove the legacy 5m, 1h, or freshness jobs;
- do not remove legacy data;
- keep the REST 1s collector;
- keep P1 WebSocket streams disabled;
- keep candidate-mode evolution disabled.

### Physical SSD enrollment and archive

Current SSD state is `not_enrolled`: no mount, UUID, archive ID, writable target, or committed batch exists. Pending archive data is approximately 820,490,817 bytes across 16,402 files, with the earliest pending date `2018-08-28`.

- `/Volumes/shield` was not created as an ordinary directory.
- No local source file is eligible for deletion before a real enrolled volume, committed batch, size/hash/Parquet/manifest verification, and retention eligibility.
- First enrollment, dry-run archive, first real archive approval, and restore drill remain physical/user gates.
- The Monday follow-up reminder remains scheduled for `2026-07-20T20:00+08:00`; it was not manually sent early.

### Known partial data evidence

The external derivatives audit remains `partial` for `AI-USDT-SWAP` Rubik `openInterestHist` and global long/short history. This is an explicit upstream metric-availability limitation, not a fabricated complete dataset and not a reason to retry the whole universe at high frequency.

