# Stage-C Seed Family Round 2 Design

Date: `2026-03-11`

## Objective

Deepen the only surviving seed family without expanding family count.

Current seed:

- `vol_gated_breakout_seed`

## Why Round 2 Exists

Round 1 proved only one narrow thing:

- the redesigned target was not dead on arrival
- `fdrQ` improved materially

But Round 1 still failed on:

- `meanPbo`
- `meanDsrProbability`

So Round 2 is not a promotion step. It is a stress test of the seed itself.

## Round 2 Change

Add one and only one new control:

- `volCooldownBars`

Reason:

- if the volatility gate repeatedly re-opens around the same high-vol regime, the seed may over-enter and inflate instability
- cooldown is the smallest structural change that can reduce repeated entries without mutating the mapping itself

## Parameter Grid

- `volTriggerRatio`: `1.05 / 1.15 / 1.25`
- `breakoutPeriod / breakoutExitPeriod`: `(12,6) / (20,10) / (30,15)`
- `volCooldownBars`: `0 / 12`

Total candidates:

- `18`

## Decision Rule

Round 2 can only end in:

- `continue_seed`
- `tighten_seed`
- `kill_seed`

No new family is allowed from this result alone.
