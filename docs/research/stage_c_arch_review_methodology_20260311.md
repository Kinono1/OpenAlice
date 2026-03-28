# Stage-C Architecture Review — Methodology Review

Date: `2026-03-11`

## Decision Question

Should `selective-inference` remain an active parallel rescue path?

## Observed Result

Current evidence from `selective_inference_v1_ab_20260311.md` is straightforward:

- `assetsWhereSelectiveImproved = 0`
- `assetsWhereSelectivePassed = 0`
- `keep_workstream_b = no`

## Interpretation

This does not prove that selective-inference is useless in principle.

It does prove something narrower but decisive for current planning:

- on the current weak candidate pool, it provides no decision-relevant gain
- therefore it cannot justify continued parallel priority

## Current Status

`Workstream B` is downgraded from active rescue path to parked methodology reserve.

## Re-enable Condition

Selective-inference may only return as an active path if a future candidate set first satisfies at least one of these:

- at least one asset achieves a sanity-level improvement under the existing BH path
- candidate-level p-values stop being pinned near 1.0

Without one of those conditions, methodology work is not the bottleneck.

## Hard Conclusion

Do not continue spending mainline effort on selective-inference in the next sprint.

Keep the existing prototype and result as archived evidence, but deprioritize the methodology lane.
