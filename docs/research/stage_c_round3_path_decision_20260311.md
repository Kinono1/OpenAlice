# Stage-C Round 3 Path Decision

Date: `2026-03-11`

## Inputs

- `docs/research/stage_c_seed_family_smoke_20260311.md`
- `docs/research/stage_c_seed_family_round2_smoke_20260311.md`
- `docs/research/binance_core7_alignment_round2_20260311.md`

## Decision

Exactly one:

- `promote_single_venue_seed`
- `switch_to_cross_venue_research`
- `return_to_architecture_review`

Current decision: `return_to_architecture_review`

## Reason

The two inputs point in the same direction:

1. Round 2 deepening of the single-venue seed failed
   - Round 1 had sanity-level improvement
   - Round 2 lost that improvement and returned to `fdrQ ~ 1.0`
2. Binance alignment remains unresolved
   - raw and normalized Binance data exist
   - final feature tables still have zero effective Binance-linked fields
   - arbitrage path remains closed

That means:

- there is no stable single-venue seed worth promoting
- there is also no repaired cross-venue path worth switching to

## Consequence

Return to architecture review.

The next step should not be:

- a broader single-venue parameter sweep
- a cross-venue strategy design sprint

The next step should be:

- reopen architecture review around target-to-trade mapping and single-venue path fragility
