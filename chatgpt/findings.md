# OpenAlice Findings

Last updated: `2026-03-18`

## Purpose

This file is the evidence ledger for what has worked, what has failed, and what constraints now define the task boundary.

## Update Rules

- Add new findings when a session produces a real success, failure, or hard constraint.
- Prefer evidence-backed statements with file references.
- Keep old findings if they still explain current boundaries.
- If a finding is superseded, mark it as superseded instead of silently removing it.

## High-Confidence Successes

### Runtime and execution

- Dispatcher and live-gate wiring were successfully tightened enough that the current runtime path is no longer the main blocker.
- Telegram, heartbeat, web runtime, and crypto account access were all validated in the current runtime path.
- Trade permission was confirmed with a real minimal `WIF/USD` round-trip.
- `pnl-fills.jsonl` is now based on real fills, not just hypothetical pipeline behavior.
- `PnLTracker.restoreFromDisk()` was validated in TypeScript against real fill data.
- Full-process restart with non-empty fill history was validated without introducing a new reconciliation alert.

### Code fixes that mattered

- OKX `long_short_mode` required explicit `posSide`; without it, real order placement failed.
- `pending -> filled` sync previously did not write fill history back into `pnl-fills.jsonl`; that gap was fixed.
- Current runtime can safely return to `BTC/USD + demoTrading=true` after a real-trade test.
- `paper` and `live` release-gate semantics were previously conflated in runtime blocking. A first split now exists, so `demoTrading=true` can use `allowPaperTrading` instead of being incorrectly blocked by `allowLiveTrading`.
- The runtime now has explicit `PaperChampionRegistry` and `paperGate` modules, so champion presence and policy-version alignment no longer have to stay as prose-only contracts.
- The runtime now also has explicit `DataContract` and `ExecutionSemanticsContract` modules, which means completed-bar rules, timestamp alignment, clock-skew checks, stale-submit rules, and blind-retry bans no longer need to stay as prose-only assumptions.

### Research process

- The old direction-prediction route was correctly rejected instead of being endlessly tuned.
- `feature_horizon_redesign` produced a more evidence-backed next target than continuing direct return prediction.
- The first `vol_gated_breakout_seed` was useful because it proved the target redesign was not dead on arrival.
- Round 4 is no longer only a doc-level plan; the mapping comparison now has runnable code paths and produced a first full summary + decision memo.
- The first full Round 4 run promoted `vol_as_no_trade_filter` over breakout/trend as the next refinement candidate.

## High-Confidence Failures

### Strategy failures

- `v1` direct-return candidate path failed.
- `v2` made the situation worse instead of improving it.
- `selective-inference` produced no decision-relevant improvement and is not a mainline path.
- The first deeper refinement of `vol_gated_breakout_seed` collapsed the only sanity-level improvement.

### What that means

- the current main failure is not runtime
- the current main failure is not lack of fancy statistical post-processing
- the current main failure is **strategy abstraction / target-to-trade mapping**

## Current Hard Constraints

- `target_realized_vol_1h` stays as the target for now
- it cannot be treated as a direct buy/sell target
- cross-venue research remains blocked until Binance merge/alignment is repaired
- no automatic live rollout is justified by current evidence
- the Round 4 `promote_mapping` result is still research-only because the promoted pack remained `NO_GO`
- default decision-support tools should not auto-rotate into the new Round 4 mappings without explicit selection

## Evidence-Backed Lessons

### Lesson 1 — Runtime health is necessary but not sufficient

OpenAlice now has a functioning execution and monitoring path, but that did not solve the research failure. This means future effort must not drift back into treating runtime as the main research blocker.

### Lesson 2 — Better target does not automatically mean better trading action

`realized_vol_1h` was the strongest target from the scan, but the first obvious mapping (`vol -> breakout gating`) was fragile. That means the target may still be correct while the first executable interpretation is wrong.

### Lesson 3 — Do not confuse “sanity improvement” with “promotion-ready”

Round 1 reduced `fdrQ` sharply, but `PBO` and `DSR` remained unacceptable. A sanity improvement is only permission to test one careful refinement, not permission to widen the family search.

### Lesson 4 — Binance needs a source-window check before any repair claim

Raw and normalized Binance data already exist, and historical feature-base rows prove Binance merge once worked. That means “Binance is broken” is too vague. Before claiming a merge-code defect, first check whether the required raw window is actually available for refresh.

### Lesson 5 — Repo hygiene matters

The repo had accumulated enough old docs, temp files, and legacy research scripts that current truth was becoming hard to read. First-pass hygiene reduced noise and archived superseded loops without damaging active evidence.

### Lesson 6 — Better `FDR`/`DSR` can still lose on `PBO`

The first full Round 4 run promoted the no-trade filter because it improved `FDR` and `DSR` vs the frozen baseline, but it still failed the overall gate because `meanPbo` stayed unacceptable. That means the next refinement must focus on gate balance, not just one metric family.

## Current Best Explanation

The current best explanation for the Stage-C failure pattern is:

- some useful signal still exists
- the selected target is plausible
- but the mapping from that target into executable trading logic is still wrong or too brittle for the current `BTC/USD 1h` directional families

That is why the active next step is:

- stop refining the closed directional family line
- move back to new research design plus Binance data-source strategy

## Current Explicit Fail Points

If any future session ignores these, it is likely to waste time:

- do not reopen direct forward-return candidate work as the default path
- do not widen the search because one Round 1 result looked less bad
- do not reopen arbitrage research before Binance alignment is fixed
- do not mistake archived docs or legacy scripts for current truth

## Current Explicit Success Path

The only justified immediate success path is:

1. keep `target_realized_vol_1h`
2. treat volatility gating as a regime-control layer, not the final paper strategy
3. evaluate the directional gated families under the frozen paper/runtime contracts
4. choose exactly one outcome:
   - promote one directional family to paper champion
   - kill the current family set
   - return to architecture review again

## New Stable Findings

- The runtime no longer needs more observability work to explain why paper execution is blocked.
- With OpenBB sidecar available and crypto-symbol normalization fixed, `dataContract` now passes for the active `BTC/USD` baseline.
- The current hard blockers are governance-only:
  - `allowPaperTrading=false`
  - `paper_champion_registry_missing`
- `run_paper_demo_executor_cycle.ts` must not be allowed to rewrite `release_gate_status.json`; that artifact must stay research-owned.
- A lawful promotion bridge now exists, and it correctly refuses to create a champion registry when:
  - the verdict is still `NO_GO`
  - the worktree is dirty
  - the release gate provenance is runtime-owned
  - the family is not runtime-promotable
- `volNoTradeFilter` may remain a research winner, but it is not a valid automatic paper champion family under the current runtime.

### New activation result

- Both runtime-supported directional Round 4 families (`volBreakout`, `volTrend`) still fail the research gate under isolated activation runs.
- The blocker is now evidence-backed and specific:
  - no lawful directional `GO` path exists right now
  - therefore promotion must not proceed
- `promotionMetadataReady=false` was observed during isolated activation because the current working tree is dirty; this is a secondary operational blocker, not the primary research blocker.
- Even if the dirty-worktree issue were removed, the current directional candidates still fail on:
  - `PBO`
  - `DSR`
  - `FDR`
  - release gate approval
- The immediate next step should not be scheduler work, registry work, or runtime work.
- The immediate next step should be either:
  - another directional research iteration with explicit parameter/method changes, or
  - a return to architecture / Binance alignment review.

### Final bounded directional falsification result

- The last allowed bounded directional methodology pass has now been completed.
- `volBreakout` remained `NO_GO` under:
  - `regime_segmented_bh`
  - `cv_storey_bh`
  - `stability_bh`
- `volTrend` also remained `NO_GO` under the same three variants.
- The strongest partial rescue was:
  - `volBreakout + cv_storey_bh`
  - `fdrQ=0.041666...`
  - but `meanPbo=0.642857...`
  - and `meanDsrProbability≈1.83e-13`
- This matters because it shows the remaining failure is not just the choice of FDR method.
- Even when `FDR` becomes acceptable for the leading breakout candidate set, the family still fails catastrophically on:
  - `PBO`
  - `DSR`
  - release gate approval
- `volTrend` stayed even weaker:
  - `meanPbo≈0.985714...`
  - `meanDsrProbability≈0.002087...`
- The current `volBreakout` / `volTrend` line on `BTC/USD 1h` should now be treated as closed.

### Binance refresh result reframes the blocker

- Historical feature-base rows already contain:
  - `has_binance_spot_bar=1`
  - `has_binance_um_bar=1`
- So the repo does have evidence that Binance merge worked for earlier windows.
- Current local Binance raw shards for `BTCUSDT / ETHUSDT / SOLUSDT` stop at `2026-02` for both:
  - `spot`
  - `um`
- A repo-native monthly refresh attempt for `2026-03` returned:
  - `missing=6`
  - `failed=0`
- Therefore the current Track B blocker is best described as:
  - source-window unavailability / freshness gap
  - not a proven merge-code defect
- Until a valid `2026-03` Binance source exists, normalize/rebuild work should not be treated as the primary fix.

## References To Recheck First

- `docs/research/stage_c_architecture_review_20260311.md`
- `docs/research/stage_c_round3_path_decision_20260311.md`
- `docs/research/stage_c_round4_arch_review_20260311.md`
- `docs/research/stage_c_round4_mapping_experiment_20260311.md`
- `docs/research/binance_core7_alignment_round2_20260311.md`
- `/tmp/openalice-research-final/track_a_summary.json`
- `/tmp/openalice-research-final/track_a_closure_note.md`
- `/tmp/openalice-trackb/track_b_preflight.json`
- `/tmp/openalice-trackb/binance_alignment_diagnosis.v1.json`
- `docs/research/real_trade_wif_test_20260311.md`
- `docs/research/non_empty_fill_restart_validation_20260311.md`

## Session Close Rule

At the end of each future related session:

- add new hard failures here
- add new confirmed successes here
- add any new boundary that should stop later agents from repeating old mistakes
