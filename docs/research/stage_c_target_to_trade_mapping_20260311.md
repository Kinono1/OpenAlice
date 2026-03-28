# Stage-C Target To Trade Mapping

Date: `2026-03-11`

## Decision Question

How should the newly selected `realized_vol_1h` target map to an executable swap trading action?

## Rejected Mapping 1

`realized_vol_1h -> direct long/short target`

Rejected because volatility magnitude is not directional by itself.

## Rejected Mapping 2

`realized_vol_1h -> standalone alpha signal`

Rejected because current evidence supports it as a strong state descriptor, not as an independent execution trigger.

## Selected Mapping

`realized_vol_1h -> regime / gating target`

Meaning:

- use predicted volatility as a structural filter
- enable or suppress downstream directional strategies depending on volatility regime
- do not treat it as the trade direction itself

## Trading Interpretation

- high predicted `realized_vol_1h`
  - allow breakout / continuation style logic
  - reduce or disable mean-reversion logic
  - tighten risk controls
- low predicted `realized_vol_1h`
  - suppress breakout logic
  - avoid overtrading

## Hard Conclusion

`realized_vol_1h` should enter the next sprint as a **gating target**, not as a direct buy/sell target.

## First Implemented Seed

The first concrete seed derived from this mapping was:

- `vol_gated_breakout_seed`

Updated interpretation after Rounds 1-3:

- Round 1 showed sanity-level improvement
- Round 2 showed that the breakout-specific implementation was fragile
- therefore the target mapping remains valid as a regime hypothesis, but the first breakout-specific seed is no longer the active next step

## Updated Active Interpretation

Use `realized_vol_1h` as a regime/gating target first.

Do not assume the correct downstream action is already known.

The next active question is:

- whether the target works best as:
  - a no-trade filter
  - a breakout enable flag
  - a trend enable flag

This mapping comparison is now the active next sprint.
