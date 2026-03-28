# Stage-C Round 4 Mapping Decision

Generated: `2026-03-12T16:22:04Z`

## Decision

- outcome: `promote_mapping`
- selected mapping: `no_trade`
- reason: vol_as_no_trade_filter produced the strongest unique improvement signal across smoke and harness outputs.

## Mapping Summary

### `vol_as_no_trade_filter`
- score: `21`
- smoke assets with FDR improvement: `3`
- smoke assets with PBO improvement: `0`
- smoke assets with DSR improvement: `3`
- harness delta fdrQ: `-0.8333330415997986`
- harness delta meanPbo: `0.11428571428571432`
- harness delta meanDsrProbability: `0.021594347105824224`

### `vol_as_breakout_enable_flag`
- score: `18`
- smoke assets with FDR improvement: `3`
- smoke assets with PBO improvement: `3`
- smoke assets with DSR improvement: `0`
- harness delta fdrQ: `-0.8333330415997986`
- harness delta meanPbo: `-0.09999999999999998`
- harness delta meanDsrProbability: `-0.17528947229295377`

### `vol_as_trend_enable_flag`
- score: `6`
- smoke assets with FDR improvement: `2`
- smoke assets with PBO improvement: `2`
- smoke assets with DSR improvement: `0`
- harness delta fdrQ: `2.589130400076911e-07`
- harness delta meanPbo: `0.11428571428571432`
- harness delta meanDsrProbability: `-0.14193374929670852`
