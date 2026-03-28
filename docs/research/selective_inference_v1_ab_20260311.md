# Selective-Inference V1 A/B

Date: `2026-03-11`

## Scope

- candidate set: `docs/research/stage_c_strategy_candidates.v1.json`
- assets: `BTC`, `ETH`, `SOL`
- baseline method: current `BH / cv_storey_bh`
- selective method: `e_bh_prototype`
- machine-readable result: `data/research/strategy/analysis/stage_c/selective_inference_v1_comparison.json`

## Summary

- completed assets: `3`
- assets where selective improved champion-level FDR proxy: `0`
- assets where selective produced any accepted candidate: `0`
- keep Workstream B active at the same priority: `no`

## Asset Readout

### BTC

- baseline `fdrQ`: `0.9999999999996709`
- selective champion effectiveQ: `1.0`
- delta: `+0.0000000000003291`
- conclusion: no improvement

### ETH

- baseline `fdrQ`: `0.9999999999975048`
- selective champion effectiveQ: `1.0`
- delta: `+0.0000000000024952`
- conclusion: no improvement

### SOL

- baseline `fdrQ`: `0.9999999999970032`
- selective champion effectiveQ: `1.0`
- delta: `+0.0000000000029968`
- conclusion: no improvement

## Interpretation

This prototype answers a narrow question: can a minimal `e_bh` style selective-inference pass rescue the same weak Sprint 1 candidate set?

Current answer: `no`.

What this result means:

- Workstream B should not be treated as the current rescue path.
- The main failure is still at the signal / candidate layer.
- Selective-inference can remain in the toolbox, but it should be deprioritized until Workstream A stops collapsing at `fdrQ ~ 1.0`.

What this result does not mean:

- it does not prove selective-inference is useless in principle
- it does not justify deleting Workstream B entirely
- it does not change the rollout/runtime conclusions

## Decision

- `keep_workstream_b`: no
- `deprioritize_workstream_b`: yes
- next use of selective-inference: only after a candidate set shows at least one sanity-level improvement
