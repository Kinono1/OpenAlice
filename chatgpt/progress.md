# OpenAlice Progress

Last updated: `2026-03-18`

## Read This First

When a new Codex session starts for OpenAlice, load these files in this order:

1. `chatgpt/Memory.md`
2. `chatgpt/task_plan.md`
3. `chatgpt/findings.md`
4. `chatgpt/progress.md`

These four files are the canonical lightweight handoff set for this repo.

## Update Rules

- Every OpenAlice-related session must update at least one of these four files before ending.
- `Memory.md` stores stable truths and operating rules.
- `task_plan.md` stores the current plan and immediate next steps.
- `findings.md` stores failures, successes, constraints, and evidence-backed lessons.
- `progress.md` stores chronological milestone updates.
- Do not treat chat context as memory. If it matters later, write it here.
- Prefer updating existing sections over creating duplicate sections with the same meaning.
- Keep this file append-only in the milestone log section unless a statement is factually wrong.

## Current Snapshot

### Repo state
- OpenAlice is past the “blank framework” stage and has a functioning runtime, UI, connectors, crypto execution path, risk checks, and research pipeline.
- The repo remains dirty, but a first hygiene pass already cleaned the highest-noise temp files, archived old G3/G4 documents, archived legacy strategy-loop scripts, and removed stale `package.json` command entrypoints for archived legacy loops.

### Runtime state
- `BTC/USD + demoTrading=true` is the current safe runtime baseline.
- `web + telegram + heartbeat + /api/chat` were previously validated as healthy in the active runtime path.
- Trade permission was confirmed with a minimal real `WIF/USD` round-trip.
- `data/crypto-trading/pnl-fills.jsonl` is non-empty and was validated through TypeScript restore plus full-process restart.

### Research state
- Old direction-prediction candidate path failed:
  - `v1` failed
  - `v2` was worse
  - `selective-inference` did not rescue the path
- Architecture review selected `feature_horizon_redesign`.
- Target scan selected `target_realized_vol_1h` as the best-supported next target.
- That target is only allowed as a `gating / regime` target, not a direct buy/sell target.
- First seed family (`vol_gated_breakout_seed`) gave a sanity-level improvement in Round 1, then collapsed in Round 2.
- Round 4 mapping tooling now exists in code and can generate / evaluate:
  - `vol_as_no_trade_filter`
  - `vol_as_breakout_enable_flag`
  - `vol_as_trend_enable_flag`
- The first full Round 4 run promoted `vol_as_no_trade_filter` as the next refinement candidate, but the planning mainline has since downgraded it to a regime-control component rather than the final paper endpoint.
- The first runtime implementation slice for the paper-first program now exists:
  - `PaperChampionRegistry`
  - `paperGate`
  - `paper/live` release-gate split
- The second runtime contract slice now also exists:
  - `DataContract`
  - `ExecutionSemanticsContract`
- A first `runtime-faithful simulation` path now exists in code and can emit a machine-readable replay artifact plus `paperGate` snapshot from a champion registry and CSV market data.
- A first automatic `OKX demo paper executor` cycle now exists in code and can convert simulation commits into wallet `add -> commit -> push` operations with journal dedupe.
- The final bounded directional falsification sprint is now complete:
  - `volBreakout` remained `NO_GO` under `regime_segmented_bh`, `cv_storey_bh`, and `stability_bh`
  - `volTrend` remained `NO_GO` under the same 3 allowed variants
  - no exploratory `GO` appeared, so no canonical rerun or promotion lane was entered
- `cv_storey_bh` improved `volBreakout` `fdrQ` to `0.041666...`, but `meanPbo` and `meanDsrProbability` still failed by a wide margin.
- The current directional `BTC/USD 1h` family line should now be treated as closed.
- Binance-linked fields still fail to appear in final target tables, but the newest evidence reframes the blocker:
  - current local Binance raw shards stop at `2026-02`
  - repo-native `2026-03` monthly refresh attempt returned `missing=6`
  - cross-venue work is therefore blocked by source-window freshness, not by a proven runtime bug

## Milestone Log

### 2026-03-26 — OpenAlice integration design v1 started
- User explicitly chose the new mainline direction:
  - enhance `OpenAlice`
  - use it as the host platform that can absorb the strongest ideas from the other crypto repos
- Reviewed the current OpenAlice continuity pack again:
  - `chatgpt/Memory.md`
  - `chatgpt/task_plan.md`
  - `chatgpt/findings.md`
  - `chatgpt/progress.md`
- Inspected current repo structure to ground the integration plan in actual boundaries:
  - `src/core/`
  - `src/extension/`
  - `src/runtime/`
  - `src/connectors/`
  - `src/openbb/`
  - `src/live/`
  - `src/portfolio/`
- Wrote the first formal integration design document:
  - `chatgpt/openalice_integration_plan_v1.md`
- Chosen host-platform decision:
  - `OpenAlice` stays the system backbone
  - external repos should contribute capability patterns, not be copied wholesale
- Chosen integration order:
  1. absorb `TradingAgents-crypto` ideas into a `research-desk` extension
  2. absorb `CryptoTrade` reflection ideas into a `reflection-engine`
  3. absorb `alphaswarm` execution-routing ideas later, after analysis/review is stable
- Recommended first implementation slice:
  - `research-desk` for crypto decision support with structured output packets and event-log persistence


### 2026-03-18 — Final bounded directional pass completed; no activation
- Generated final exploratory `12`-candidate packs for:
  - `volBreakout`
  - `volTrend`
- Reused the existing Round 4 pack schema and preserved:
  - `dataset`
  - `thresholds`
  - `wfo`
  - `significance`
  - `riskSimulation`
  - `costModel`
- Executed the maximum allowed bounded methodology matrix:
  - `regime_segmented_bh + change_point + stable`
  - `cv_storey_bh + change_point + stable`
  - `stability_bh + change_point + stable`
- All `6` runs ended `NO_GO`.
- Best observed partial improvement:
  - `volBreakout` under `cv_storey_bh`
  - `fdrQ=0.041666...`
  - but `meanPbo=0.642857...`
  - and `meanDsrProbability≈1.83e-13`
- `volTrend` remained far from promotion thresholds across all 3 variants:
  - `meanPbo≈0.985714...`
  - `meanDsrProbability≈0.002087...`
- No exploratory `GO` appeared, so:
  - no clean-clone canonical rerun was attempted
  - no promotion was attempted
  - no `paper_champion_registry.json` was created
- Artifacts written under:
  - `/tmp/openalice-research-final/`
  - including `track_a_summary.json`
  - and `track_a_closure_note.md`

### 2026-03-18 — Binance refresh path verified blocked at source window
- Re-ran the Binance alignment diagnosis to:
  - `/tmp/openalice-trackb/binance_alignment_diagnosis.v1.json`
- Result remained:
  - `keep_arbitrage_closed`
- Ran the repo-native Binance monthly downloader for:
  - `BTCUSDT`
  - `ETHUSDT`
  - `SOLUSDT`
  - `spot + um`
  - `1m`
  - `2026-03`
- Download result:
  - `files=6`
  - `missing=6`
  - `failed=0`
- Verified current local Binance raw shards still stop at:
  - `2026-02`
- Wrote Track B preflight artifact:
  - `/tmp/openalice-trackb/track_b_preflight.json`
- Conclusion:
  - this round did not justify normalize/rebuild work because no new raw Binance month was available to ingest

### 2026-03-17 — Full-repo regression completed
- Completed full-repo regression across both TypeScript and Python paths.
- JavaScript / TypeScript regression result:
  - `corepack pnpm test`
  - passed
  - `72` test files passed, `611` tests passed, `1` skipped
- Python regression result:
  - `python3 -m pytest scripts/tests/archive/legacy-research -q`
  - passed
  - `36` tests passed
  - `python3 -m pytest scripts/tests -q`
  - passed
  - `144` tests passed
- Final unified repo-native regression result:
  - `corepack pnpm run test:all`
  - passed
- Fixed the repo test entrypoint so the unified test command works in the current environment:
  - updated `package.json`
  - `test:py` now uses `python3 -m pytest scripts/tests -q`
  - `test:all` now uses `corepack pnpm test && corepack pnpm run test:py`
- Fixed archived Python regression tests to follow the current repo layout after the strategy scripts were moved under:
  - `scripts/archive/legacy-research/`
- Updated these archive tests so they resolve the correct repo root and archived script paths:
  - `test_run_g3g4_multi_asset_matrix.py`
  - `test_strategy_g3g4_failure_breakdown.py`
  - `test_strategy_g3g4_iteration.py`
  - `test_strategy_local_param_search.py`
  - `test_strategy_phaseb_family_search.py`
  - `test_strategy_protocol_ablation.py`
- The takeover tooling tests still pass after the regression fixes:
  - `python3 scripts/takeover/validate_openalice_takeover.py`
  - `python3 -m pytest scripts/tests/test_takeover_tooling.py -q`

### 2026-03-17 — Remaining takeover backlog items completed with tests
- Completed the `decision_packet/` support-boundary cleanup and wrote:
  - `docs/takeover/openalice/decision_packet_boundary.md`
- The current conclusion is now explicit:
  - `decision_packet/` is support / legacy-live governance output
  - not archive
  - not the current runtime execution root
- Completed the `openclaw/` boundary clarification and wrote:
  - `docs/takeover/openalice/openclaw_boundary.md`
- The current conclusion is now explicit:
  - `src/openclaw/` is a support subsystem
  - current mainline only touches it through `src/extension/browser/adapter.ts`
- Updated takeover artifacts so these two items are no longer left ambiguous:
  - `docs/takeover/openalice/backlog.md`
  - `docs/takeover/openalice/module_classification.md`
  - `docs/takeover/openalice/takeover.md`
  - `docs/takeover/openalice/validation_checklist.md`
- Extended the takeover validator required file set to include:
  - `decision_packet_boundary.md`
  - `openclaw_boundary.md`
- Added explicit takeover tooling tests:
  - `scripts/tests/test_takeover_tooling.py`
- Verification completed for this checkpoint:
  - `python3 scripts/takeover/validate_openalice_takeover.py`
  - `python3 -m pytest scripts/tests/test_takeover_tooling.py -q`
- Result:
  - the previously remaining `P2` and `P3` takeover backlog items are now completed

### 2026-03-17 — Takeover follow-up deep reads and automation completed
- Extended the takeover pilot pack with deeper runtime and execution documents:
  - `docs/takeover/openalice/runtime_executor_deep_dive.md`
  - `docs/takeover/openalice/dispatcher_hard_gates.md`
  - `docs/takeover/openalice/live_gate_governance.md`
  - `docs/takeover/openalice/strategy_runtime_semantics.md`
- The two original `P0` takeover backlog items are now documented to a deeper, operator-useful level:
  - runtime contracts to paper executor boundary
  - dispatcher hard gates and replay-safe execution
- The two `P1` understanding items are also now documented:
  - `LiveGateManager` governance role split
  - strategy-family to runtime semantics boundary
- Added minimal takeover automation under:
  - `scripts/takeover/validate_openalice_takeover.py`
  - `scripts/takeover/check_watchlist.py`
- Added the first GitHub Actions workflow for takeover checks:
  - `.github/workflows/openalice-takeover.yml`
- The takeover validator now passes locally against the current `docs/takeover/openalice/` pack.
- The watchlist checker also runs locally and emits refresh hints from the current working tree.
- Updated takeover docs to keep the evidence model consistent:
  - `drift` is treated as an evidence relationship, not an evidence source class
  - every validated markdown doc now carries summary / scope / evidence / stop reason sections
- Remaining documented follow-up after this round is now mainly:
  - `decision_packet/` ambiguity cleanup
  - `openclaw/` boundary clarification maintenance

### 2026-03-17 — Takeover pilot documentation set created
- Added a first repo-local takeover pilot pack under:
  - `docs/takeover/openalice/`
- The pilot pack now includes:
  - `takeover.md`
  - `system_assembly.md`
  - `runtime_sequence.md`
  - `layered_safety.md`
  - `artifact_translation.md`
  - `module_classification.md`
  - `backlog.md`
  - `validation_checklist.md`
  - `watchlist.txt`
  - `calibration_note.md`
- Locked the current pilot framing to:
  - `single-mainline`
  - `full profile`
  - `explicit continuity pack`
- Recorded the paper-first runtime chain as the current executable mainline:
  - champion registry
  - release gate
  - paper gate
  - runtime-faithful simulation
  - paper executor
  - wallet / dispatcher / CCXT execution
- Captured the layered safety map around:
  - runtime gates
  - wallet staging
  - dispatcher hard gates
  - risk policy
  - exchange adapter
  - reconciliation / daily governance
- Explicitly classified `openclaw/` as a support subsystem boundary rather than the current trading runtime core.
- Added the first takeover watchlist draft so future changes to:
  - composition root
  - runtime gates
  - execution entrypoints
  - continuity anchors
  can be surfaced as takeover refresh hints.
- Recorded a first calibration note with:
  - per-phase RU/TU/AU usage
  - stop reasons
  - budget fit notes
  - unnecessary overhead observations

### 2026-03-17 — Codebase re-orientation pass completed
- Re-read the canonical OpenAlice handoff pack before code inspection:
  - `chatgpt/Memory.md`
  - `chatgpt/task_plan.md`
  - `chatgpt/findings.md`
  - `chatgpt/progress.md`
- Re-mapped the active runtime composition around `src/main.ts` and confirmed the current bootstrap path is:
  - config load
  - tool registration
  - provider routing
  - connector registration
  - event log / cron / heartbeat startup
  - delayed crypto engine injection
- Confirmed the dual-provider split:
  - Claude Code CLI path uses `SessionStore` + compaction + `<chat_history>` prompt assembly
  - Vercel AI SDK path uses `ToolLoopAgent` + hot-reloaded model/tool selection
- Confirmed current paper-first runtime path is now real code, not only docs:
  - `paper_champion_registry`
  - `paper_gate_status`
  - `data_contract`
  - `execution_semantics`
  - `runtime_faithful_simulation`
  - `paper_demo_executor`
- Confirmed crypto execution remains a layered audited path rather than direct exchange calls:
  - wallet
  - dispatcher
  - tickets / intent ledger / idempotency / kill switch
  - pre-trade risk
  - live gate hooks
  - exchange engine
- Confirmed `openclaw/` is mainly an embedded browser/agent subsystem; current OpenAlice mainline directly pulls it in through `extension/browser/adapter.ts`, not as the central trading runtime.
- Confirmed the web UI is a thin local control surface over the same file-driven backend contracts:
  - `/api/chat`
  - `/api/config`
  - `/api/events`
  - SSE push delivery
  - session JSONL persistence

### 2026-03-14 — Canonical handoff policy locked
- Added an explicit repo-local handoff rule to `chatgpt/Memory.md`.
- Rewrote `chatgpt/README_ARCHIVED.md` so it no longer overrides the active repo-local handoff pack.
- Added machine-readable handoff policy:
  - `chatgpt/handoff_policy_v1.json`
- Locked conflict resolution so future Codex sessions should prefer:
  - `Memory.md`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`
  over `README_ARCHIVED.md`.

### 2026-03-14 — Paper-first runtime slice 1 implemented
- Added runtime support for `PaperChampionRegistry` loading and validation.
- Added runtime support for `paperGate` status evaluation and persistence.
- Split release-gate blocking semantics into:
  - paper blocking via `allowPaperTrading`
  - live blocking via `allowLiveTrading`
- Wired `LiveGateManager` so `demoTrading=true` uses paper gate semantics instead of live gate semantics.
- Added targeted runtime tests covering:
  - `paper_champion_registry`
  - `paper_gate_status`
  - `release_gate_status`
  - `live_gate_manager`

### 2026-03-14 — Paper-first runtime slice 2 implemented
- Added runtime contract modules for:
  - `DataContract`
  - `ExecutionSemanticsContract`
- Extended the live market bar shape so runtime market-context providers can carry:
  - `tsOpenMs`
  - `barIntervalMs`
  - `barCloseMs`
  - `completed`
  - `sourceDomain`
- Added targeted runtime tests covering:
  - `data_contract`
  - `execution_semantics`

### 2026-03-14 — Runtime-faithful simulation slice implemented
- Added a reusable runtime simulation module that consumes:
  - `PaperChampionRegistry`
  - `paperGate`
  - `DataContract`
  - `ExecutionSemanticsContract`
- Added a CLI entrypoint for machine-readable simulation artifacts:
  - `scripts/run_runtime_faithful_simulation.ts`
- Verified the CLI with a temporary champion registry + CSV replay and confirmed it emitted:
  - simulation artifact JSON
  - `paper_gate_status.json`
- Added targeted runtime tests for:
  - `runtime_faithful_simulation`

### 2026-03-14 — Demo paper executor slice implemented
- Added a persistent journal for executed simulation commits:
  - `paper_executor_journal`
- Added a reusable paper executor module that:
  - selects unexecuted simulation commits
  - injects tickets and idempotency keys
  - drives wallet `add -> commit -> push`
- Added a CLI entrypoint for one-shot executor cycles:
  - `scripts/run_paper_demo_executor_cycle.ts`
- Added targeted runtime tests for:
  - `paper_executor_journal`
  - `paper_demo_executor`

### 2026-03-14 — Handoff policy aligned with `skills-kino`
- Updated the local repo handoff rules so `OpenAlice/chatgpt` is explicitly treated as a `flat` canonical workspace mode.
- Added machine-readable `handoff_policy_v1.json` fields needed by the generalized governance skill.
- Updated the shared `skills-kino/core-agent/chatgpt-workspace-governance` skill so it now supports:
  - `flat`
  - `projects`
  workspace modes
- Verified that:
  - temporary `flat` workspaces validate
  - temporary `projects` workspaces validate
  - the current OpenAlice repo validates under the new governance rules

### 2026-03-13 — Round 4 tooling implemented and first full run completed
- Added public strategy support for:
  - `volNoTradeFilter`
  - `volBreakout`
  - `volTrend`
- Added Round 4 candidate generation and runner scripts:
  - `scripts/stage_c_round4_candidate_generator.py`
  - `scripts/stage_c_round4_mapping_runner.py`
- Generated the first three Round 4 candidate packs under `docs/research/`.
- Ran the full Round 4 mapping comparison and wrote outputs to:
  - `data/research/strategy/analysis/stage_c/round4/latest_round4_summary.v1.json`
  - `chatgpt/round4_mapping_decision_latest.md`
- First full Round 4 result:
  - decision: `promote_mapping`
  - selected mapping: `no_trade`
  - caution: promoted pack still remained overall `NO_GO`

### 2026-03-13 — Paper-first contract set frozen
- Added root planning contracts to stop further “spec drift by prose”:
  - `chatgpt/alpha_contract_v1.md`
  - `chatgpt/runtime_contract_v1.md`
  - `chatgpt/paper_acceptance_v1.md`
  - `chatgpt/reproducibility_fingerprint_v1.md`
- Added `chatgpt/operator_playbook_v1.md` to make pause/resume, rollback, and champion activation rules explicit.
- Reframed the next milestone away from standalone no-trade refinement and toward directional family promotion for automatic OKX demo paper trading.

### 2026-03-12 — ChatGPT handoff system created
- Created the persistent `chatgpt/` handoff pack for OpenAlice.
- Established canonical load order and update rules.
- Consolidated prior conversation outputs into:
  - stable memory
  - active task plan
  - findings ledger
  - progress log

### 2026-03-11 — Repo hygiene pass completed
- Removed temporary `tmp/*` artifacts created during prior WIF and sweep testing.
- Archived superseded G3/G4 and “latest/ghost/phaseb” research docs under `docs/research/archive/`.
- Archived legacy G3/G4 / Phase-B strategy scripts and paired tests under `scripts/archive/legacy-research/`.
- Cleaned `package.json` by removing command aliases that pointed to archived legacy strategy-loop scripts.
- Deferred packet-builder cluster cleanup because `package.json` still references those scripts directly.

### 2026-03-11 — Round 4 architecture decision recorded
- Wrote the new round 4 architecture review memo.
- Replaced “deepen the breakout seed” as the active next step with “redefine target-to-trade mapping”.
- Locked the next mapping-comparison sprint to:
  - `vol_as_no_trade_filter`
  - `vol_as_breakout_enable_flag`
  - `vol_as_trend_enable_flag`

### 2026-03-11 — Stage-C rounds 1 to 3 completed
- Implemented and tested the `volBreakout` strategy family.
- Ran seed family Round 1:
  - `fdrQ` materially improved
  - `PBO` and `DSR` remained unacceptable
  - decision: `keep_seed`
- Ran seed family Round 2:
  - sanity improvement collapsed
  - decision: `kill_seed`
- Ran Binance alignment diagnosis:
  - raw and normalized Binance data exist
  - final target tables still carry no effective Binance-linked fields
  - decision: `keep_arbitrage_closed`
- Round 3 decision:
  - `return_to_architecture_review`

### 2026-03-11 — Real trade evidence and recovery validation completed
- Executed a minimal real `WIF/USD` round-trip to confirm trade permission.
- Generated the first real non-empty `pnl-fills.jsonl`.
- Fixed OKX `posSide` handling for `long_short_mode`.
- Fixed `pending -> filled` sync so fills are written back to `pnl-fills.jsonl`.
- Verified TypeScript `PnLTracker.restoreFromDisk()` restores historical `WIF/USD` fills even when current `allowedSymbols` is only `BTC/USD`.
- Verified non-empty fill restart recovery end-to-end.
- Restored the system to `BTC/USD + demoTrading=true`.

### 2026-03-11 — Architecture review and feature-horizon redesign finalized
- Confirmed that runtime is not the main blocker.
- Confirmed the main blocker is strategy abstraction / target mapping, not execution reliability.
- Chose `feature_horizon_redesign` over `candidate_redesign` and `pipeline_bug_reopen`.
- Materialized redesigned target tables for `BTC / ETH / SOL`.
- Added the target-to-trade mapping doc stating `realized_vol_1h` must be treated as a gating target.

## What Is Done vs Not Done

### Done
- Runtime health and demo baseline restoration
- Real trade permission confirmation
- Non-empty fill generation
- Non-empty fill restore validation
- Stage-C architecture review
- Initial target scan and target table materialization
- Seed family Round 1 and Round 2
- Binance alignment diagnosis
- First repo hygiene pass

### Not done
- No automatic live trading
- No `decision_packet` rebuild toward a new `G3` challenge
- No repaired Binance merge/alignment path
- No stable promoted single-venue strategy path
- No reopened arbitrage path
- No validated post-round4 mapping winner yet

## Current Recommended Direction

The current best next move is:

- keep the current scope at `OKX + BTC/ETH/SOL + 1h + long-only + demoTrading=true`
- do not widen candidate families beyond the 3 directional gated families in `alpha_contract_v1.md`
- do not reopen direct forward-return prediction
- do not reopen cross-venue research yet
- move from abstract Round 4 mapping work into directional champion selection plus runtime-faithful simulation

## Session Close Rule

Before ending any future related session:

1. update `task_plan.md` if priorities changed
2. update `findings.md` if a new success/failure/constraint was learned
3. append a milestone here in `progress.md`
4. update `Memory.md` only if a fact is stable enough to matter across sessions

### 2026-03-18 — Governance-compliant paper promotion bridge implemented
- Removed runtime-side `release_gate_status` rewrites from `run_paper_demo_executor_cycle.ts`.
- Added release-gate provenance classification so promotion can reject runtime-owned gate snapshots.
- Added shared runtime version constants plus promotion metadata hashing/build helpers.
- `run_strategy_mvp_validation.ts` now emits:
  - `promotionMetadataReady`
  - `promotionMetadata`
  - `promotionMetadataBlockingReasons`
- Added lawful paper champion promotion path:
  - `src/runtime/paper_champion_promotion.ts`
  - `scripts/promote_paper_champion.ts`
- Promotion now blocks explicitly on:
  - `NO_GO`
  - dirty git worktree
  - non-research-owned release gate
  - missing promotion metadata
  - unsupported family (for example `volNoTradeFilter`)
- Added OpenBB-to-yfinance crypto symbol fallback plus partial-row filtering so:
  - `BTC/USD` now resolves through OpenBB live context
  - data contract now passes in real diagnostic runs
- Real diagnostic state is now:
  - data contract: `PASS`
  - release gate: `blocked`
  - champion registry: `missing`
- Full JS/TS regression passed after the promotion bridge changes.

### 2026-03-18 — Directional activation run completed
- Ran isolated activation validations from the current repo root against:
  - `docs/research/stage_c_round4_candidates.breakout_enable_flag.v1.json`
  - `docs/research/stage_c_round4_candidates.trend_enable_flag.v1.json`
- Both runtime-supported directional families remained `NO_GO`.
- Breakout activation result:
  - verdict: `NO_GO`
  - champion: `STC_R4_VB_1`
  - `promotionMetadataReady=false`
  - `releaseGateAllowPaper=false`
  - aggregate metrics remained far outside promotion thresholds
- Trend activation result:
  - verdict: `NO_GO`
  - champion: `STC_R4_VT_3`
  - `promotionMetadataReady=false`
  - `releaseGateAllowPaper=false`
  - aggregate metrics remained far outside promotion thresholds
- No lawful winner existed, so:
  - no canonical rerun was attempted
  - no promotion was attempted
  - no `paper_champion_registry.json` was created
- The activation run therefore shifted the next objective back to research / architecture iteration.
