# G3/G4 Provisional Baseline (2026-03-03)

## Purpose

This document records a research-only provisional baseline for the current G3/G4 recovery loop.  
It does not change production gate policy or release verdict logic.

## Baseline Snapshot

- `fdrQ`: `0.11722662636524232`
- `meanPbo`: `0.18571428571428572`
- Source: `data/research/strategy/local_search/best_trend_triplet.latest.v1.json`

## Interpretation

- `meanPbo` is under `0.2`, but `fdrQ` remains above the hard threshold `0.1`.
- Therefore this point is not a production-pass candidate.
- It is tracked as a short-term reference point for research iteration and method comparison.

## Policy Status

- Production threshold policy stays unchanged:
  - `fdrQ <= 0.1`
  - `meanPbo <= 0.2`
- Current production verdict remains `NO_GO`.
