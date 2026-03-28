# G3/G4 Pre-Continue Decision

- Generated at: `2026-03-03T13:19:48Z`
- Primary recommendation: `strategy_rebuild`

## Q1: Why fdrQ is stuck
- Answer: Current candidate p-values are mostly high, so no candidate reaches alpha-level significance.
- Evidence: latest_diagnosis=strategy_signal_limited, latest_fdrQ=0.3551147194234592

## Q2: Is single-BTC data enough
- Answer: No. Multi-asset evidence is required before choosing the next primary direction.
- Evidence: completed_assets=3, btc_fdrQ=0.8774780310395132, matrix_median_fdrQ=0.8774780310395132

## Q3: Are hard constraints reasonable
- Answer: Production thresholds stay frozen; research-only sensitivity is used to quantify trade-off, not to auto-relax gates.
- Evidence: prod_fdr_block_rate=1.0, research_fdr_15_delta_joint_pass=0.0

## Rule Triggers

| rule | triggered | evidence |
| --- | --- | --- |
| R1_strategy_rebuild | True | median_p=0.822774394869213, low_p_asset_share=0.0 |
| R2_fdr_method_upgrade | False | latest_diagnosis=strategy_signal_limited, low_p_asset_share=0.0, prod_fdr_block=1.0 |
| R3_threshold_governance_review | False | research_fdr_15_delta_joint_pass=0.0 |
| R4_data_expansion_priority | False | btc_fdrQ=0.8774780310395132, median_fdrQ=0.8774780310395132, iqr_fdrQ=0.10558456315594023 |

## Next Actions
- Freeze parameter-only search for 48h and open strategy feature redesign cards.
- Rebuild candidate generator with stronger signal priors before next A/B cycle.
