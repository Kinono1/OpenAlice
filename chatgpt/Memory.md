# OpenAlice Memory

Last updated: `2026-03-14`

## Purpose

This file is the stable memory layer for OpenAlice work. It should only contain facts and rules that remain useful across sessions.

## Mandatory Read Rule

Any future Codex session working on OpenAlice should read:

1. `chatgpt/Memory.md`
2. `chatgpt/task_plan.md`
3. `chatgpt/findings.md`
4. `chatgpt/progress.md`

These files are the canonical continuity mechanism for this repo.

## Canonical Handoff Rule

For OpenAlice work, treat this exact directory as the only canonical handoff pack for the session:

- `/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/chatgpt`

Do not switch to any other `chatgpt` directory unless the user explicitly asks for that validation or migration work.

If any file inside this directory conflicts with `README_ARCHIVED.md`, use this precedence order:

1. `chatgpt/Memory.md`
2. `chatgpt/task_plan.md`
3. `chatgpt/findings.md`
4. `chatgpt/progress.md`
5. newer timestamps within this same directory
6. `chatgpt/README_ARCHIVED.md` last

The purpose of this rule is to lock:

- the file location boundary
- the source-of-truth boundary
- the read-order boundary

Machine-readable copy of the same rule:

- `chatgpt/handoff_policy_v1.json`

## Update Rules

- Only store stable facts here.
- Do not append transient experiments or one-off logs unless they change long-term operating truth.
- If a fact becomes obsolete, replace it instead of keeping both versions.
- If a new lesson is only temporary, write it to `findings.md` instead.

## Repo Identity

- Repo path:
  - `/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice`
- Core project identity:
  - file-based trading agent engine
  - crypto execution + UI + research pipeline
  - current active venue focus: OKX crypto

## Stable Runtime Truth

- Current safe operating baseline is:
  - `BTC/USD`
  - `demoTrading=true`
- Runtime path already proved healthy enough for continued research support:
  - `web`
  - `telegram`
  - `heartbeat`
  - `/api/chat`
  - `/api/crypto/account`
- Trade permission is confirmed via a minimal real `WIF/USD` round-trip.
- `data/crypto-trading/pnl-fills.jsonl` is real and non-empty.
- Non-empty fill restore has been validated:
  - TypeScript restore path
  - full-process restart path

## Stable Research Truth

- Old direct forward-return strategy path is not the mainline anymore.
- `selective-inference` is not the active rescue path.
- Active architecture decision:
  - `feature_horizon_redesign`
- Active selected target:
  - `target_realized_vol_1h`
- This target is **not** a direct directional target.
- It is only allowed as:
  - `gating / regime target`
- Round 4 mapping research is now implemented in code through:
  - `volNoTradeFilter`
  - `volBreakout`
  - `volTrend`
- standalone `vol_as_no_trade_filter` is not the current endpoint anymore
- current planning mainline is:
  - directional gated families for paper promotion
  - runtime-faithful simulation
  - OKX demo paper execution

## Stable Decision Chain

- `v1` return-based candidates: failed
- `v2` return-based candidates: worse
- `feature_horizon_redesign`: selected
- first `vol_gated_breakout_seed` round: sanity-level improvement
- second seed refinement round: collapsed
- current direction:
  - keep the target
  - redefine the mapping from target to executable trade logic

## Stable Data Truth

- OKX data path exists and has been used for current research artifacts.
- Binance raw and normalized data exist.
- Binance-linked fields still fail to appear in final merged target tables.
- Therefore:
  - cross-venue research is still blocked
  - arbitrage path remains closed until merge/alignment is repaired

## Stable File Anchors

These docs are current truth anchors and should be preferred over older packets:

- `docs/research/runtime_truth_reconciliation_20260311.md`
- `docs/research/stage_c_architecture_review_20260311.md`
- `docs/research/stage_c_round3_path_decision_20260311.md`
- `docs/research/stage_c_round4_arch_review_20260311.md`
- `docs/research/stage_c_round4_mapping_experiment_20260311.md`
- `docs/research/stage_c_feature_horizon_input_pack_20260311.md`
- `docs/research/stage_c_target_to_trade_mapping_20260311.md`
- `docs/research/real_trade_wif_test_20260311.md`
- `docs/research/non_empty_fill_restart_validation_20260311.md`
- `data/research/strategy/analysis/stage_c/round4/latest_round4_summary.v1.json`
- `chatgpt/round4_mapping_decision_latest.md`
- `chatgpt/alpha_contract_v1.md`
- `chatgpt/runtime_contract_v1.md`
- `chatgpt/paper_acceptance_v1.md`
- `chatgpt/reproducibility_fingerprint_v1.md`
- `chatgpt/operator_playbook_v1.md`

## Stable Boundaries

Unless explicitly changed by the user:

- do not enable automatic live trading
- do not rebuild `decision_packet`
- do not widen symbol coverage
- do not add `securities` back into the current mainline
- do not revive archived G3/G4 / Phase-B loops as active work
- do not treat old archived docs as current truth

## Stable Repo Hygiene Truth

- `docs/research/archive/` contains superseded research packets
- `scripts/archive/legacy-research/` contains superseded G3/G4 and Phase-B loop scripts
- root `chatgpt/` is the canonical OpenAlice handoff pack
- for this repo, `/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/chatgpt` remains the active handoff source even if `README_ARCHIVED.md` still mentions a broader `work_projects/chatgpt` migration target
- `docs/OpenAlice/chatgpt/` is a legacy mirror and should not receive new updates
- `repo_hygiene_triage_20260311.md`, `repo_scripts_triage_20260311.md`, and `repo_packet_builders_triage_20260311.md` explain what was cleaned and what remains deferred
- packet-builder cluster cleanup is intentionally deferred because `package.json` still references those scripts

## Human-in-the-Loop Operating Truth

- OpenAlice is currently more trustworthy as a decision-support system than as an autonomous trading system
- primary manual tool path:
  - `expertQuantDecision`
  - `strategyCompare`
  - `strategyGetSignal`
- `mlEnsemblePredict` is supportive context, not a standalone execution trigger

## Session Close Rule

If a future session changes any long-term truth above, this file must be updated before the session ends.
