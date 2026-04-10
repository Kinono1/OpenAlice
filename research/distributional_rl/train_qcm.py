from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.alpha_pool import AlphaPoolEntry, AlphaPoolWindow, build_alpha_pool_artifact, save_alpha_pool_artifact
from common.data_fetcher import prepare_research_dataset

from distributional_rl.alpha_qcm import AlphaQCMAgent, Transition
from distributional_rl.expression_env import ExpressionEnv, FINISH_ACTION, feature_names_from_tokens


CANONICAL_WINDOWS = (
    ("train", "2023-01-01", "2024-01-01"),
    ("validation", "2024-01-01", "2025-01-01"),
    ("test", "2025-02-11", None),
)
FAMILY_BASELINES = {
    "predictive_baseline": "factor_mean_reversion",
    "mirror": "factor_momentum",
    "conditioning": "factor_volatility_regime",
    "volume_surge": "factor_volume_surge",
    "divergence": "factor_cross_timeframe_divergence",
}


def _window_bounds(frame: pd.DataFrame) -> AlphaPoolWindow:
    return AlphaPoolWindow(
        start=frame.index.min().isoformat(),
        end=frame.index.max().isoformat(),
    )


def build_research_splits(df: pd.DataFrame) -> tuple[dict[str, pd.DataFrame], dict[str, str]]:
    windows = {}
    for name, start, end in CANONICAL_WINDOWS:
        if end is None:
            frame = df[df.index >= start].copy()
        else:
            frame = df[(df.index >= start) & (df.index < end)].copy()
        windows[name] = frame

    if all(len(frame) >= 200 for frame in windows.values()):
        return windows, {"splitMode": "canonical_2023_2024_2025"}

    total_rows = len(df)
    train_end = max(int(total_rows * 0.6), 1)
    validation_end = max(int(total_rows * 0.8), train_end + 1)
    validation_end = min(validation_end, total_rows - 1)
    fallback = {
        "train": df.iloc[:train_end].copy(),
        "validation": df.iloc[train_end:validation_end].copy(),
        "test": df.iloc[validation_end:].copy(),
    }
    if min(len(frame) for frame in fallback.values()) < 20:
        raise RuntimeError("Dataset is too short to construct train/validation/test splits for AlphaQCM.")
    return fallback, {"splitMode": "fallback_temporal_60_20_20"}


def build_family_series(frame: pd.DataFrame) -> dict[str, pd.Series]:
    carry_family = frame[
        ["factor_funding_rate", "factor_basis", "factor_liquidation_pressure"]
    ].mean(axis=1)
    families = {
        family_name: frame[column].astype(float)
        for family_name, column in FAMILY_BASELINES.items()
    }
    families["carry_liquidation"] = carry_family.astype(float)
    return families


def canonicalize_tokens(tokens: list[str]) -> list[str]:
    return [token for token in tokens if token != "unary:identity"]


def series_correlation(left: pd.Series, right: pd.Series) -> float:
    aligned = pd.concat([left.rename("left"), right.rename("right")], axis=1).dropna()
    if len(aligned) < 20:
        return 0.0
    if aligned["left"].nunique(dropna=True) < 2 or aligned["right"].nunique(dropna=True) < 2:
        return 0.0
    correlation = aligned["left"].corr(aligned["right"], method="spearman")
    return 0.0 if pd.isna(correlation) else float(correlation)


def evaluate_candidate(
    env: ExpressionEnv,
    tokens: list[str],
    raw_expression: str,
    splits: dict[str, pd.DataFrame],
    split_meta: dict[str, str],
    family_series: dict[str, dict[str, pd.Series]],
    baseline_test_ic: float,
    total_updates: int,
    mean_loss: float | None,
    args,
) -> dict:
    canonical_tokens = canonicalize_tokens(tokens)
    if not canonical_tokens:
        return {
            "status": "filtered",
            "filterReason": "empty_canonical_expression",
            "rawExpression": raw_expression,
            "rawTokens": tokens,
        }

    canonical_expression = " ".join(canonical_tokens)
    train_metrics = env.evaluate_tokens(
        canonical_tokens,
        reward_frame=splits["train"],
        turnover_frame=splits["train"],
        family_series=family_series["train"],
        allow_partial=False,
    )
    validation_metrics = env.evaluate_tokens(
        canonical_tokens,
        reward_frame=splits["validation"],
        turnover_frame=splits["train"],
        family_series=family_series["validation"],
        allow_partial=False,
    )
    test_metrics = env.evaluate_tokens(
        canonical_tokens,
        reward_frame=splits["test"],
        turnover_frame=splits["train"],
        family_series=family_series["test"],
        allow_partial=False,
    )
    if any(metrics["status"] != "ok" for metrics in (train_metrics, validation_metrics, test_metrics)):
        preview_validation = env.evaluate_tokens(
            canonical_tokens,
            reward_frame=splits["validation"],
            turnover_frame=splits["train"],
            family_series=family_series["validation"],
            allow_partial=True,
        )
        preview_test = env.evaluate_tokens(
            canonical_tokens,
            reward_frame=splits["test"],
            turnover_frame=splits["train"],
            family_series=family_series["test"],
            allow_partial=True,
        )
        preview_corr_to_families = {
            family_name: float(correlation)
            for family_name, correlation in preview_validation["familyCorrelations"].items()
        }
        preview_family_id, preview_family_corr = max(
            preview_corr_to_families.items(),
            key=lambda item: abs(item[1]),
            default=("unknown", 0.0),
        )
        preview_corr_to_baseline = abs(preview_corr_to_families.get("predictive_baseline", 0.0))
        preview_delta_ic = float(preview_test["oos_ic"]) - baseline_test_ic
        return {
            "status": "filtered",
            "filterReason": "invalid_final_expression",
            "rawExpression": raw_expression,
            "rawTokens": tokens,
            "canonicalExpression": canonical_expression,
            "canonicalTokens": canonical_tokens,
            "familyId": preview_family_id,
            "familyCorrelation": float(preview_family_corr),
            "corrToFamilies": preview_corr_to_families,
            "corrToBaseline": float(preview_corr_to_baseline),
            "baselineDeltaIc": float(preview_delta_ic),
            "trainMetrics": train_metrics,
            "validationMetrics": validation_metrics,
            "testMetrics": test_metrics,
            "previewValidationMetrics": preview_validation,
            "previewTestMetrics": preview_test,
        }

    corr_to_families = {
        family_name: float(correlation)
        for family_name, correlation in validation_metrics["familyCorrelations"].items()
    }
    family_id, family_corr = max(
        corr_to_families.items(),
        key=lambda item: abs(item[1]),
        default=("unknown", 0.0),
    )
    corr_to_baseline = abs(corr_to_families.get("predictive_baseline", 0.0))
    baseline_delta_ic = float(test_metrics["oos_ic"]) - baseline_test_ic
    shadow_eligible = (
        total_updates >= 1
        and float(test_metrics["oos_ic"]) > 0
        and baseline_delta_ic >= args.shadow_min_delta_ic
        and corr_to_baseline <= args.max_baseline_correlation
    )
    shadow_failures = []
    if total_updates < 1:
        shadow_failures.append("optimizer_updates")
    if float(test_metrics["oos_ic"]) <= 0:
        shadow_failures.append("non_positive_test_ic")
    if baseline_delta_ic < args.shadow_min_delta_ic:
        shadow_failures.append("negative_delta_to_baseline")
    if corr_to_baseline > args.max_baseline_correlation:
        shadow_failures.append("too_close_to_baseline")

    validation_series = env.series_for_tokens(canonical_tokens, splits["validation"], allow_partial=False)
    return {
        "status": "evaluated",
        "rawExpression": raw_expression,
        "rawTokens": tokens,
        "canonicalExpression": canonical_expression,
        "canonicalTokens": canonical_tokens,
        "featureNames": feature_names_from_tokens(canonical_tokens),
        "familyId": family_id,
        "familyCorrelation": float(family_corr),
        "corrToFamilies": corr_to_families,
        "corrToBaseline": float(corr_to_baseline),
        "baselineDeltaIc": float(baseline_delta_ic),
        "shadowEligible": bool(shadow_eligible),
        "selectionDiagnostics": {
            "optimizerUpdatesOk": total_updates >= 1,
            "positiveTestIc": float(test_metrics["oos_ic"]) > 0,
            "baselineDeltaOk": baseline_delta_ic >= args.shadow_min_delta_ic,
            "baselineCorrelationOk": corr_to_baseline <= args.max_baseline_correlation,
            "shadowEligibilityFailures": shadow_failures,
        },
        "selectionScore": float(validation_metrics["reward"]),
        "trainMetrics": train_metrics,
        "validationMetrics": validation_metrics,
        "testMetrics": test_metrics,
        "validationSeries": validation_series,
        "regimeSummary": {
            "prototype": True,
            "trainingMode": "dry_run" if args.dry_run else "qcm_rl",
            "optimizerUpdates": total_updates,
            "meanLoss": mean_loss,
            "episodes": args.episodes,
            "maxSteps": args.max_steps,
            "batchSize": args.batch_size,
            "epsilon": args.epsilon,
            "splitMode": split_meta["splitMode"],
            "familyId": family_id,
            "corrToFamilies": corr_to_families,
            "corrToBaseline": float(corr_to_baseline),
            "baselineDeltaIc": float(baseline_delta_ic),
            "shadowEligible": bool(shadow_eligible),
            "selectionDiagnostics": {
                "optimizerUpdatesOk": total_updates >= 1,
                "positiveTestIc": float(test_metrics["oos_ic"]) > 0,
                "baselineDeltaOk": baseline_delta_ic >= args.shadow_min_delta_ic,
                "baselineCorrelationOk": corr_to_baseline <= args.max_baseline_correlation,
                "shadowEligibilityFailures": shadow_failures,
            },
            "selectionScore": float(validation_metrics["reward"]),
            "trainIc": float(train_metrics["oos_ic"]),
            "validationIc": float(validation_metrics["oos_ic"]),
            "testIc": float(test_metrics["oos_ic"]),
            "validationReward": float(validation_metrics["reward"]),
            "testReward": float(test_metrics["reward"]),
            "windows": {
                window_name: {
                    "start": frame.index.min().isoformat(),
                    "end": frame.index.max().isoformat(),
                }
                for window_name, frame in splits.items()
            },
        },
    }


def find_duplicate_candidate(candidate: dict, selected: list[dict], threshold: float) -> dict | None:
    for existing in selected:
        if candidate["canonicalExpression"] == existing["canonicalExpression"]:
            return {
                "reason": "duplicate_expression",
                "duplicateOf": existing["canonicalExpression"],
                "correlation": 1.0,
            }
        correlation = series_correlation(candidate["validationSeries"], existing["validationSeries"])
        if abs(correlation) >= threshold:
            return {
                "reason": "duplicate_validation_corr",
                "duplicateOf": existing["canonicalExpression"],
                "correlation": float(correlation),
            }
    return None


def capture_candidate(container: list[dict], env: ExpressionEnv) -> None:
    if not env.expression.tokens:
        return
    container.append(
        {
            "tokens": env.expression.tokens.copy(),
            "rawExpression": env.expression.expression,
        }
    )


def finalize_episode_candidate(
    env: ExpressionEnv,
    state: np.ndarray,
    episode_reward: float,
) -> tuple[np.ndarray, float, bool]:
    if env.done:
      return state, episode_reward, True
    if not env.expression.tokens:
      return state, episode_reward, False
    if not env.is_finish_ready():
      return state, episode_reward, False
    finish_indices = [
      index for index in env.valid_action_indices()
      if env.action_space[index]["kind"] == FINISH_ACTION
    ]
    if not finish_indices:
      return state, episode_reward, False
    next_state, reward, done, _info = env.step(finish_indices[0])
    return next_state, episode_reward + reward, done


def _strip_candidate_for_report(candidate: dict) -> dict:
    return {
        key: value
        for key, value in candidate.items()
        if key != "validationSeries"
    }


def save_run_report(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")


def summarize_filter_breakdown(filtered_candidates: list[dict]) -> dict[str, dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for candidate in filtered_candidates:
        grouped[candidate.get("filterReason", "unknown")].append(candidate)

    output = {}
    for reason, items in grouped.items():
        corr_values = [
            float(item["corrToBaseline"])
            for item in items
            if item.get("corrToBaseline") is not None
        ]
        delta_values = [
            float(item["baselineDeltaIc"])
            for item in items
            if item.get("baselineDeltaIc") is not None
        ]
        family_counts = Counter(item.get("familyId", "unknown") for item in items)
        output[reason] = {
            "count": len(items),
            "avgCorrToBaseline": (sum(corr_values) / len(corr_values)) if corr_values else None,
            "avgBaselineDeltaIc": (sum(delta_values) / len(delta_values)) if delta_values else None,
            "familyCounts": dict(family_counts),
        }
    return output


def summarize_family_breakdown(
    raw_candidates: list[dict],
    evaluated_candidates: list[dict],
    selected_candidates: list[dict],
    filtered_candidates: list[dict],
) -> dict[str, dict[str, int]]:
    breakdown: dict[str, Counter] = defaultdict(Counter)
    for candidate in raw_candidates:
        breakdown["raw"][candidate.get("familyId", "unknown")] += 1
    for candidate in evaluated_candidates:
        breakdown["evaluated"][candidate.get("familyId", "unknown")] += 1
    for candidate in selected_candidates:
        breakdown["selected"][candidate.get("familyId", "unknown")] += 1
    for candidate in filtered_candidates:
        breakdown["filtered"][candidate.get("familyId", "unknown")] += 1
    return {
        section: dict(counts)
        for section, counts in breakdown.items()
    }


def summarize_selection(
    raw_candidates: list[dict],
    filtered_candidates: list[dict],
    selected_candidates: list[dict],
) -> dict:
    invalid_final = sum(1 for item in filtered_candidates if item.get("filterReason") == "invalid_final_expression")
    duplicate = sum(
        1 for item in filtered_candidates
        if item.get("filterReason") in {"duplicate_expression", "duplicate_validation_corr"}
    )
    best_selected = selected_candidates[0] if selected_candidates else None
    return {
        "invalidFinalRatio": (invalid_final / len(raw_candidates)) if raw_candidates else 0.0,
        "duplicateRatio": (duplicate / len(raw_candidates)) if raw_candidates else 0.0,
        "shadowEligibleSelectedCount": sum(1 for item in selected_candidates if item.get("shadowEligible")),
        "bestSelectedCandidate": (
            {
                "expression": best_selected["canonicalExpression"],
                "selectionScore": best_selected["selectionScore"],
                "testIc": best_selected["testMetrics"]["oos_ic"],
                "corrToBaseline": best_selected["corrToBaseline"],
                "baselineDeltaIc": best_selected["baselineDeltaIc"],
                "familyId": best_selected["familyId"],
            }
            if best_selected
            else None
        ),
    }


def build_compact_run_report(run_report: dict) -> dict:
    return {
        "generatedAt": run_report["generatedAt"],
        "symbol": run_report["symbol"],
        "trainingMode": run_report["trainingMode"],
        "splitMode": run_report["splitMode"],
        "optimizerUpdates": run_report["optimizerUpdates"],
        "meanLoss": run_report["meanLoss"],
        "counts": run_report["counts"],
        "filterBreakdown": run_report["filterBreakdown"],
        "familyBreakdown": run_report["familyBreakdown"],
        "selectionSummary": run_report["selectionSummary"],
        "selectedCandidates": [
            {
                "expression": candidate["canonicalExpression"],
                "familyId": candidate["familyId"],
                "selectionScore": candidate["selectionScore"],
                "corrToBaseline": candidate["corrToBaseline"],
                "baselineDeltaIc": candidate["baselineDeltaIc"],
                "shadowEligible": candidate["shadowEligible"],
                "testIc": candidate["testMetrics"]["oos_ic"],
            }
            for candidate in run_report["selectedCandidates"]
        ],
    }


def train(args):
    df = prepare_research_dataset(
        symbol=args.symbol,
        timeframe=args.timeframe,
        start_date=args.start,
        end_date=args.end,
        exchange_id=args.exchange,
    )
    splits, split_meta = build_research_splits(df)
    family_series = {
        name: build_family_series(frame)
        for name, frame in splits.items()
    }
    env = ExpressionEnv(
        df=splits["validation"],
        reward_df=splits["validation"],
        turnover_df=splits["train"],
        family_series=family_series["validation"],
        horizon=args.horizon,
        max_tokens=args.max_tokens,
    )
    best_entries: list[dict] = []
    total_updates = 0
    loss_values = []
    if args.dry_run:
        for episode in range(args.episodes):
            state = env.reset()
            episode_reward = 0.0
            recorded = False
            for step in range(args.max_steps):
                valid_actions = env.valid_action_indices()
                if not valid_actions:
                    break
                action = valid_actions[(episode + step) % len(valid_actions)]
                next_state, reward, done, _info = env.step(action)
                state = next_state
                episode_reward += reward
                if done:
                    if env.expression.tokens:
                        capture_candidate(best_entries, env)
                        recorded = True
                    break
            if not recorded:
                state, episode_reward, finalized = finalize_episode_candidate(env, state, episode_reward)
                if finalized:
                    capture_candidate(best_entries, env)
                    recorded = True
            if not recorded and env.expression.tokens:
                capture_candidate(best_entries, env)
            print(f"episode={episode + 1} reward={episode_reward:.4f} [dry-run]")
    else:
        state = env.reset()
        agent = AlphaQCMAgent(state_dim=len(state), action_dim=len(env.action_space), lr=args.lr)
        for episode in range(args.episodes):
            state = env.reset()
            episode_reward = 0.0
            recorded = False
            for _ in range(args.max_steps):
                valid_actions = env.valid_action_indices()
                if not valid_actions:
                    break
                action = agent.select_action(state, epsilon=args.epsilon, valid_actions=valid_actions)
                next_state, reward, done, _info = env.step(action)
                agent.replay_buffer.push(
                    Transition(state=state, action=action, reward=reward, next_state=next_state, done=done)
                )
                loss = agent.update(batch_size=args.batch_size)
                if loss > 0:
                    total_updates += 1
                    loss_values.append(loss)
                state = next_state
                episode_reward += reward
                if done:
                    if env.expression.tokens:
                        capture_candidate(best_entries, env)
                        recorded = True
                    break
            if not recorded:
                state, episode_reward, finalized = finalize_episode_candidate(env, state, episode_reward)
                if finalized:
                    capture_candidate(best_entries, env)
                    recorded = True
            if not recorded and env.expression.tokens:
                capture_candidate(best_entries, env)
            if (episode + 1) % args.target_sync_every == 0:
                agent.sync_target()
            print(f"episode={episode + 1} reward={episode_reward:.4f}")
        if total_updates == 0:
            raise RuntimeError(
                "Training ran without optimizer updates; "
                "reduce --batch-size or increase episodes/max-steps to get real parameter updates."
            )
        print(
            f"optimizer_updates={total_updates} "
            f"mean_loss={sum(loss_values) / len(loss_values):.6f}"
        )

    mean_loss = float(sum(loss_values) / len(loss_values)) if loss_values else None
    baseline_test_metrics = env.evaluate_tokens(
        ["feature:factor_mean_reversion"],
        reward_frame=splits["test"],
        turnover_frame=splits["train"],
        family_series=family_series["test"],
    )
    baseline_test_ic = float(baseline_test_metrics["oos_ic"])

    raw_candidate_reports = []
    candidate_reports = []
    filtered_candidates: list[dict] = []
    for item in best_entries:
        candidate = evaluate_candidate(
            env=env,
            tokens=item["tokens"],
            raw_expression=item["rawExpression"],
            splits=splits,
            split_meta=split_meta,
            family_series=family_series,
            baseline_test_ic=baseline_test_ic,
            total_updates=total_updates,
            mean_loss=mean_loss,
            args=args,
        )
        raw_candidate_reports.append(_strip_candidate_for_report(candidate))
        if candidate["status"] != "evaluated":
            filtered_candidates.append(candidate)
            continue
        candidate_reports.append(candidate)

    candidate_reports.sort(key=lambda item: item["selectionScore"], reverse=True)
    selected_candidates: list[dict] = []
    for candidate in candidate_reports:
        duplicate = find_duplicate_candidate(candidate, selected_candidates, threshold=args.dedupe_correlation)
        if duplicate:
            filtered_candidates.append({
                **_strip_candidate_for_report(candidate),
                "status": "filtered",
                "filterReason": duplicate["reason"],
                "duplicateOf": duplicate["duplicateOf"],
                "duplicateCorrelation": duplicate["correlation"],
            })
            continue
        if len(selected_candidates) >= args.top_k:
            filtered_candidates.append({
                **_strip_candidate_for_report(candidate),
                "status": "filtered",
                "filterReason": "top_k_cut",
            })
            continue
        selected_candidates.append(candidate)

    entries = [
        AlphaPoolEntry(
            alpha_id=f"alpha_qcm_{index + 1}",
            expression=item["canonicalExpression"],
            source="alpha_qcm",
            feature_names=item["featureNames"],
            train_window=_window_bounds(splits["train"]),
            test_window=_window_bounds(splits["test"]),
            oos_ic=float(item["testMetrics"]["oos_ic"]),
            cost_adjusted_sharpe=float(item["testMetrics"]["reward"]),
            turnover=float(item["trainMetrics"]["turnover"]),
            regime_summary=item["regimeSummary"],
            accepted_for_runtime=False,
        )
        for index, item in enumerate(selected_candidates)
    ]

    artifact = build_alpha_pool_artifact(
        symbol=args.symbol,
        entries=entries,
        generated_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    )
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    save_alpha_pool_artifact(output_dir / "latest.json", artifact)
    run_report = {
        "generatedAt": artifact["generatedAt"],
        "symbol": args.symbol,
        "trainingMode": "dry_run" if args.dry_run else "qcm_rl",
        "splitMode": split_meta["splitMode"],
        "optimizerUpdates": total_updates,
        "meanLoss": mean_loss,
        "baseline": {
            "familyId": "predictive_baseline",
            "expression": "feature:factor_mean_reversion",
            "testIc": baseline_test_ic,
        },
        "counts": {
            "rawCandidateCount": len(best_entries),
            "evaluatedCandidateCount": len(candidate_reports),
            "selectedCandidateCount": len(selected_candidates),
            "filteredCandidateCount": len(filtered_candidates),
        },
        "filterBreakdown": summarize_filter_breakdown(filtered_candidates),
        "familyBreakdown": summarize_family_breakdown(
            raw_candidate_reports,
            candidate_reports,
            selected_candidates,
            filtered_candidates,
        ),
        "selectionSummary": summarize_selection(
            raw_candidate_reports,
            filtered_candidates,
            selected_candidates,
        ),
        "selectedCandidates": [
            {
                **_strip_candidate_for_report(candidate),
                "status": "selected",
            }
            for candidate in selected_candidates
        ],
        "filteredCandidates": filtered_candidates,
    }
    save_run_report(output_dir / "latest_run_report.json", run_report)
    save_run_report(output_dir / "latest_run_report_compact.json", build_compact_run_report(run_report))
    return artifact


def main():
    parser = argparse.ArgumentParser(description="Train a minimal AlphaQCM prototype.")
    parser.add_argument("--symbol", default="BTC/USDT:USDT")
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--start", default="2023-01-01")
    parser.add_argument("--end", default="2025-04-03")
    parser.add_argument("--exchange", default="gate")
    parser.add_argument("--episodes", type=int, default=10)
    parser.add_argument("--max-steps", type=int, default=12)
    parser.add_argument("--max-tokens", type=int, default=4)
    parser.add_argument("--horizon", type=int, default=24)
    parser.add_argument("--lr", type=float, default=5e-4)
    parser.add_argument("--epsilon", type=float, default=0.1)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--target-sync-every", type=int, default=5)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--accepted-ic-threshold", type=float, default=0.03)
    parser.add_argument("--max-baseline-correlation", type=float, default=0.9)
    parser.add_argument("--shadow-min-delta-ic", type=float, default=0.02)
    parser.add_argument("--dedupe-correlation", type=float, default=0.995)
    parser.add_argument("--output-dir", default="data/research/alpha_pool")
    parser.add_argument("--dry-run", action="store_true", help="Run environment/evaluation smoke without requiring torch")
    args = parser.parse_args()
    train(args)


if __name__ == "__main__":
    main()
