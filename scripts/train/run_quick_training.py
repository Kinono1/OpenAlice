"""
Quick IC + WFO training run using pre-generated features + labels.
Usage:
    /opt/miniconda3/bin/python3 scripts/train/run_quick_training.py \
        --features data/research/features.jsonl \
        --labels data/research/labels_24h.jsonl
"""
import argparse, json, os, sys
from datetime import datetime

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ic_computation import (
    compute_ic_series, compute_icir, compute_ic_drawdown,
    compute_normalized_ic_drawdown, effective_n_correction,
    negative_control_test, top_bottom_net_return,
)
from ridge_ranker import train_ridge_ranker
from wfo_validator import walk_forward_validation, compute_pbo_cscv_report
from naive_baselines import (
    raw_factor_rank_baseline, random_rank_baseline,
    shuffled_label_negative_control,
)


def load_flat_matrix(feature_path, label_path):
    """Load features + labels into DataFrames, aligned on timestamp."""
    # Features
    rows = []
    with open(feature_path) as f:
        for line in f:
            if line.strip():
                row = json.loads(line)
                flat = {'timestamp': row['timestamp'], 'symbol': row['symbol']}
                if 'features' in row:
                    for k, v in row['features'].items():
                        flat[k] = v
                rows.append(flat)
    feat_df = pd.DataFrame(rows)
    feat_df['timestamp'] = pd.to_datetime(feat_df['timestamp'], format='ISO8601')
    feat_pivot = feat_df.pivot(index='timestamp', columns='symbol', values='ret_24h')

    # Labels
    label_rows = []
    with open(label_path) as f:
        for line in f:
            if line.strip():
                row = json.loads(line)
                label_rows.append(row)
    label_df = pd.DataFrame(label_rows)
    label_df['timestamp'] = pd.to_datetime(label_df['timestamp'], format='ISO8601')
    label_col = select_label_column(label_df.columns)
    label_pivot = label_df.pivot(index='timestamp', columns='symbol', values=label_col)

    return feat_pivot.apply(pd.to_numeric, errors='coerce'), label_pivot.apply(pd.to_numeric, errors='coerce')


def select_label_column(columns):
    for name in ('forward_net_return', 'forward_net_return_24h', 'forward_net_return_48h'):
        if name in columns:
            return name
    raise ValueError('No forward net return label column found.')


def load_feature_frame(feature_path):
    rows = []
    with open(feature_path) as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            flat = {'timestamp': row['timestamp'], 'symbol': row['symbol']}
            features = row.get('features', {})
            if isinstance(features, dict):
                flat.update(features)
            rows.append(flat)
    if not rows:
        raise ValueError(f'No feature rows in {feature_path}')
    feat_df = pd.DataFrame(rows)
    feat_df['timestamp'] = pd.to_datetime(feat_df['timestamp'], format='ISO8601')
    return feat_df


def build_wide_training_matrix(feat_df, factor_cols, min_assets, min_feature_coverage, max_model_features):
    """Build timestamp-indexed wide matrix without integer-index grouping or zero imputation."""
    symbols = sorted(feat_df['symbol'].dropna().unique())
    train_rows = []
    skipped_small_universe = 0
    for ts, grp in feat_df.groupby('timestamp', sort=True):
        if grp['symbol'].nunique() < min_assets:
            skipped_small_universe += 1
            continue
        row = {'timestamp': ts}
        for _, item in grp.iterrows():
            sym = item['symbol']
            for k in factor_cols:
                v = item.get(k)
                if v is not None:
                    row[f'{k}__{sym}'] = v
        train_rows.append(row)

    if not train_rows:
        return pd.DataFrame(), {
            'symbols': symbols,
            'skipped_small_universe_timestamps': skipped_small_universe,
            'eligible_columns': 0,
            'dropped_sparse_columns': 0,
        }

    train_df = pd.DataFrame(train_rows).set_index('timestamp').sort_index()
    train_df = train_df.apply(pd.to_numeric, errors='coerce')
    train_df = train_df.replace([np.inf, -np.inf], np.nan).dropna(axis=1, how='all')

    coverage = train_df.notna().mean(axis=0)
    eligible = coverage[coverage >= min_feature_coverage].index.tolist()
    if max_model_features > 0 and len(eligible) > max_model_features:
        variances = train_df[eligible].var(axis=0, skipna=True).sort_values(ascending=False)
        eligible = variances.head(max_model_features).index.tolist()
    train_df = train_df[eligible] if eligible else pd.DataFrame(index=train_df.index)

    stats = {
        'symbols': symbols,
        'min_assets_per_timestamp': int(min_assets),
        'max_assets_per_timestamp': int(feat_df.groupby('timestamp')['symbol'].nunique().max()),
        'skipped_small_universe_timestamps': int(skipped_small_universe),
        'eligible_columns': int(len(eligible)),
        'dropped_sparse_columns': int(len(coverage) - len(eligible)),
        'min_feature_coverage': float(min_feature_coverage),
        'max_model_features': int(max_model_features),
    }
    return train_df, stats


def finite_or_none(value):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if np.isfinite(v) else None


def robust_series_stats(series):
    clean = pd.Series(series).replace([np.inf, -np.inf], np.nan).dropna()
    if len(clean) == 0:
        return {
            'n': 0,
            'mean': None,
            'median': None,
            'p10': None,
            'p25': None,
            'p75': None,
            'p90': None,
            'min': None,
            'max': None,
        }
    return {
        'n': int(len(clean)),
        'mean': finite_or_none(clean.mean()),
        'median': finite_or_none(clean.median()),
        'p10': finite_or_none(clean.quantile(0.10)),
        'p25': finite_or_none(clean.quantile(0.25)),
        'p75': finite_or_none(clean.quantile(0.75)),
        'p90': finite_or_none(clean.quantile(0.90)),
        'min': finite_or_none(clean.min()),
        'max': finite_or_none(clean.max()),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--features', default='data/research/features.jsonl')
    parser.add_argument('--labels', default='data/research/labels_24h.jsonl')
    parser.add_argument('--output', default='data/research/training_report.json')
    parser.add_argument('--min-assets', type=int, default=3)
    parser.add_argument('--recommended-assets', type=int, default=20)
    parser.add_argument('--min-feature-coverage', type=float, default=0.8)
    parser.add_argument('--max-model-features', type=int, default=200)
    parser.add_argument('--label-horizon-bars', type=int, default=24)
    args = parser.parse_args()

    print(f'Loading features from {args.features}...')
    print(f'Loading labels from {args.labels}...')
    factors, returns = load_flat_matrix(args.features, args.labels)
    print(f'  Features: {factors.shape[0]} timestamps × {factors.shape[1]} assets')
    print(f'  Labels:   {returns.shape[0]} timestamps × {returns.shape[1]} assets')

    # Align
    common = factors.index.intersection(returns.index)
    factors, returns = factors.loc[common], returns.loc[common]
    print(f'  Aligned:  {len(common)} common timestamps')

    report = {
        'generated_at': datetime.utcnow().isoformat() + 'Z',
        'status': 'running_diagnostic_only',
        'research_only': True,
        'diagnostic_only': True,
        'promotion_grade': False,
        'promotion_eligible': False,
        'paper_trading_allowed': False,
        'live_trading_allowed': False,
        'blockers': [],
        'symbols': list(factors.columns),
        'n_samples': len(common),
        'config': {
            'model': 'Ridge',
            'horizon': '24h',
            'min_assets': args.min_assets,
            'recommended_assets': args.recommended_assets,
            'label_horizon_bars': args.label_horizon_bars,
        },
    }
    if len(factors.columns) < args.min_assets:
        report['blockers'].append(f'universe_too_small_for_rank_ic:{len(factors.columns)}<{args.min_assets}')
    if len(factors.columns) < args.recommended_assets:
        report['blockers'].append(f'universe_below_recommended_cross_section:{len(factors.columns)}<{args.recommended_assets}')

    # Phase 0.5: Naive baselines
    print('\n=== Phase 0.5: Naive Baselines ===')
    # Random rank baseline
    last_returns = returns.iloc[-100:].mean(axis=1).dropna()
    rand_ic = random_rank_baseline(last_returns, n_permutations=500)
    print(f'  Random rank IC: mean={rand_ic["mean_ic"]:.4f}, P95={rand_ic["p95_ic"]:.4f}')
    report['random_rank_baseline'] = rand_ic

    # Raw factor rank (last available day)
    if len(factors) > 0:
        f_last = factors.iloc[-1].dropna()
        r_last = returns.iloc[-1].dropna()
        common_sym = f_last.index.intersection(r_last.index)
        if len(common_sym) >= 4:
            raw = raw_factor_rank_baseline(
                pd.Series({s: f_last[s] for s in common_sym}),
                pd.Series({s: r_last[s] for s in common_sym}),
                top_pct=0.25,
            )
            print(f'  Raw factor rank spread: {raw["spread"]:.6f}')
            report['raw_factor_baseline'] = raw

    # Negative control
    print('\n  Negative control test...')
    if len(factors) >= 30:
        nc = negative_control_test(
            factors.iloc[:100].apply(pd.to_numeric, errors='coerce'),
            returns.iloc[:100].apply(pd.to_numeric, errors='coerce'),
            n_permutations=30,
        )
        shuffled_ic = nc.get('shuffled_mean_ic')
        print(f'  Shuffled-label IC: {shuffled_ic if shuffled_ic is not None else "nan"}, leakage={nc["leakage_detected"]}')
        report['negative_control_matrix'] = nc

    # Phase 1: IC diagnostics
    print('\n=== Phase 1: IC Diagnostics ===')
    ic_series = compute_ic_series(factors, returns)
    if len(ic_series) > 0:
        ic_mean = float(ic_series.mean())
        ic_std = float(ic_series.std(ddof=1))
        icr = compute_icir(ic_series)
        ic_dd = compute_ic_drawdown(ic_series)
        ic_dd_norm = compute_normalized_ic_drawdown(ic_series)
        eff_n = effective_n_correction(ic_series)
        t_stat = icr * np.sqrt(min(eff_n, len(ic_series)))

        print(f'  Spearman Rank IC:  mean={ic_mean:.4f}, std={ic_std:.4f}')
        print(f'  ICIR:              {icr:.4f}')
        print(f'  t-stat (eff-N):    {t_stat:.4f}')
        print(f'  IC Drawdown:       {ic_dd:.4f} (norm={ic_dd_norm:.4f})')
        print(f'  Effective N:       {eff_n:.0f} (nominal={len(ic_series)})')
        print(f'  IC > 0.03:         {"✅" if ic_mean > 0.03 else "❌"} ({ic_mean:.4f})')
        print(f'  ICIR > 0.3:        {"✅" if icr > 0.3 else "❌"} ({icr:.4f})')
        print(f'  Drawdown ok:       {"✅" if ic_dd_norm < 5 else "❌"} ({ic_dd_norm:.4f})')

        report['ic_diagnostics'] = {
            'spearman_rank_ic_mean': ic_mean,
            'spearman_rank_ic_std': ic_std,
            'icir': icr,
            't_stat_effective_n': t_stat,
            'ic_drawdown': ic_dd,
            'normalized_ic_drawdown': ic_dd_norm,
            'effective_n': eff_n,
            'nominal_n': len(ic_series),
            'ic_gt_003': ic_mean > 0.03,
            'icir_gt_03': icr > 0.3,
            'robust': robust_series_stats(ic_series),
        }
    else:
        report['blockers'].append('no_valid_cross_sectional_ic_timestamps')

    # Phase 1b: Top-bottom net return
    print('\n  Top-bottom net return...')
    spread = top_bottom_net_return(factors, returns, top_n=1, bottom_n=1)
    if len(spread) > 0:
        mean_spread = float(spread.mean())
        print(f'  Mean top-bottom spread: {mean_spread:.6f}')
        report['top_bottom_spread'] = mean_spread
        report['top_bottom_spread_robust'] = robust_series_stats(spread)
    else:
        report['blockers'].append('no_valid_top_bottom_spread_timestamps')

    # Phase 2: Ridge ranker + WFO
    print('\n=== Phase 2: Ridge Ranker + WFO-Lite ===')
    # Use all features as factors
    factor_cols = ['ret_1h', 'ret_4h', 'ret_24h', 'realized_vol_24h', 'volume_z_24h',
                   'funding_rate', 'funding_z_30d', 'basis_bps', 'btc_ret_24h', 'market_dispersion']

    feat_df = load_feature_frame(args.features)
    train_df, matrix_stats = build_wide_training_matrix(
        feat_df,
        factor_cols,
        args.min_assets,
        args.min_feature_coverage,
        args.max_model_features,
    )
    report['training_matrix'] = matrix_stats

    # Align with returns
    r_mean = returns.mean(axis=1)
    common_idx = train_df.index.intersection(r_mean.index)
    X = train_df.loc[common_idx].replace([np.inf, -np.inf], np.nan)
    y = r_mean.loc[common_idx]
    valid_rows = X.notna().all(axis=1) & y.notna()
    X = X.loc[valid_rows]
    y = y.loc[X.index]

    if len(X) >= 50:
        print(f'  Training samples: {len(X)}, features: {X.shape[1]}')

        # Train Ridge only as an in-sample diagnostic; WFO below is the usable check.
        model, scaler = train_ridge_ranker(X, y)
        from scipy.stats import spearmanr
        preds = model.predict(scaler.transform(X.values.astype(float)))
        train_ic = spearmanr(preds, y)[0]
        print(f'  Ridge in-sample IC: {train_ic:.4f}')
        report['ridge_is_ic'] = finite_or_none(train_ic)
        report['ridge_is_ic_caveat'] = 'in_sample_diagnostic_only_not_promotion_evidence'

        # WFO-Lite
        print('\n  WFO-Lite (row-count windows with purge/embargo)...')
        wfo = walk_forward_validation(
            X, y,
            train_window=60, test_window=14, step=7, embargo=24,
            holding_bars=args.label_horizon_bars,
        )
        if wfo['status'] == 'completed':
            s = wfo['summary']
            print(f'  WFO folds: {wfo["fold_count"]}')
            print(f'  WFO mean IC: {s["mean_ic"]:.4f}')
            print(f'  WFO pass rate: {s["pass_rate"]:.4f}')
            print(f'  WFO median spread: {s["median_spread"]:.6f}')
            report['wfo_lite'] = s
            report['wfo_lite_robust_spread'] = robust_series_stats([
                f.get('spread_return') for f in wfo.get('fold_results', []) if f.get('spread_return') is not None
            ])
            m1_pass = (s.get('mean_ic', -1) > 0 and
                       s.get('pass_rate', 0) > 0.3 and
                       s.get('median_spread', -1) > 0)
            print(f'  M1 pass: {"✅" if m1_pass else "❌"}')
            report['m1_pass'] = m1_pass
        else:
            report['blockers'].append(f'wfo_not_completed:{wfo.get("status")}')

        print('\n  PBO: not computed in quick single-candidate pipeline')
        pbo_report = compute_pbo_cscv_report(X, y, n_partitions=8 if len(X) > 200 else 4)
        print(f'  PBO status: {pbo_report["status"]} ({pbo_report["reason"]})')
        report['pbo'] = None
        report['pbo_report'] = pbo_report
        report['blockers'].append('pbo_not_computed_requires_candidate_return_matrix')

        nc = shuffled_label_negative_control(X, y, n_permutations=30)
        report['negative_control_model'] = nc
    else:
        print(f'  Insufficient training data: {len(X)} samples < 50')
        report['ridge_n_train'] = len(X)
        report['ridge_error'] = 'insufficient training data'
        report['blockers'].append(f'insufficient_ridge_training_rows:{len(X)}<50')

    report['status'] = 'completed_diagnostic_only'

    # Write report
    with open(args.output, 'w') as f:
        json.dump(report, f, indent=2, default=str)
    print(f'\nReport written to {args.output}')


if __name__ == '__main__':
    main()
