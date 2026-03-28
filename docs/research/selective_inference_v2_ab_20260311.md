# Selective-Inference V1 A/B

Date: `2026-03-11T04:55:36Z`

## Scope

- candidate set: `docs/research/stage_c_strategy_candidates.v1.json`
- assets: `BTC`, `ETH`, `SOL`
- baseline: current `BH / existing FDR path`
- prototype: `e_bh_prototype`

## Summary

- completed assets: `3`
- assets where selective improved over BH: `0`
- assets where selective produced a pass: `0`
- keep Workstream B: `False`

## Per-Asset Snapshot

| asset | BH fdrQ | selective effectiveQ | improved vs BH | selective pass |
| --- | ---: | ---: | --- | --- |
| BTC | `1.0000` | `1.0000` | `no` | `no` |
| ETH | `1.0000` | `1.0000` | `no` | `no` |
| SOL | `1.0000` | `1.0000` | `no` | `no` |

## Interpretation

Selective-inference did not improve the same weak candidate pool in any decision-relevant way. Workstream B should be kept only as a lower-priority sidecar until the signal layer improves.

## Decision

- keep_workstream_b: `no`
- note: this prototype does not override the BH verdict and does not by itself justify moving toward G3 release.
