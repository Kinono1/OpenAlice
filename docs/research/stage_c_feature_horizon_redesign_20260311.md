# Stage-C Feature / Horizon Redesign Scan

Date: `2026-03-11T08:07:36Z`

## Scope

- symbols: `BTC-USDT`, `ETH-USDT`, `SOL-USDT`
- source frequency: `1m` feature base
- candidate targets: forward return, absolute return, realized volatility, directional persistence

## Ranked Targets

- `realized_vol_1h` kind=`magnitude` meanTargetScore=`1.278264`
- `forward_return_4h` kind=`directional_return` meanTargetScore=`0.536934`
- `absolute_return_1h` kind=`magnitude` meanTargetScore=`0.466029`
- `forward_return_1h` kind=`directional_return` meanTargetScore=`0.281673`
- `directional_persistence_1h` kind=`regime` meanTargetScore=`0.251666`
- `forward_return_15m` kind=`directional_return` meanTargetScore=`0.158333`

## Recommendation

- recommended target: `realized_vol_1h`
- target kind: `magnitude`
- rationale: Best overall target already aligns with the strongest surviving signal type.

## Top Features For Recommended Target

- `okx_rv_60m` meanAbsRankIc=`0.7624` meanMiExcessOverShuffle=`0.515901`
- `day_of_week` meanAbsRankIc=`0.6972` meanMiExcessOverShuffle=`0.406611`
- `okx_rv_15m` meanAbsRankIc=`0.6715` meanMiExcessOverShuffle=`0.342435`
- `okx_volume_ma_20` meanAbsRankIc=`0.5955` meanMiExcessOverShuffle=`0.304992`
- `okx_range_pct` meanAbsRankIc=`0.5721` meanMiExcessOverShuffle=`0.202841`
