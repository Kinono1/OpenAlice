"""
Walk-Forward Optimization with embargo and purge diagnostics.

Supports WFO-Lite (60/14/7) and WFO-Formal (180/30/14).
"""
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler
from typing import Tuple, Dict, List, Optional


def walk_forward_validation(
    feature_matrix: pd.DataFrame,
    forward_returns: pd.Series,
    train_window: int = 60,
    test_window: int = 14,
    step: int = 7,
    embargo: int = 24,
    holding_bars: int = 60,
    embargo_unit: str = 'rows',
    model_class=Ridge,
    **model_params,
) -> dict:
    """Walk-forward optimization with embargo gap and label-purge.

    holding_bars: number of rows/bars the forward return label spans.
                  Used to purge train samples whose label window overlaps with test set.
                  Set to 0 to disable purge (legacy behavior).
    embargo_unit: metadata label for the embargo unit. The current implementation
                  treats train/test/step/embargo as row counts, not wall-clock time.

    Returns:
        dict with fold results and summary, each fold includes
        purged_n_train, original_n_train, purge_ratio.
    """
    # Align index
    idx = feature_matrix.index.intersection(forward_returns.index)
    X = feature_matrix.loc[idx]
    y = forward_returns.loc[idx]

    n = len(idx)
    folds = []
    train_start = 0

    fold_id = 0
    while train_start + train_window + embargo + test_window <= n:
        train_end = train_start + train_window
        test_start = train_end + embargo
        test_end = test_start + test_window

        if test_end > n:
            break

        train_idx = idx[train_start:train_end]
        test_idx = idx[test_start:test_end]
        original_n_train = len(train_idx)

        # Purge: remove train samples whose label window overlaps with test
        # A sample at integer position p has label covering [p, p + holding_bars)
        # If p + holding_bars >= test_start, the label overlaps with the test set
        if holding_bars > 0:
            keep_positions = [p for p in range(train_start, train_end) if p + holding_bars < test_start]
            if len(keep_positions) < max(10, original_n_train * 0.3):
                train_start += step
                continue
            train_idx = idx[keep_positions]

        X_train = X.loc[train_idx]
        y_train = y.loc[train_idx]
        X_test = X.loc[test_idx]
        y_test = y.loc[test_idx]

        # Skip folds with insufficient data
        if len(X_train) < 10 or len(X_test) < 3:
            train_start += step
            continue

        try:
            scaler = StandardScaler()
            X_tr_scaled = scaler.fit_transform(X_train.values.astype(float))
            X_te_scaled = scaler.transform(X_test.values.astype(float))

            model = model_class(random_state=42, **model_params)
            model.fit(X_tr_scaled, y_train.values)

            y_pred = model.predict(X_te_scaled)
            y_actual = y_test.values

            pred_rank = pd.Series(y_pred).rank(ascending=False)
            actual_rank = pd.Series(y_actual).rank(ascending=False)

            from scipy.stats import spearmanr
            ic_val = spearmanr(y_pred, y_actual)[0] if len(y_pred) >= 3 else np.nan
            ic_val = float(ic_val) if not np.isnan(ic_val) else None

            n_top = max(1, len(y_pred) // 4)
            top_return = float(np.mean(y_actual[pred_rank <= n_top]))
            bottom_return = float(np.mean(y_actual[pred_rank > len(y_pred) - n_top - 1]))

            folds.append({
                'fold_id': fold_id,
                'train_range': [str(idx[train_start]), str(idx[min(train_end - 1, n - 1)])],
                'test_range': [str(idx[test_start]), str(idx[min(test_end - 1, n - 1)])],
                'n_train': len(X_train),
                'n_test': len(X_test),
                'original_n_train': original_n_train,
                'purge_ratio': 1 - (len(X_train) / original_n_train) if original_n_train > 0 else 0,
                'spearman_ic': ic_val,
                'top_quartile_return': top_return,
                'bottom_quartile_return': bottom_return,
                'spread_return': top_return - bottom_return,
            })
        except Exception as e:
            folds.append({
                'fold_id': fold_id,
                'train_range': [str(train_idx[0]), str(train_idx[-1])],
                'test_range': [str(test_idx[0]), str(test_idx[-1])],
                'n_train': len(X_train),
                'n_test': len(X_test),
                'original_n_train': original_n_train,
                'purge_ratio': 1 - (len(X_train) / original_n_train) if original_n_train > 0 else 0,
                'error': str(e),
            })

        fold_id += 1
        train_start += step

    if not folds:
        return {'status': 'no_folds_generated', 'fold_count': 0}

    ics = [f.get('spearman_ic') for f in folds if f.get('spearman_ic') is not None]
    spreads = [f.get('spread_return', 0) for f in folds if 'spread_return' in f]
    passed = sum(1 for ic in ics if ic > 0.03)

    return {
        'status': 'completed',
        'fold_count': len(folds),
        'fold_results': folds,
        'summary': {
            'mean_ic': float(np.mean(ics)) if ics else 0,
            'std_ic': float(np.std(ics, ddof=1)) if len(ics) > 1 else 0,
            'median_spread': float(np.median(spreads)) if spreads else 0,
            'pass_rate': passed / len(ics) if ics else 0,
            'failed_window_ratio': 1 - (passed / len(ics)) if ics else 1,
            'train_window_rows': train_window,
            'test_window_rows': test_window,
            'embargo_rows': embargo,
            'embargo_unit': embargo_unit,
            'holding_bars': holding_bars,
            'valid_ic_folds': len(ics),
        },
    }


def compute_pbo_cscv(
    feature_matrix: pd.DataFrame,
    forward_returns: pd.Series,
    n_partitions: int = 8,
    n_selected: int = 5,
    model_class=Ridge,
    **model_params,
) -> float:
    """Deprecated single-candidate pseudo-PBO diagnostic.

    This function is intentionally fail-closed because a true PBO requires a
    matrix of candidate return series and IS-winner/OOS-rank CSCV. A single
    fitted model on one feature matrix cannot estimate backtest overfitting
    probability.
    """
    return 1.0


def compute_pbo_cscv_report(
    feature_matrix: pd.DataFrame,
    forward_returns: pd.Series,
    n_partitions: int = 8,
) -> dict:
    """Return a fail-closed report for legacy single-candidate callers."""
    idx = feature_matrix.index.intersection(forward_returns.index)
    return {
        'pbo': None,
        'status': 'not_computed',
        'promotion_grade': False,
        'reason': 'single_candidate_feature_matrix_cannot_estimate_pbo',
        'required_input': 'candidate_return_series_matrix_with_complete_trial_ledger',
        'n_observations': int(len(idx)),
        'n_partitions_requested': int(n_partitions),
    }


def compute_negative_oos_sharpe_rate(wfo_result: dict) -> dict:
    """Compute the fraction of WFO folds with non-positive OOS Sharpe.

    This is NOT the same as PBO (which requires combinatorial selection bias modeling).
    It is a simpler diagnostic: what proportion of out-of-sample paths fail?

    Args:
        wfo_result: output dict from walk_forward_validation()

    Returns:
        dict with:
        - value: float [0, 1], fraction of folds with spearman_ic <= 0
        - n_folds: int
        - n_negative: int
        - note: str explaining what this is and is not
    """
    folds = wfo_result.get('fold_results', [])
    ics = [f.get('spearman_ic') for f in folds if 'spearman_ic' in f and f.get('spearman_ic') is not None]

    if not ics:
        return {'value': None, 'n_folds': 0, 'n_negative': 0, 'note': 'no IC data available'}

    n_negative = sum(1 for ic in ics if ic <= 0)
    return {
        'value': n_negative / len(ics),
        'n_folds': len(ics),
        'n_negative': n_negative,
        'note': 'negative_oos_sharpe_rate = fraction of WFO folds with OOS Spearman IC <= 0. '
                'This is NOT the PBO (Probability of Backtest Overfitting). '
                'PBO requires combinatorial partition selection (CSCV). '
                'This metric serves as a quick diagnostic: values > 0.3 suggest the strategy '
                'fails frequently out-of-sample.',
    }
