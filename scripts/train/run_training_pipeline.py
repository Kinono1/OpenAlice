"""
Run Training Pipeline — Phase 0 through 4 orchestrator.

Usage:
    /opt/miniconda3/bin/python3 scripts/train/run_training_pipeline.py \
        --feature-path data/research/features.jsonl \
        --output-path data/research/training_report.json \
        --wfo-train 60 --wfo-test 14 --wfo-embargo 24
"""
import argparse
import json
import sys
import os
from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pandas as pd

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from train.ic_computation import (
    compute_ic_series,
    compute_icir,
    compute_ic_drawdown,
    compute_normalized_ic_drawdown,
    effective_n_correction,
    negative_control_test,
    top_bottom_net_return,
)
from train.ridge_ranker import train_ridge_ranker
from train.wfo_validator import walk_forward_validation, compute_pbo_cscv_report
from train.naive_baselines import (
    equal_weight_universe,
    raw_factor_rank_baseline,
    random_rank_baseline,
    shuffled_label_negative_control,
)


DEFAULT_FEATURE_COLUMNS = [
    'ret_1h',
    'ret_4h',
    'ret_24h',
    'realized_vol_24h',
    'volume_z_24h',
    'funding_rate',
    'funding_z_30d',
    'basis_bps',
    'btc_ret_24h',
    'market_dispersion',
]


@dataclass
class LabelMatrices:
    net: pd.DataFrame
    gross: pd.DataFrame | None
    estimated_cost_bps: pd.DataFrame | None
    raw: pd.DataFrame
    net_column: str
    gross_column: str | None


def parse_horizon_hours(value: str) -> int:
    normalized = str(value).strip().lower()
    if normalized.endswith('hours'):
        normalized = normalized[:-5]
    elif normalized.endswith('hour'):
        normalized = normalized[:-4]
    elif normalized.endswith('h'):
        normalized = normalized[:-1]
    normalized = normalized.strip()
    if not normalized:
        raise ValueError('return horizon is empty')
    hours = int(normalized)
    if hours <= 0:
        raise ValueError(f'return horizon must be positive: {value}')
    return hours


def default_label_path(feature_path: str, return_horizon: str) -> str:
    horizon_hours = parse_horizon_hours(return_horizon)
    base_dir = os.path.dirname(feature_path) or '.'
    return os.path.join(base_dir, f'labels_{horizon_hours}h.jsonl')


def _read_jsonl(path: str) -> list[dict]:
    rows = []
    with open(path) as f:
        for line_no, line in enumerate(f, start=1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f'Invalid JSON in {path}:{line_no}: {exc}') from exc
    if not rows:
        raise ValueError(f'No data in {path}')
    return rows


def load_feature_matrix(path: str) -> tuple[dict[str, pd.DataFrame], pd.DataFrame]:
    """Load feature matrix from JSONL (output of generate_features_labels.py).

    Expects each line: {"timestamp": ..., "symbol": ..., "features": {...}, "metadata": {...}}
    Expands features dict into columns.
    """
    rows = []
    for row in _read_jsonl(path):
        flat = {'timestamp': row['timestamp'], 'symbol': row['symbol']}
        if 'features' in row and isinstance(row['features'], dict):
            for k, v in row['features'].items():
                flat[k] = v
        rows.append(flat)

    df = pd.DataFrame(rows)
    df['timestamp'] = pd.to_datetime(df['timestamp'], format='ISO8601', utc=True)
    df = df.sort_values(['timestamp', 'symbol'])

    feature_names = [c for c in df.columns if c not in ('timestamp', 'symbol')]

    feature_matrices = {}
    for fn in feature_names:
        matrix = df.pivot_table(index='timestamp', columns='symbol', values=fn, aggfunc='last')
        feature_matrices[fn] = matrix.apply(pd.to_numeric, errors='coerce')

    return feature_matrices, df.set_index('timestamp').sort_index()


def _select_label_column(columns: pd.Index, base_name: str, horizon_hours: int, required: bool) -> str | None:
    candidates = [base_name, f'{base_name}_{horizon_hours}h']
    for candidate in candidates:
        if candidate in columns:
            return candidate
    prefixed = [c for c in columns if isinstance(c, str) and c.startswith(f'{base_name}_')]
    if len(prefixed) == 1:
        return prefixed[0]
    if required:
        raise ValueError(
            f'Label file must contain {base_name} or {base_name}_{horizon_hours}h; '
            f'found columns: {list(columns)}'
        )
    return None


def load_label_matrices(path: str, horizon_hours: int) -> LabelMatrices:
    """Load real forward-return labels and pivot them to timestamp x symbol matrices."""
    df = pd.DataFrame(_read_jsonl(path))
    if 'timestamp' not in df or 'symbol' not in df:
        raise ValueError(f'Label file {path} must contain timestamp and symbol columns')

    if 'horizon_hours' in df:
        parsed_horizon = pd.to_numeric(df['horizon_hours'], errors='coerce')
        known_horizon = parsed_horizon.dropna().astype(int)
        mismatched = known_horizon[known_horizon != horizon_hours]
        if not mismatched.empty:
            examples = df.loc[mismatched.index, 'horizon_hours'].head(5).tolist()
            raise ValueError(
                f'Label file {path} contains horizon_hours values that do not match '
                f'{horizon_hours}h: {examples}'
            )

    net_column = _select_label_column(df.columns, 'forward_net_return', horizon_hours, required=True)
    gross_column = _select_label_column(df.columns, 'forward_gross_return', horizon_hours, required=False)

    df['timestamp'] = pd.to_datetime(df['timestamp'], format='ISO8601', utc=True)
    df = df.sort_values(['timestamp', 'symbol'])

    def pivot(column: str) -> pd.DataFrame:
        matrix = df.pivot_table(index='timestamp', columns='symbol', values=column, aggfunc='last')
        return matrix.apply(pd.to_numeric, errors='coerce')

    cost_matrix = None
    if 'estimated_cost_bps' in df:
        cost_matrix = pivot('estimated_cost_bps')

    return LabelMatrices(
        net=pivot(net_column),
        gross=pivot(gross_column) if gross_column else None,
        estimated_cost_bps=cost_matrix,
        raw=df.set_index('timestamp').sort_index(),
        net_column=net_column,
        gross_column=gross_column,
    )


def select_feature_names(
    feature_matrices: dict[str, pd.DataFrame],
    requested_features: str | None = None,
) -> list[str]:
    if requested_features:
        requested = [part.strip() for part in requested_features.split(',') if part.strip()]
        missing = [name for name in requested if name not in feature_matrices]
        if missing:
            raise ValueError(f'Requested feature(s) missing from feature file: {missing}')
        return requested

    selected = [name for name in DEFAULT_FEATURE_COLUMNS if name in feature_matrices]
    if not selected:
        selected = sorted(feature_matrices.keys())
    if not selected:
        raise ValueError('No feature columns found in feature file')
    return selected


def align_factor_and_returns(
    factor_matrix: pd.DataFrame,
    return_matrix: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    common_idx = factor_matrix.index.intersection(return_matrix.index)
    common_symbols = factor_matrix.columns.intersection(return_matrix.columns)
    return factor_matrix.loc[common_idx, common_symbols], return_matrix.loc[common_idx, common_symbols]


def build_training_frame(
    feature_matrices: dict[str, pd.DataFrame],
    return_matrix: pd.DataFrame,
    selected_features: list[str],
    min_feature_coverage: float = 0.8,
) -> tuple[pd.DataFrame, pd.Series, dict]:
    """Build timestamp-level training data using real labels.

    Rows with incomplete selected features are dropped explicitly. Missing values are not
    imputed because zero-imputation changes the meaning of sparse market features.
    """
    frames = []
    for feature_name in selected_features:
        frame = feature_matrices[feature_name].copy()
        frame.columns = [f'{feature_name}__{symbol}' for symbol in frame.columns]
        frames.append(frame)

    X = pd.concat(frames, axis=1).sort_index()
    y = return_matrix.mean(axis=1, skipna=True).rename('forward_net_return_mean')

    common_idx = X.index.intersection(y.dropna().index)
    X = X.loc[common_idx]
    y = y.loc[common_idx]
    initial_rows = len(X)
    initial_columns = X.shape[1]

    X = X.dropna(axis=1, how='all')
    coverage = X.notna().mean(axis=0)
    X = X.loc[:, coverage >= min_feature_coverage]
    if X.shape[1] == 0:
        raise ValueError(
            f'No feature columns meet min_feature_coverage={min_feature_coverage}; '
            f'initial_columns={initial_columns}'
        )

    complete_mask = X.notna().all(axis=1) & y.notna()
    X_complete = X.loc[complete_mask]
    y_complete = y.loc[complete_mask]

    stats = {
        'initial_rows': int(initial_rows),
        'initial_columns': int(initial_columns),
        'selected_rows': int(len(X_complete)),
        'selected_columns': int(X_complete.shape[1]),
        'dropped_all_null_columns': int(initial_columns - len(coverage)),
        'dropped_low_coverage_columns': int((coverage < min_feature_coverage).sum()),
        'dropped_missing_rows': int(initial_rows - len(X_complete)),
        'min_feature_coverage': float(min_feature_coverage),
        'feature_columns': list(X_complete.columns),
    }
    return X_complete, y_complete, stats


def finite_or_none(value):
    if value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if np.isfinite(value) else None


def main():
    parser = argparse.ArgumentParser(description='Run training pipeline')
    parser.add_argument('--feature-path', required=True, help='Path to feature JSONL from feature_builder.ts')
    parser.add_argument('--label-path', default=None, help='Path to real forward-return label JSONL')
    parser.add_argument('--output-path', default='data/research/training_report.json')
    parser.add_argument('--wfo-train', type=int, default=60, help='WFO train window (days)')
    parser.add_argument('--wfo-test', type=int, default=14, help='WFO test window (days)')
    parser.add_argument('--wfo-embargo', type=int, default=24, help='WFO embargo (hours)')
    parser.add_argument('--return-horizon', type=str, default='24h', help='Forward return horizon')
    parser.add_argument('--features', default=None, help='Comma-separated feature names to train on')
    parser.add_argument('--min-feature-coverage', type=float, default=0.8)
    args = parser.parse_args()
    horizon_hours = parse_horizon_hours(args.return_horizon)
    label_path = args.label_path or default_label_path(args.feature_path, args.return_horizon)

    report = {
        'generated_at': datetime.utcnow().isoformat() + 'Z',
        'status': 'running_diagnostic_only',
        'researchOnly': True,
        'diagnosticOnly': True,
        'promotionGrade': False,
        'promotionEligible': False,
        'paperTradingAllowed': False,
        'liveTradingAllowed': False,
        'blockers': [],
        'config': {
            'wfo_train': args.wfo_train,
            'wfo_test': args.wfo_test,
            'wfo_embargo': args.wfo_embargo,
            'return_horizon': args.return_horizon,
            'horizon_hours': horizon_hours,
            'feature_path': args.feature_path,
            'label_path': label_path,
            'min_feature_coverage': args.min_feature_coverage,
            'model': 'Ridge',
        },
    }
    failed = False

    try:
        # Phase 0: Load features
        print(f'Loading features from {args.feature_path}...')
        feature_matrices, raw_df = load_feature_matrix(args.feature_path)
        report['samples'] = len(raw_df)
        selected_features = select_feature_names(feature_matrices, args.features)
        report['selected_features'] = selected_features
        print(f'Available features: {list(feature_matrices.keys())}')
        print(f'Selected features: {selected_features}')

        print(f'Loading labels from {label_path}...')
        labels = load_label_matrices(label_path, horizon_hours)
        report['label_samples'] = len(labels.raw)
        report['label_columns'] = {
            'net': labels.net_column,
            'gross': labels.gross_column,
        }

        primary_factor_name = 'ret_24h' if 'ret_24h' in selected_features else selected_features[0]
        print(f'Primary factor: {primary_factor_name}')

        print('Computing IC diagnostics...')

        # Phase 0.5: Run diagnostics on available features
        diagnostics = {}
        for feat_name in selected_features:
            fm, aligned_returns = align_factor_and_returns(feature_matrices[feat_name], labels.net)
            ic_series = compute_ic_series(fm, aligned_returns)
            if len(ic_series) > 0:
                icir = compute_icir(ic_series)
                idd = compute_ic_drawdown(ic_series)
                nid = compute_normalized_ic_drawdown(ic_series)
                eff_n = effective_n_correction(ic_series)
                diagnostics[feat_name] = {
                    'mean_ic': float(ic_series.mean()),
                    'std_ic': float(ic_series.std(ddof=1)),
                    'icir': icir,
                    'drawdown': idd,
                    'normalized_drawdown': nid,
                    'effective_n': eff_n,
                    'n_observations': int(len(ic_series)),
                    'n_assets': int(len(fm.columns)),
                    'ic_series': ic_series.tolist()[:10],  # just a sample
                }

        report['feature_diagnostics'] = diagnostics
        primary_diag = diagnostics.get(primary_factor_name)
        if primary_diag:
            report['ic'] = {
                'spearmanRankIc': primary_diag['mean_ic'],
                'effectiveNCorrected': True,
                'icir': primary_diag['icir'],
                'icirMethod': 'spearman_rank_ic_newey_west_effective_n',
            }
            report['ic_diagnostics'] = {
                'spearman_rank_ic_mean': primary_diag['mean_ic'],
                'spearman_rank_ic_std': primary_diag['std_ic'],
                'icir': primary_diag['icir'],
                't_stat_effective_n': (
                    primary_diag['icir'] * np.sqrt(min(primary_diag['effective_n'], primary_diag['n_observations']))
                    if primary_diag['n_observations'] else 0.0
                ),
                'ic_drawdown': primary_diag['drawdown'],
                'normalized_ic_drawdown': primary_diag['normalized_drawdown'],
                'effective_n': primary_diag['effective_n'],
                'nominal_n': primary_diag['n_observations'],
                'ic_gt_003': primary_diag['mean_ic'] > 0.03,
                'icir_gt_03': primary_diag['icir'] > 0.3,
            }

        # Phase 0.5: Naive baselines
        print('Computing naive baselines...')
        baselines = {}
        ew_returns = equal_weight_universe(labels.net.dropna(how='all'))
        baselines['equal_weight_mean_return'] = float(ew_returns.mean())

        label_mean = labels.net.mean(axis=1).dropna()
        if len(label_mean) >= 3:
            baselines['random_rank'] = random_rank_baseline(label_mean.iloc[-100:])

        primary_factor, primary_net_returns = align_factor_and_returns(
            feature_matrices[primary_factor_name],
            labels.net,
        )
        if len(primary_factor) > 0:
            f_last = primary_factor.iloc[-1].dropna()
            r_last = primary_net_returns.iloc[-1].dropna()
            common_sym = f_last.index.intersection(r_last.index)
            if len(common_sym) >= 4:
                baselines['raw_factor_rank'] = raw_factor_rank_baseline(
                    f_last.loc[common_sym],
                    r_last.loc[common_sym],
                    top_pct=0.25,
                )

        report['naive_baselines'] = baselines

        # Phase 1: IC/ICIR/Drawdown
        print(f'P1: IC/ICIR/Drawdown: {json.dumps(diagnostics, indent=2)[:300]}')

        # Phase 1b: Top-bottom return spread using real labels
        net_spread = top_bottom_net_return(primary_factor, primary_net_returns, top_n=1, bottom_n=1)
        gross_spread = None
        if labels.gross is not None:
            _, primary_gross_returns = align_factor_and_returns(feature_matrices[primary_factor_name], labels.gross)
            gross_spread = top_bottom_net_return(primary_factor, primary_gross_returns, top_n=1, bottom_n=1)

        net_spread_mean = finite_or_none(net_spread.mean()) if len(net_spread) > 0 else None
        gross_spread_mean = finite_or_none(gross_spread.mean()) if gross_spread is not None and len(gross_spread) > 0 else None
        report['top_bottom_spread'] = net_spread_mean
        report['topBottomSpread'] = {
            'grossReturn': gross_spread_mean,
            'netReturn': net_spread_mean,
        }
        if gross_spread_mean is not None and net_spread_mean is not None:
            gross_edge_pct = gross_spread_mean * 100
            report['turnover'] = {
                'costPct': max(0.0, (gross_spread_mean - net_spread_mean) * 100),
                'grossEdgePct': gross_edge_pct,
            }

        common_label_dates = primary_net_returns.dropna(how='all').index.normalize().unique()
        report['continuousValidDays'] = int(len(common_label_dates))

        matrix_negative_control = negative_control_test(primary_factor, primary_net_returns, n_permutations=20)
        report['negativeControl'] = {
            'shuffledLabelIc': matrix_negative_control['shuffled_mean_ic'],
            'originalMeanIc': matrix_negative_control['original_mean_ic'],
            'leakageDetected': matrix_negative_control['leakage_detected'],
            'nPermutations': matrix_negative_control['n_permutations'],
        }
        report['negative_control_matrix'] = matrix_negative_control

        # Phase 2: Ridge ranker (if enough data)
        print('P2: Training Ridge ranker...')
        X_train, y_train, training_stats = build_training_frame(
            feature_matrices,
            labels.net,
            selected_features,
            min_feature_coverage=args.min_feature_coverage,
        )
        report['training_frame'] = training_stats

        if len(X_train) > 50:
            model, scaler = train_ridge_ranker(X_train, y_train)
            report['ridge_model_trained'] = True

            from scipy.stats import spearmanr
            preds = model.predict(scaler.transform(X_train.values.astype(float)))
            train_ic = spearmanr(preds, y_train.values)[0]
            report['ridge_is_ic'] = finite_or_none(train_ic)

            # WFO
            print('P3: Walk-forward validation...')
            wfo_result = walk_forward_validation(
                X_train,
                y_train,
                train_window=args.wfo_train,
                test_window=args.wfo_test,
                embargo=args.wfo_embargo,
                holding_bars=horizon_hours,
            )
            summary = wfo_result.get('summary', {})
            report['wfo_lite'] = summary
            report['wfo'] = {
                'status': wfo_result.get('status'),
                'foldCount': wfo_result.get('fold_count', 0),
                'meanIc': finite_or_none(summary.get('mean_ic')),
                'passRate': finite_or_none(summary.get('pass_rate')),
                'medianSpread': finite_or_none(summary.get('median_spread')),
                'stdIc': finite_or_none(summary.get('std_ic')),
                'failedWindowRatio': finite_or_none(summary.get('failed_window_ratio')),
            }

            # PBO requires a complete candidate-return matrix, not one fitted model.
            print('P4: PBO not computed in single-candidate training pipeline...')
            pbo_report = compute_pbo_cscv_report(
                X_train.iloc[:500] if len(X_train) > 500 else X_train,
                y_train.iloc[:500] if len(X_train) > 500 else y_train,
                n_partitions=8 if len(X_train) > 500 else 4,
            )
            report['pbo'] = None
            report['pbo_report'] = pbo_report
            report['blockers'].append('pbo_not_computed_requires_candidate_return_matrix')

            # Negative control for the fitted feature frame.
            nc = shuffled_label_negative_control(
                X_train,
                y_train,
                n_permutations=20,
            )
            report['negative_control'] = nc
        else:
            report['ridge_model_trained'] = False
            report['ridge_error'] = f'Insufficient training data: {len(X_train)} samples'

        report['status'] = 'completed_diagnostic_only'

    except Exception as e:
        failed = True
        report['status'] = 'failed'
        report['error'] = str(e)
        import traceback
        report['traceback'] = traceback.format_exc()

    # Write report
    os.makedirs(os.path.dirname(args.output_path) or '.', exist_ok=True)
    with open(args.output_path, 'w') as f:
        json.dump(report, f, indent=2, default=str)

    print(f'\nReport written to {args.output_path}')
    print(f'Status: {report["status"]}')
    if report.get('pbo') is not None:
        print(f'PBO: {report["pbo"]:.3f}')
        if report['pbo'] < 0.2:
            print('  PASS')
        elif report['pbo'] < 0.4:
            print('  WATCH')
        else:
            print('  FAIL')
    elif report.get('pbo_report'):
        print(f'PBO: {report["pbo_report"].get("status")} ({report["pbo_report"].get("reason")})')

    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
