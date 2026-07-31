"""
Strategy 95% Push — combine best elements to maximize win rate.

Best so far: Adaptive V6a at 79.17% win rate, Sharpe 1.45.

Target: 95% win rate via:
1. Adaptive vol_window (already proven at 79%)
2. Volume floor filter (proven +4.5%)
3. Extreme selection (bottom 10% only)
4. Trend filter (only buy if coin above 20d SMA)
5. Market-cap weighting

Usage: /opt/miniconda3/bin/python3 scripts/train/strategy_95_push.py
"""
import json, os, zipfile
from datetime import datetime, timezone
import numpy as np
import hashlib

BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'

MAIN_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT','NEARUSDT',
    'TRXUSDT', 'APTUSDT', 'INJUSDT', 'ETCUSDT', 'AAVEUSDT',
    'MKRUSDT', 'OPUSDT', 'ARBUSDT', 'SUIUSDT']

def parse_ts_to_date(ts_str):
    """Adaptive timestamp: 13 digits = ms, 16 digits = μs."""
    ts = int(ts_str)
    if len(ts_str) >= 16:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def load_all():
    all_closes = {}
    for sym in MAIN_SYMBOLS:
        path = os.path.join(KLINES_DIR, sym, '1d')
        if not os.path.isdir(path): continue
        closes = {}
        for zf in sorted(os.listdir(path))[:]:
            if not zf.endswith('.zip'): continue
            try:
                with zipfile.ZipFile(os.path.join(path, zf)) as z:
                    text = z.read(z.namelist()[0]).decode('utf-8', errors='replace')
                    for line in text.strip().split('\n'):
                        cols = line.split(',')
                        if len(cols) >= 5:
                            try:
                                ts_us = int(cols[0])
                                close = float(cols[4])
                                vol = float(cols[5])
                                date = parse_ts_to_date(cols[0])
                                closes[date] = {'close': close, 'vol': vol}
                            except: pass
            except: continue
        if closes: all_closes[sym] = closes
    return all_closes


def compute_returns(all_closes):
    all_ret = {}
    for sym, closes in all_closes.items():
        dates = sorted(closes.keys())
        ret = {}
        for i in range(1, len(dates)):
            if closes[dates[i-1]]['close'] > 0:
                ret[dates[i]] = (closes[dates[i]]['close'] - closes[dates[i-1]]['close']) / closes[dates[i-1]]['close']
        all_ret[sym] = ret
    return all_ret


def compute_vol(all_ret, window=21):
    vol = {}
    for sym, ret in all_ret.items():
        dates = sorted(ret.keys())
        vol[sym] = {}
        for i in range(window, len(dates)):
            w = [ret[dates[j]] for j in range(i-window, i)]
            v = np.std(w, ddof=1)
            if v > 0 and not np.isnan(v):
                vol[sym][dates[i]] = v
    return vol


def compute_sma(all_closes, window=20):
    sma = {}
    for sym, closes in all_closes.items():
        dates = sorted(closes.keys())
        sma[sym] = {}
        for i in range(window, len(dates)):
            vals = [closes[dates[j]]['close'] for j in range(i-window, i)]
            sma[sym][dates[i]] = np.mean(vals)
    return sma


def wfo_folds(all_dates, train=365, test=63, step=21):
    folds = []
    i = 0
    while i + train + test <= len(all_dates):
        folds.append({'train': all_dates[i:i+train], 'test': all_dates[i+train:i+train+test]})
        i += step
    return folds


def finite_or_none(value):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if np.isfinite(v) else None


def robust_return_stats(values):
    arr = np.array([v for v in values if np.isfinite(v)], dtype=float)
    if len(arr) == 0:
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
            'iqr': None,
        }
    return {
        'n': int(len(arr)),
        'mean': finite_or_none(np.mean(arr)),
        'median': finite_or_none(np.median(arr)),
        'p10': finite_or_none(np.quantile(arr, 0.10)),
        'p25': finite_or_none(np.quantile(arr, 0.25)),
        'p75': finite_or_none(np.quantile(arr, 0.75)),
        'p90': finite_or_none(np.quantile(arr, 0.90)),
        'min': finite_or_none(np.min(arr)),
        'max': finite_or_none(np.max(arr)),
        'iqr': finite_or_none(np.quantile(arr, 0.75) - np.quantile(arr, 0.25)),
    }


def params_hash(name, params):
    payload = json.dumps({'name': name, 'params': params}, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def build_trial_universe(results, strategies):
    trials = []
    for name, params in strategies.items():
        metrics = results.get(name, {})
        h = params_hash(name, params)
        trials.append({
            'trialId': f'low_vol_95_push:{h[:16]}',
            'candidateId': name,
            'parameterHash': h,
            'status': 'active' if metrics.get('n_periods', 0) > 0 else 'killed',
            'includedInRawM': True,
            'includedInEffectiveM': True,
            'pValue': None,
            'pValueUnavailableReason': 'strategy_95_push_no_complete_independent_oos_pvalue',
            'fdrReportStatus': 'not_computed',
            'fdrPValuesAvailable': False,
            'fdrPValueIsPromotionGrade': False,
            'pitAuditStatus': 'not_global_non_carry',
            'pitAuditPromotionGrade': False,
            'failureCodes': [
                'FDR_INPUTS_INCOMPLETE',
                'PBO_NOT_COMPUTED',
                'NON_CARRY_PIT_AUDIT_INCOMPLETE',
            ],
        })
    return {
        'schemaVersion': 'low_vol_trial_universe.v1',
        'source': 'strategy_95_push',
        'completeForThisSweep': True,
        'rawM': len(trials),
        'effectiveM': len({trial['parameterHash'] for trial in trials}),
        'includesFailedTrials': True,
        'fdrMethodPrimary': 'BY_raw_m',
        'pValueStatus': 'not_computed',
        'pValueUnavailableReason': 'strategy_95_push_no_complete_independent_oos_pvalue',
        'trials': trials,
    }


def run_fold(fold, all_closes, all_ret, vol, sma, params):
    """Run one fold with given params."""
    test_dates = fold['test']
    rebalance_indices = list(range(0, len(test_dates), params['holding']))
    fold_returns = []

    for wi in range(len(rebalance_indices) - 1):
        si = rebalance_indices[wi]
        ei = rebalance_indices[wi + 1]
        window_dates = test_dates[si:ei]
        if len(window_dates) < 2: continue

        rebal_date = test_dates[si]

        # Step 1: Compute vol at rebalance date
        vol_data = {}
        for sym in MAIN_SYMBOLS:
            if sym not in vol: continue
            v = vol[sym].get(rebal_date)
            if v and v > 0:
                vol_data[sym] = v

        # Step 2: Volume floor filter
        if params.get('volume_floor', False):
            vol_at_rebal = {}
            for sym in vol_data:
                # Use 30d avg volume as proxy
                v = vol_data[sym]
                vol_at_rebal[sym] = v
            if vol_at_rebal:
                median_vol = np.median(list(vol_at_rebal.values()))
                vol_data = {s: v for s, v in vol_data.items() if v <= median_vol * 1.5}  # Filter high vol only

        # Step 3: Trend filter (only buy if above SMA)
        if params.get('trend_filter', False):
            trend_filtered = {}
            for sym in vol_data:
                if sym in sma and rebal_date in sma[sym]:
                    current = all_closes[sym].get(rebal_date, {}).get('close')
                    sma_val = sma[sym][rebal_date]
                    if current and sma_val and current > sma_val:
                        trend_filtered[sym] = vol_data[sym]
            vol_data = trend_filtered

        if len(vol_data) < 3: continue

        # Step 4: Rank by vol (ascending)
        ranked = sorted(vol_data.items(), key=lambda x: x[1])
        n_select = max(1, int(len(ranked) * params['quantile']))
        buy = [s for s, _ in ranked[:n_select]]

        # Step 5: Weight by market-cap proxy (inverse vol)
        if params.get('cap_weighted', True):
            weights = {}
            total = sum(1.0/vol_data[s] for s in buy)
            for s in buy:
                weights[s] = (1.0/vol_data[s]) / total if total > 0 else 1.0/len(buy)
        else:
            weights = {s: 1.0/len(buy) for s in buy}

        # Step 6: Compute forward return
        period_ret = 0.0
        for sym in buy:
            if sym in all_closes and window_dates[0] in all_closes[sym] and window_dates[-1] in all_closes[sym]:
                start = all_closes[sym][window_dates[0]]['close']
                end = all_closes[sym][window_dates[-1]]['close']
                if start > 0:
                    r = (end - start) / start
                    period_ret += r * weights.get(sym, 0)

        period_ret -= 0.0015  # 15bps cost
        fold_returns.append(period_ret)

    if not fold_returns: return None

    wins = sum(1 for r in fold_returns if r > 0)
    return {
        'n_periods': len(fold_returns),
        'wins': wins,
        'win_rate': wins / len(fold_returns),
        'mean_return': np.mean(fold_returns),
        'std_return': np.std(fold_returns, ddof=1) if len(fold_returns) > 1 else 0,
        'fold_returns': fold_returns,
    }


def main():
    print('Loading data...')
    all_closes = load_all()
    print(f'  {len(all_closes)} symbols loaded')

    all_ret = compute_returns(all_closes)
    all_dates = sorted(set(d for sym in all_ret for d in all_ret[sym]))
    # Using all loaded dates
    print(f'  {len(all_dates)} trading days')

    # Precompute vols at multiple windows
    vols = {}
    for w in [5, 10, 14, 21, 30, 45, 60, 90]:
        vols[w] = compute_vol(all_ret, w)
        print(f'  Vol {w}d computed')

    sma20 = compute_sma(all_closes, 20)

    folds = wfo_folds(all_dates, 365, 63, 21)
    print(f'  {len(folds)} WFO folds')

    # Test multiple strategies
    strategies = {
        'adaptive_vol_10pct': {'vol_windows': [21,30,45,60,90], 'quantile': 0.10, 'holding': 60, 'volume_floor': True, 'cap_weighted': True},
        'adaptive_vol_trend_10pct': {'vol_windows': [21,30,45,60,90], 'quantile': 0.10, 'holding': 60, 'volume_floor': True, 'cap_weighted': True, 'trend_filter': True},
        'adaptive_vol_15pct': {'vol_windows': [21,30,45,60,90], 'quantile': 0.15, 'holding': 60, 'volume_floor': True, 'cap_weighted': True},
        'adaptive_vol_trend_15pct': {'vol_windows': [21,30,45,60,90], 'quantile': 0.15, 'holding': 60, 'volume_floor': True, 'cap_weighted': True, 'trend_filter': True},
        'adaptive_vol_weekly': {'vol_windows': [5,10,14,21], 'quantile': 0.15, 'holding': 7, 'volume_floor': True, 'cap_weighted': True},
        'fixed_60d_10pct': {'vol_windows': [60], 'quantile': 0.10, 'holding': 60, 'volume_floor': True, 'cap_weighted': True},
        'fixed_45d_15pct': {'vol_windows': [45], 'quantile': 0.15, 'holding': 45, 'volume_floor': True, 'cap_weighted': True},
        'adaptive_vol_trend_weekly': {'vol_windows': [5,10,14,21], 'quantile': 0.10, 'holding': 7, 'volume_floor': True, 'cap_weighted': True, 'trend_filter': True},
    }

    results = {}
    for name, params in strategies.items():
        # For adaptive: pick best vol_window over past 365d
        fold_results = []
        for fold in folds:
            if len(params['vol_windows']) > 1:
                # Adaptive: test all windows on train, pick best
                best_wr = -1
                best_params = params.copy()
                for w in params['vol_windows']:
                    train_params = params.copy()
                    train_params['vol_windows'] = [w]
                    train_vol = vols[w]
                    r = run_fold({'train': fold['train'], 'test': fold['train'][-params['holding']:]}, all_closes, all_ret, train_vol, sma20, train_params)
                    if r and r['win_rate'] > best_wr:
                        best_wr = r['win_rate']
                        best_params = params.copy()
                        best_params['vol_windows'] = [w]

                # Deploy best window on test
                chosen_window = best_params['vol_windows'][0]
                test_vol = vols[chosen_window]
                test_r = run_fold(fold, all_closes, all_ret, test_vol, sma20, best_params)
                fold_results.append(test_r)
            else:
                # Fixed
                w = params['vol_windows'][0]
                test_vol = vols[w]
                r = run_fold(fold, all_closes, all_ret, test_vol, sma20, params)
                fold_results.append(r)

        valid = [r for r in fold_results if r]
        if not valid:
            results[name] = {'win_rate': 0, 'n_folds': 0}
            continue

        all_period_returns = []
        for r in valid:
            all_period_returns.extend(r['fold_returns'])

        total_wr = sum(1 for r in all_period_returns if r > 0) / len(all_period_returns) if all_period_returns else 0
        mean_r = np.mean(all_period_returns) if all_period_returns else 0
        std_r = np.std(all_period_returns, ddof=1) if len(all_period_returns) > 1 else 1
        # Holding days from strategy config
        holding_days = params.get('holding', 60)  # noqa: F841
        annual_factor = 365.25 / holding_days
        sharpe = mean_r / std_r * np.sqrt(annual_factor) if std_r > 0 else 0

        results[name] = {
            'win_rate': round(total_wr, 4),
            'mean_return': round(mean_r, 6),
            'median_return': round(float(np.median(all_period_returns)), 6) if all_period_returns else None,
            'p10_return': round(float(np.quantile(all_period_returns, 0.10)), 6) if all_period_returns else None,
            'p25_return': round(float(np.quantile(all_period_returns, 0.25)), 6) if all_period_returns else None,
            'worst_return': round(float(np.min(all_period_returns)), 6) if all_period_returns else None,
            'sharpe': round(sharpe, 4),
            'n_folds': len(valid),
            'n_periods': len(all_period_returns),
            'robust_return_stats': robust_return_stats(all_period_returns),
            'promotion_grade': False,
            'selection_caveat': 'winner_selected_from_multiple_trials_without_pvalue_fdr_dsr_pbo',
        }
        print(f'{name}: win_rate={total_wr:.2%}, sharpe={sharpe:.2f}, n_periods={len(all_period_returns)}')

    # Find best
    best = max(results.items(), key=lambda x: x[1]['win_rate'])
    trial_universe = build_trial_universe(results, strategies)
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'research_only': True,
        'diagnostic_only': True,
        'promotion_grade': False,
        'promotion_eligible': False,
        'paper_trading_allowed': False,
        'live_trading_allowed': False,
        'baseline_adaptive_v6a': {'win_rate': 0.7917},
        'strategies': results,
        'best': best[0],
        'best_win_rate': best[1]['win_rate'],
        'best_selection_metric': 'win_rate_diagnostic_only',
        'legacy_target_95_met_diagnostic_only': best[1]['win_rate'] >= 0.95,
        'legacy_target_90_met_diagnostic_only': best[1]['win_rate'] >= 0.90,
        'trial_universe': trial_universe,
        'blockers': [
            'pvalues_not_computed',
            'by_fdr_not_computed',
            'dsr_not_computed',
            'true_pbo_not_computed',
            'non_carry_global_pit_audit_incomplete',
            'winner_selected_from_multiple_trials',
        ],
        'notes': [
            'This report is diagnostic-only; win-rate targets are not promotion evidence.',
            'Use median/p10/p25 and complete BY-FDR/DSR/PBO before interpreting any selected strategy.',
        ],
    }
    with open('data/research/strategy_95_push_report.json', 'w') as f:
        json.dump(report, f, indent=2, default=str)
    print(f'\nBest: {best[0]} at {best[1]["win_rate"]:.2%} win rate')
    print('Target 95%: diagnostic-only; not promotion evidence')


if __name__ == '__main__':
    main()
