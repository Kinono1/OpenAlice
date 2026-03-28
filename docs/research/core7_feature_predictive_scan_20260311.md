# CORE7 Feature Predictive Scan

Date: `2026-03-11T04:53:00Z`

## Scope

- symbols: `BTC-USDT`, `ETH-USDT`, `SOL-USDT`
- horizons: `1h`, `4h`
- metrics: `Spearman rank-IC`, `mutual information`, shuffle baseline

## Aggregate Readout

### 1h

- conclusion: `signal still exists`
- top rank-IC features:
  - `okx_pair_close` absRankIC=`0.1492` meanRankIC=`-0.1492` shuffle=`-0.0064`
  - `okx_swap_close` absRankIC=`0.1492` meanRankIC=`-0.1492` shuffle=`-0.0071`
  - `okx_volume_ma_20` absRankIC=`0.1429` meanRankIC=`0.1429` shuffle=`0.0052`
  - `okx_low` absRankIC=`0.1401` meanRankIC=`-0.1401` shuffle=`-0.0066`
  - `okx_close` absRankIC=`0.1391` meanRankIC=`-0.1391` shuffle=`-0.0199`
- top MI features:
  - `okx_swap_close` miExcess=`0.136883` mi=`0.143476` shuffle=`0.006594`
  - `okx_pair_close` miExcess=`0.136280` mi=`0.143476` shuffle=`0.007196`
  - `okx_rv_60m` miExcess=`0.127747` mi=`0.133066` shuffle=`0.005319`
  - `okx_close` miExcess=`0.125637` mi=`0.131722` shuffle=`0.006086`
  - `okx_spot_close` miExcess=`0.125517` mi=`0.131722` shuffle=`0.006205`

### 4h

- conclusion: `signal still exists`
- top rank-IC features:
  - `day_of_week` absRankIC=`0.2313` meanRankIC=`-0.2313` shuffle=`0.0033`
  - `okx_pair_close` absRankIC=`0.1949` meanRankIC=`-0.1949` shuffle=`0.0054`
  - `okx_swap_close` absRankIC=`0.1949` meanRankIC=`-0.1949` shuffle=`0.0137`
  - `okx_low` absRankIC=`0.1904` meanRankIC=`-0.1904` shuffle=`0.0043`
  - `okx_close` absRankIC=`0.1886` meanRankIC=`-0.1886` shuffle=`-0.0068`
- top MI features:
  - `hour_of_day` miExcess=`0.315519` mi=`0.322688` shuffle=`0.007169`
  - `okx_swap_close` miExcess=`0.311483` mi=`0.318907` shuffle=`0.007424`
  - `okx_pair_close` miExcess=`0.310635` mi=`0.318907` shuffle=`0.008272`
  - `okx_close` miExcess=`0.305686` mi=`0.312167` shuffle=`0.006481`
  - `okx_spot_close` miExcess=`0.304497` mi=`0.312167` shuffle=`0.007670`
