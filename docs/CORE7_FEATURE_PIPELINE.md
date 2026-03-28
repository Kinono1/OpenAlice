# CORE7 Feature Pipeline

This pipeline turns the finished `OKX 1m` and `Binance 1m` downloads into:

1. normalized OKX rows
2. normalized Binance rows
3. per-instId feature tables
4. a minimal sklearn baseline summary

## Inputs

- `data/market/okx_1m_core7`
- `data/market/binance_1m_core7`

## Outputs

- `data/market/okx_1m_core7_norm`
- `data/market/binance_1m_core7_norm`
- `data/market/core7_feature_base_1m`
- `data/market/core7_models`

## One-command pipeline

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
bash scripts/run_core7_feature_pipeline.sh
```

## Dry run

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
DRY_RUN=1 bash scripts/run_core7_feature_pipeline.sh
```

## Custom training target

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
TRAIN_TARGET=BTC-USDT-SWAP TRAIN_LABEL=label_dir_fwd_5m bash scripts/run_core7_feature_pipeline.sh
```

## Coverage inspection

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
python3 scripts/inspect_core7_feature_coverage.py
```

## Notes

- Binance spot timestamps are normalized from microseconds to milliseconds.
- Binance um timestamps are kept in milliseconds.
- Feature tables are generated per `OKX instId`.
- The baseline trainer uses `sklearn` only and does not require `xgboost`, `lightgbm`, or `catboost`.
