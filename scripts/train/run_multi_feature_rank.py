"""
Multi-feature rank IC — combine multiple features to improve ICIR.

Usage:
    /opt/miniconda3/bin/python3 scripts/train/run_multi_feature_rank.py
"""
import json, os, sys
from datetime import datetime, timezone
from collections import defaultdict

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ic_computation import (
    compute_ic_series, compute_icir, compute_ic_drawdown,
    compute_normalized_ic_drawdown, effective_n_correction,
    top_bottom_net_return,
)
from ridge_ranker import train_ridge_ranker
from wfo_validator import walk_forward_validation
from naive_baselines import shuffled_label_negative_control

FEATURE_PATH = 'data/research/features.jsonl'
LABEL_PATH = 'data/research/labels_24h.jsonl'
OUTPUT_PATH = 'data/research/multi_feature_report.json'


def load_all_features(path):
    """Load whole feature JSONL into a flat DataFrame."""
    rows = []
    with open(path) as f:
        for line in f:
            if line.strip():
                row = json.loads(line)
                flat = {'timestamp': row['timestamp'], 'symbol': row['symbol']}
                if 'features' in row:
                    for k, v in row['features'].items():
                        flat[k] = v
                rows.append(flat)
    df = pd.DataFrame(rows)
    df['timestamp'] = pd.to_datetime(df['timestamp'], format='ISO8601')
    return df


def load_labels(path):
    rows = []
    with open(path) as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    df = pd.DataFrame(rows)
    df['timestamp'] = pd.to_datetime(df['timestamp'], format='ISO8601')
    return df


def compute_composite_factor(df, feature_weights: dict[str, float], label_df):
    """Compute composite factor score as weighted sum of z-scored features.

    For each timestamp × symbol, compute z-score of each feature, multiply by
    weight, sum → composite factor score.
    """
    all_ts = sorted(df['timestamp'].unique())
    symbols = df['symbol'].unique()
    factor_rows = []
    return_rows = []

    for ts in all_ts:
        ts_df = df[df['timestamp'] == ts]
        scores = {}
        for _, row in ts_df.iterrows():
            sym = row['symbol']
            score = 0.0
            n_feat = 0
            for feat, weight in feature_weights.items():
                val = row.get(feat)
                if val is not None and np.isfinite(val):
                    score += val * weight
                    n_feat += 1
            if n_feat > 0:
                scores[sym] = score

        if len(scores) < 3:
            continue

        # Z-score the composite scores (cross-sectional)
        vals = np.array(list(scores.values()))
        v_mean, v_std = np.mean(vals), np.std(vals, ddof=1)
        if v_std > 1e-12:
            for sym in scores:
                scores[sym] = (scores[sym] - v_mean) / v_std

        # Match with forward returns from label file
        label_rows = label_df[label_df['timestamp'] == ts]
        for _, lr in label_rows.iterrows():
            sym = lr['symbol']
            net_ret = lr.get('forward_net_return')
            if sym in scores and net_ret is not None and np.isfinite(net_ret):
                factor_rows.append({'timestamp': ts, 'symbol': sym, 'factor': scores[sym]})
                return_rows.append({'timestamp': ts, 'symbol': sym, 'return': net_ret})

    f_df = pd.DataFrame(factor_rows).pivot(index='timestamp', columns='symbol', values='factor')
    r_df = pd.DataFrame(return_rows).pivot(index='timestamp', columns='symbol', values='return')
    return f_df.apply(pd.to_numeric, errors='coerce'), r_df.apply(pd.to_numeric, errors='coerce')


def main():
    print('Loading data...')
    df = load_all_features(FEATURE_PATH)
    label_df = load_labels(LABEL_PATH)
    print(f'  {len(df)} feature rows, {len(label_df)} label rows')
    print(f'  Symbols: {list(df["symbol"].unique())}')

    reports = []

    # Strategy 1: ret_24h alone (baseline)
    print('\n=== Strategy 1: ret_24h alone ===')
    f1, r1 = compute_composite_factor(df, {'ret_24h': 1.0}, label_df)
    common = f1.index.intersection(r1.index)
    f1, r1 = f1.loc[common], r1.loc[common]
    ic1 = compute_ic_series(f1, r1)
    if len(ic1) > 0:
        rep1 = {
            'name': 'ret_24h_alone',
            'features': ['ret_24h'],
            'n_assets': f1.shape[1],
            'n_timesteps': len(ic1),
            'mean_ic': float(ic1.mean()),
            'icir': compute_icir(ic1),
            'drawdown': compute_ic_drawdown(ic1),
            'norm_drawdown': compute_normalized_ic_drawdown(ic1),
            'eff_n': effective_n_correction(ic1),
            'spread': float(top_bottom_net_return(f1, r1).mean()),
        }
        print(f'  Assets={rep1["n_assets"]}, IC={rep1["mean_ic"]:.4f}, ICIR={rep1["icir"]:.4f}')
        reports.append(rep1)

    # Strategy 2: ret_1h + ret_24h (short + medium term)
    print('\n=== Strategy 2: ret_1h + ret_24h ===')
    f2, r2 = compute_composite_factor(df, {'ret_1h': 0.5, 'ret_24h': 1.0}, label_df)
    common = f2.index.intersection(r2.index)
    f2, r2 = f2.loc[common], r2.loc[common]
    ic2 = compute_ic_series(f2, r2)
    if len(ic2) > 0:
        rep2 = {
            'name': 'ret_1h_plus_24h',
            'features': ['ret_1h', 'ret_24h'],
            'n_assets': f2.shape[1],
            'n_timesteps': len(ic2),
            'mean_ic': float(ic2.mean()),
            'icir': compute_icir(ic2),
            'drawdown': compute_ic_drawdown(ic2),
            'norm_drawdown': compute_normalized_ic_drawdown(ic2),
            'eff_n': effective_n_correction(ic2),
            'spread': float(top_bottom_net_return(f2, r2).mean()),
        }
        print(f'  Assets={rep2["n_assets"]}, IC={rep2["mean_ic"]:.4f}, ICIR={rep2["icir"]:.4f}')
        reports.append(rep2)

    # Strategy 3: ret_1h + ret_24h + funding_z_30d + realized_vol_24h
    print('\n=== Strategy 3: All available features ===')
    f3, r3 = compute_composite_factor(df, {
        'ret_1h': 0.3, 'ret_24h': 0.7,
        'funding_z_30d': 0.5, 'realized_vol_24h': -0.3,
    }, label_df)
    common = f3.index.intersection(r3.index)
    f3, r3 = f3.loc[common], r3.loc[common]
    ic3 = compute_ic_series(f3, r3)
    if len(ic3) > 0:
        rep3 = {
            'name': 'all_four_features',
            'features': ['ret_1h', 'ret_24h', 'funding_z_30d', 'realized_vol_24h'],
            'n_assets': f3.shape[1],
            'n_timesteps': len(ic3),
            'mean_ic': float(ic3.mean()),
            'icir': compute_icir(ic3),
            'drawdown': compute_ic_drawdown(ic3),
            'norm_drawdown': compute_normalized_ic_drawdown(ic3),
            'eff_n': effective_n_correction(ic3),
            'spread': float(top_bottom_net_return(f3, r3).mean()),
        }
        print(f'  Assets={rep3["n_assets"]}, IC={rep3["mean_ic"]:.4f}, ICIR={rep3["icir"]:.4f}')
        reports.append(rep3)

    # WFO-Lite on best strategy
    if reports:
        best = max(reports, key=lambda r: r['icir'])
        print(f'\n=== WFO-Lite on best: {best["name"]} ===')
        best_f, best_r = {
            'ret_24h_alone': (f1, r1),
            'ret_1h_plus_24h': (f2, r2),
            'all_four_features': (f3, r3),
        }[best['name']]

        # Build flat training data
        symbols = best_f.columns
        train_rows = []
        for ts in best_f.index:
            row = {'timestamp': ts}
            for sym in symbols:
                fv = best_f.loc[ts, sym]
                rv = best_r.loc[ts, sym]
                if pd.notna(fv) and pd.notna(rv):
                    row[f'f_{sym}'] = fv
            if len(row) > 1:
                train_rows.append(row)

        X = pd.DataFrame(train_rows).set_index('timestamp').fillna(0).apply(pd.to_numeric, errors='coerce')
        y = best_r.mean(axis=1).loc[X.index]

        # Naive baselines
        from scipy.stats import spearmanr
        rand_y = y.sample(frac=1).values
        rand_ic = spearmanr(rand_y, np.random.randn(len(rand_y)))[0]
        print(f'  Random rank IC: {rand_ic:.4f}')

        if len(X) >= 60:
            wfo = walk_forward_validation(X, y, train_window=60, test_window=14, step=7, embargo=24)
            if wfo['status'] == 'completed':
                s = wfo['summary']
                print(f'  WFO folds: {wfo["fold_count"]}, mean IC: {s["mean_ic"]:.4f}, pass rate: {s["pass_rate"]:.2f}')
                best['wfo'] = s
                best['wfo_pass'] = s['mean_ic'] > 0 and s['pass_rate'] > 0.3
                print(f'  M1 pass: {"✅" if best["wfo_pass"] else "❌"}')

    # Write report
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'status': 'completed',
        'strategies': reports,
        'recommendation': max(reports, key=lambda r: r['icir']) if reports else None,
    }
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(report, f, indent=2, default=str)
    print(f'\nReport written to {OUTPUT_PATH}')

    # Summary table
    print('\n' + '=' * 80)
    print(f'{"Strategy":30s} {"Assets":>6s} {"IC":>8s} {"ICIR":>6s} {"Drawdown":>10s} {"Spread":>10s}')
    print('=' * 80)
    for r in reports:
        print(f'{r["name"]:30s} {r["n_assets"]:6d} {r["mean_ic"]:8.4f} {r["icir"]:6.4f} {r["norm_drawdown"]:10.2f} {r["spread"]:10.6f}')


if __name__ == '__main__':
    main()
