# Stage-C Round 4 Architecture Review

Date: `2026-03-11`

## Decision Question

After:

- Round 1 `keep_seed`
- Round 2 `kill_seed`
- Binance path still `keep_closed`

what should become the single active Stage-C research direction?

## Inputs

- `docs/research/stage_c_seed_family_smoke_20260311.md`
- `docs/research/stage_c_seed_family_round2_smoke_20260311.md`
- `docs/research/stage_c_round3_path_decision_20260311.md`
- `docs/research/stage_c_target_to_trade_mapping_20260311.md`
- `docs/research/binance_core7_alignment_round2_20260311.md`

## Evidence Table

| Evidence | What it says | Main implication |
| --- | --- | --- |
| Round 1 seed smoke | `fdrQ` improved materially on all three assets, but `PBO` and `DSR` stayed unacceptable | the target redesign is not obviously dead |
| Round 2 seed deepening | a modest structural refinement destroyed the only sanity-level improvement | the first breakout mapping is fragile, not robust |
| Binance alignment round 2 | raw and normalized Binance data exist, but final merged feature tables still carry no effective Binance-linked fields | cross-venue research is still blocked by data integration |
| Original architecture review | `feature_horizon_redesign` beat both `candidate_redesign` and `pipeline_bug_reopen` | target/horizon still remains the right problem layer |

## Rejected Options

### Option A — Broader single-venue parameter sweep

Rejected.

Reason:

- Round 2 already showed that a modest seed refinement was enough to collapse the sanity signal
- widening the grid now would optimize noise, not repair the mapping

### Option B — Promote cross-venue research now

Rejected.

Reason:

- Binance-linked fields are still absent from final target tables
- the arbitrage path is still closed for data reasons before strategy reasons

### Option C — Reopen direct return-prediction family work

Rejected.

Reason:

- the earlier architecture review already rejected this path
- nothing in Rounds 1-3 provides new evidence that direct return prediction regained viability

## Selected Option

### Option D — Keep the target, redefine the trade mapping

Selected.

Reason:

- `realized_vol_1h` remains the best-supported target choice from the target scan
- the first concrete `breakout gating` implementation was informative but unstable
- the failure pattern points to mapping fragility, not target invalidation

## Single Conclusion

Selected next direction: `redefine_target_mapping`

More specifically:

- keep `target_realized_vol_1h`
- stop treating `vol_gated_breakout_seed` as the active seed
- run a tightly scoped mapping-comparison sprint before any further family work

## Required Consequences

- freeze the existing `vol_gated_breakout_seed` as historical evidence
- do not expand family count
- do not restart `selective-inference`
- do not reopen cross-venue research until Binance alignment is repaired

## What the Next Sprint Must Do

The next sprint must compare only low-complexity mappings from the same target:

1. `vol_as_no_trade_filter`
2. `vol_as_breakout_enable_flag`
3. `vol_as_trend_enable_flag`

The next sprint is not allowed to:

- add a second family
- widen to a large parameter sweep
- change the selected target away from `realized_vol_1h`

## Decision Status

Current status: `continue_research_with_mapping_redefinition`
