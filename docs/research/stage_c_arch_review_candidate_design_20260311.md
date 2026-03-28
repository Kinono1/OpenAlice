# Stage-C Architecture Review — Candidate Design

Date: `2026-03-11`

## Decision Question

Which parts of the current candidate design should be frozen, and what — if anything — should survive into the next research seed?

## Permanently Frozen For The Next Iteration

- the current `trend / breakout / adaptive ensemble` family expansion pattern
- widening candidate count before resolving target mismatch
- permissive adaptive weighting as a way to rescue weak candidates
- treating conservative long-only variants as sufficient proof that the family abstraction itself is sound

## Parameter Dimensions That Should Stop Being Searched

- more breakout window variants on the same current target
- more trend window sweeps on the same current target
- more ensemble weight permutations on the same current target

These dimensions are frozen because the current evidence says the architecture is mismatched, not merely under-tuned.

## Maximum Surviving Seed

If candidate work resumes after horizon redesign, only one seed direction should survive:

- a single regime-aware long-only continuation family built around the surviving structural features

That seed is not authorized to expand yet. It is only the default future starting point after the next target redesign step.

## Rejected Direction

Rejected: “try one more broader v3 family sweep now.”

Reason:

- current evidence says the candidate layer is failing structurally
- more family count would add noise without resolving the mismatch

## Hard Conclusion

The next research sprint should not be a candidate expansion sprint.

Candidate work is frozen until target/horizon redesign is completed.
