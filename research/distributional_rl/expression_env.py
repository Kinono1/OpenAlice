from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

BASE_FACTORS = [
    "factor_funding_rate",
    "factor_basis",
    "factor_volume_surge",
    "factor_momentum",
    "factor_mean_reversion",
    "factor_volatility_regime",
    "factor_liquidation_pressure",
    "factor_cross_timeframe_divergence",
]

EXPRESSION_FEATURE_COLUMNS = [
    *BASE_FACTORS,
    "return_1h_pct",
    "return_6h_pct",
    "return_24h_pct",
    "return_7d_pct",
    "realized_vol_pct",
    "vol_of_vol_pct",
    "volume_ratio",
    "volume_change_rate",
    "funding_rate",
    "funding_rate_zscore",
    "basis_pct",
    "vol_expansion_score",
    "return_1h_zscore",
    "realized_vol_zscore",
    "volume_change_zscore",
    "macd_hist_proxy",
    "bb_position_proxy",
    "atr_pct_proxy",
]

UNARY_OPS = ["neg", "abs", "sign", "log1p_abs"]
BINARY_OPS = ["add", "sub", "mul", "div"]
ROLLING_UNARY_OPS = ["mean", "std", "zscore", "delta", "delay", "rank"]
ROLLING_BINARY_OPS = ["corr"]
WINDOW_CHOICES = [6, 24, 72]
STACK_PREVIEW_DEPTH = 4
FINISH_ACTION = "finish"


def feature_names_from_tokens(tokens: list[str]) -> list[str]:
    return sorted(
        {
            (token.split(":", 1)[1] if token.startswith("feature:") else token)
            for token in tokens
            if token.startswith("feature:") or token in BASE_FACTORS
        }
    )


@dataclass
class AlphaExpression:
    tokens: list[str] = field(default_factory=list)
    history: list[float] = field(default_factory=list)
    regime: str = "unknown"

    @property
    def expression(self) -> str:
        return " ".join(self.tokens) if self.tokens else "EMPTY"


class ExpressionEnv:
    def __init__(
        self,
        df: pd.DataFrame,
        horizon: int = 24,
        max_tokens: int = 6,
        reward_df: pd.DataFrame | None = None,
        turnover_df: pd.DataFrame | None = None,
        family_series: dict[str, pd.Series] | None = None,
        redundancy_penalty_scale: float = 0.05,
    ):
        self.df = df
        self.horizon = horizon
        self.max_tokens = max_tokens
        self.reward_df = reward_df if reward_df is not None else df
        self.turnover_df = turnover_df if turnover_df is not None else self.reward_df
        self.family_series = family_series or {}
        self.redundancy_penalty_scale = redundancy_penalty_scale
        self.feature_columns = [
            column for column in EXPRESSION_FEATURE_COLUMNS
            if column in self.df.columns
        ]
        self.action_space = self._build_action_space()
        self.reset()

    def _build_action_space(self) -> list[dict[str, Any]]:
        actions: list[dict[str, Any]] = []
        for feature in self.feature_columns:
            actions.append({
                "kind": "push_feature",
                "feature": feature,
                "token": f"feature:{feature}",
                "stack_delta": 1,
                "min_stack_depth": 0,
            })
        for op in UNARY_OPS:
            actions.append({
                "kind": "apply_unary",
                "op": op,
                "token": f"unary:{op}",
                "stack_delta": 0,
                "min_stack_depth": 1,
            })
        for op in BINARY_OPS:
            actions.append({
                "kind": "apply_binary",
                "op": op,
                "token": f"binary:{op}",
                "stack_delta": -1,
                "min_stack_depth": 2,
            })
        for op in ROLLING_UNARY_OPS:
            for window in WINDOW_CHOICES:
                actions.append({
                    "kind": "apply_rolling_unary",
                    "op": op,
                    "window": window,
                    "token": f"rolling1:{op}:{window}",
                    "stack_delta": 0,
                    "min_stack_depth": 1,
                })
        for op in ROLLING_BINARY_OPS:
            for window in WINDOW_CHOICES[1:]:
                actions.append({
                    "kind": "apply_rolling_binary",
                    "op": op,
                    "window": window,
                    "token": f"rolling2:{op}:{window}",
                    "stack_delta": -1,
                    "min_stack_depth": 2,
                })
        actions.append({"kind": "remove_last", "stack_delta": 0, "min_stack_depth": 0})
        actions.append({"kind": FINISH_ACTION, "stack_delta": 0, "min_stack_depth": 0})
        return actions

    def reset(self):
        self.expression = AlphaExpression(tokens=[], history=[], regime=self._current_regime_name(self.reward_df))
        self.done = False
        return self.encode_state()

    def _feature_count(self, tokens: list[str]) -> int:
        return len(feature_names_from_tokens(tokens))

    def _has_structural_transform(self, tokens: list[str]) -> bool:
        return any(
            token.startswith("binary:") or token.startswith("rolling1:") or token.startswith("rolling2:")
            for token in tokens
        )

    def _current_regime_name(self, frame: pd.DataFrame) -> str:
        if "regime_state" not in frame or frame.empty:
            return "unknown"
        mode = frame["regime_state"].mode(dropna=True)
        if mode.empty:
            return "unknown"
        return str(mode.iloc[0])

    def _stack_depth(self, tokens: list[str]) -> int:
        depth = 0
        for token in tokens:
            if token.startswith("feature:"):
                depth += 1
            elif token.startswith("binary:") or token.startswith("rolling2:"):
                depth = max(depth - 1, 0)
            elif token.startswith("unary:") or token.startswith("rolling1:"):
                depth = max(depth, 0)
        return depth

    def encode_state(self) -> np.ndarray:
        feature_count = len(feature_names_from_tokens(self.expression.tokens))
        unary_count = sum(token.startswith("unary:") for token in self.expression.tokens)
        binary_count = sum(token.startswith("binary:") for token in self.expression.tokens)
        rolling_unary_count = sum(token.startswith("rolling1:") for token in self.expression.tokens)
        rolling_binary_count = sum(token.startswith("rolling2:") for token in self.expression.tokens)
        preview_tokens = self.expression.tokens[-STACK_PREVIEW_DEPTH:]
        stack_depth = self._stack_depth(self.expression.tokens)
        summary = [
            len(self.expression.tokens),
            stack_depth,
            feature_count,
            unary_count,
            binary_count,
            rolling_unary_count,
            rolling_binary_count,
            np.mean(self.expression.history) if self.expression.history else 0.0,
            np.std(self.expression.history) if len(self.expression.history) > 1 else 0.0,
            self.expression.history[-1] if self.expression.history else 0.0,
        ]
        preview = [
            hash(token) % 1000 / 1000.0
            for token in preview_tokens
        ]
        preview += [0.0] * (STACK_PREVIEW_DEPTH - len(preview))
        regime_onehot = [
            1.0 if self.expression.regime == name else 0.0
            for name in ["bull", "bear", "calm", "stress"]
        ]
        return np.asarray(summary + preview + regime_onehot, dtype=np.float32)

    def _rolling_rank(self, series: pd.Series, window: int) -> pd.Series:
        def rank_last(values: np.ndarray) -> float:
            valid = values[np.isfinite(values)]
            if len(valid) == 0:
                return np.nan
            return float(pd.Series(valid).rank(pct=True).iloc[-1])

        return series.rolling(window).apply(rank_last, raw=True)

    def _safe_binary_op(self, left: pd.Series, right: pd.Series, op: str) -> pd.Series:
        if op == "add":
            return left + right
        if op == "sub":
            return left - right
        if op == "mul":
            return left * right
        if op == "div":
            return left / right.replace(0, np.nan)
        if op == "max":
            return pd.Series(np.maximum(left, right), index=left.index)
        if op == "min":
            return pd.Series(np.minimum(left, right), index=left.index)
        raise ValueError(f"Unsupported binary op: {op}")

    def _safe_unary_op(self, series: pd.Series, op: str) -> pd.Series:
        if op == "neg":
            return -series
        if op == "abs":
            return series.abs()
        if op == "sign":
            return np.sign(series)
        if op == "log1p_abs":
            return np.sign(series) * np.log1p(series.abs())
        raise ValueError(f"Unsupported unary op: {op}")

    def _safe_rolling_unary(self, series: pd.Series, op: str, window: int) -> pd.Series:
        if op == "mean":
            return series.rolling(window).mean()
        if op == "std":
            return series.rolling(window).std()
        if op == "zscore":
            mean = series.rolling(window).mean()
            std = series.rolling(window).std().replace(0, np.nan)
            return (series - mean) / std
        if op == "delta":
            return series - series.shift(window)
        if op == "delay":
            return series.shift(window)
        if op == "rank":
            return self._rolling_rank(series, window)
        raise ValueError(f"Unsupported rolling unary op: {op}")

    def _safe_rolling_binary(
        self,
        left: pd.Series,
        right: pd.Series,
        op: str,
        window: int,
    ) -> pd.Series:
        if op == "corr":
            return left.rolling(window).corr(right)
        raise ValueError(f"Unsupported rolling binary op: {op}")

    def _evaluation_result(
        self,
        *,
        status: str,
        frame: pd.DataFrame,
        stack_depth: int,
        feature_names: list[str],
        series: pd.Series | None = None,
        error_reason: str | None = None,
        final_arity_ok: bool = False,
    ) -> dict[str, Any]:
        selected_series = series
        if selected_series is None:
            selected_series = pd.Series(np.zeros(len(frame)), index=frame.index, dtype=float)
        cleaned = selected_series.replace([np.inf, -np.inf], np.nan).fillna(0.0)
        return {
            "status": status,
            "series": pd.Series(cleaned, index=frame.index, dtype=float),
            "stack_depth": stack_depth,
            "feature_names": sorted(set(feature_names)),
            "final_arity_ok": final_arity_ok,
            "error_reason": error_reason if error_reason is not None else (None if status in {"ok", "partial"} else status),
        }

    def _evaluate_rpn(
        self,
        tokens: list[str],
        frame: pd.DataFrame,
        allow_partial: bool,
    ) -> dict[str, Any]:
        if not tokens:
            return self._evaluation_result(
                status="empty_expression",
                frame=frame,
                stack_depth=0,
                feature_names=[],
                final_arity_ok=False,
            )

        stack: list[pd.Series] = []
        feature_names: list[str] = []

        try:
            for token in tokens:
                if token.startswith("feature:") or token in BASE_FACTORS:
                    feature = token.split(":", 1)[1] if token.startswith("feature:") else token
                    if feature not in frame.columns:
                        return self._evaluation_result(
                            status="missing_feature",
                            frame=frame,
                            stack_depth=len(stack),
                            feature_names=feature_names,
                            final_arity_ok=False,
                        )
                    stack.append(frame[feature].fillna(0).astype(float))
                    feature_names.append(feature)
                elif token.startswith("unary:"):
                    if len(stack) < 1:
                        return self._evaluation_result(
                            status="invalid_stack",
                            frame=frame,
                            stack_depth=len(stack),
                            feature_names=feature_names,
                            final_arity_ok=False,
                        )
                    operand = stack.pop()
                    op = token.split(":", 1)[1]
                    stack.append(self._safe_unary_op(operand, op))
                elif token.startswith("binary:"):
                    if len(stack) < 2:
                        return self._evaluation_result(
                            status="invalid_stack",
                            frame=frame,
                            stack_depth=len(stack),
                            feature_names=feature_names,
                            final_arity_ok=False,
                        )
                    right = stack.pop()
                    left = stack.pop()
                    op = token.split(":", 1)[1]
                    stack.append(self._safe_binary_op(left, right, op))
                elif token.startswith("rolling1:"):
                    if len(stack) < 1:
                        return self._evaluation_result(
                            status="invalid_stack",
                            frame=frame,
                            stack_depth=len(stack),
                            feature_names=feature_names,
                            final_arity_ok=False,
                        )
                    _, op, window = token.split(":")
                    operand = stack.pop()
                    stack.append(self._safe_rolling_unary(operand, op, int(window)))
                elif token.startswith("rolling2:"):
                    if len(stack) < 2:
                        return self._evaluation_result(
                            status="invalid_stack",
                            frame=frame,
                            stack_depth=len(stack),
                            feature_names=feature_names,
                            final_arity_ok=False,
                        )
                    _, op, window = token.split(":")
                    right = stack.pop()
                    left = stack.pop()
                    stack.append(self._safe_rolling_binary(left, right, op, int(window)))
                else:
                    return self._evaluation_result(
                        status="unknown_token",
                        frame=frame,
                        stack_depth=len(stack),
                        feature_names=feature_names,
                        final_arity_ok=False,
                    )
        except Exception:
            return self._evaluation_result(
                status="evaluation_error",
                frame=frame,
                stack_depth=len(stack),
                feature_names=feature_names,
                final_arity_ok=False,
            )

        if not stack:
            return self._evaluation_result(
                status="invalid_stack",
                frame=frame,
                stack_depth=0,
                feature_names=feature_names,
                final_arity_ok=False,
            )

        status = "ok" if len(stack) == 1 else ("partial" if allow_partial else "invalid_stack")
        series = stack[-1] if allow_partial else stack[0]
        return self._evaluation_result(
            status=status,
            frame=frame,
            stack_depth=len(stack),
            feature_names=feature_names,
            series=series,
            final_arity_ok=len(stack) == 1,
        )

    def is_finish_ready(self, tokens: list[str] | None = None) -> bool:
        candidate_tokens = tokens if tokens is not None else self.expression.tokens
        if self._feature_count(candidate_tokens) < 1:
            return False
        if not self._has_structural_transform(candidate_tokens):
            return False
        evaluation = self._evaluate_rpn(candidate_tokens, self.reward_df, allow_partial=False)
        return bool(evaluation["status"] == "ok" and evaluation["final_arity_ok"])

    def valid_action_indices(self) -> list[int]:
        current_depth = self._stack_depth(self.expression.tokens)
        token_count = len(self.expression.tokens)
        finish_ready = self.is_finish_ready(self.expression.tokens)
        indices: list[int] = []

        for index, action in enumerate(self.action_space):
            kind = action["kind"]
            if kind == "remove_last":
                if token_count > 0:
                    indices.append(index)
                continue
            if kind == FINISH_ACTION:
                if finish_ready:
                    indices.append(index)
                continue
            if token_count >= self.max_tokens:
                continue
            if current_depth < action.get("min_stack_depth", 0):
                continue
            indices.append(index)

        return indices

    def series_for_tokens(
        self,
        tokens: list[str],
        frame: pd.DataFrame | None = None,
        allow_partial: bool = False,
    ) -> pd.Series:
        selected_frame = frame if frame is not None else self.reward_df
        evaluation = self._evaluate_rpn(tokens, selected_frame, allow_partial=allow_partial)
        return evaluation["series"]

    def _series_correlation(self, left: pd.Series, right: pd.Series) -> float:
        aligned = pd.concat([left.rename("left"), right.rename("right")], axis=1).dropna()
        if len(aligned) < 20:
            return 0.0
        if aligned["left"].nunique(dropna=True) < 2 or aligned["right"].nunique(dropna=True) < 2:
            return 0.0
        correlation = aligned["left"].corr(aligned["right"], method="spearman")
        return 0.0 if not np.isfinite(correlation) else float(correlation)

    def evaluate_tokens(
        self,
        tokens: list[str],
        reward_frame: pd.DataFrame | None = None,
        turnover_frame: pd.DataFrame | None = None,
        family_series: dict[str, pd.Series] | None = None,
        allow_partial: bool = False,
    ) -> dict[str, Any]:
        selected_reward_frame = reward_frame if reward_frame is not None else self.reward_df
        selected_turnover_frame = turnover_frame if turnover_frame is not None else self.turnover_df
        selected_family_series = family_series if family_series is not None else self.family_series

        evaluation = self._evaluate_rpn(tokens, selected_reward_frame, allow_partial=allow_partial)
        series = evaluation["series"]
        future_returns = selected_reward_frame["close"].pct_change(self.horizon).shift(-self.horizon)
        valid = np.isfinite(series) & np.isfinite(future_returns)
        if valid.sum() < 20 or evaluation["status"] not in {"ok", "partial"}:
            return {
                "status": evaluation["status"],
                "oos_ic": 0.0,
                "turnover": 0.0,
                "reward": -0.02,
                "familyCorrelations": {},
                "maxFamilyCorrelation": 0.0,
                "redundancyPenalty": 0.0,
                "stackDepth": evaluation["stack_depth"],
                "featureNames": evaluation["feature_names"],
                "validSampleCount": int(valid.sum()),
                "finalArityOk": bool(evaluation["final_arity_ok"]),
                "errorReason": evaluation["error_reason"],
            }
        valid_series = pd.Series(series[valid])
        valid_returns = pd.Series(future_returns[valid])
        if valid_series.nunique(dropna=True) < 2 or valid_returns.nunique(dropna=True) < 2:
            return {
                "status": "insufficient_variation",
                "oos_ic": 0.0,
                "turnover": 0.0,
                "reward": -0.02,
                "familyCorrelations": {},
                "maxFamilyCorrelation": 0.0,
                "redundancyPenalty": 0.0,
                "stackDepth": evaluation["stack_depth"],
                "featureNames": evaluation["feature_names"],
                "validSampleCount": int(valid.sum()),
                "finalArityOk": bool(evaluation["final_arity_ok"]),
                "errorReason": "insufficient_variation",
            }
        correlation = valid_series.corr(valid_returns, method="spearman")
        correlation = 0.0 if not np.isfinite(correlation) else float(correlation)
        turnover_series = self.series_for_tokens(tokens, selected_turnover_frame, allow_partial=allow_partial)
        turnover = float(pd.Series(np.sign(turnover_series.fillna(0))).diff().abs().mean())
        family_correlations = {
            family_name: self._series_correlation(series, family_value.reindex(series.index))
            for family_name, family_value in selected_family_series.items()
        }
        max_family_correlation = max((abs(value) for value in family_correlations.values()), default=0.0)
        redundancy_penalty = max(0.0, max_family_correlation - 0.5) * self.redundancy_penalty_scale
        complexity_penalty = len(tokens) * 0.005
        partial_penalty = 0.01 if evaluation["status"] == "partial" else 0.0
        reward = correlation - turnover * 0.01 - complexity_penalty - redundancy_penalty - partial_penalty
        return {
            "status": evaluation["status"],
            "oos_ic": correlation,
            "turnover": turnover,
            "reward": reward,
            "familyCorrelations": family_correlations,
            "maxFamilyCorrelation": max_family_correlation,
            "redundancyPenalty": redundancy_penalty,
            "stackDepth": evaluation["stack_depth"],
            "featureNames": evaluation["feature_names"],
            "validSampleCount": int(valid.sum()),
            "finalArityOk": bool(evaluation["final_arity_ok"]),
            "errorReason": evaluation["error_reason"],
        }

    def evaluate_current_expression(self, allow_partial: bool = True) -> dict[str, Any]:
        return self.evaluate_tokens(self.expression.tokens, allow_partial=allow_partial)

    def step(self, action_index: int):
        action = self.action_space[action_index]
        info: dict[str, Any] = {"action": action}

        valid_indices = set(self.valid_action_indices())
        if action_index not in valid_indices:
            metrics = self.evaluate_current_expression(allow_partial=True)
            penalty = float(metrics["reward"]) - 0.02
            info.update(metrics)
            info["invalidAction"] = True
            info["invalidReason"] = "masked_action"
            return self.encode_state(), penalty, self.done, info

        if action["kind"] == FINISH_ACTION:
            self.done = True
            metrics = self.evaluate_current_expression(allow_partial=False)
            self.expression.history.append(float(metrics["oos_ic"]))
            info.update(metrics)
            return self.encode_state(), float(metrics["reward"]), self.done, info

        if action["kind"] == "remove_last":
            if self.expression.tokens:
                self.expression.tokens.pop()
        else:
            self.expression.tokens.append(action["token"])

        metrics = self.evaluate_current_expression(allow_partial=True)
        self.expression.history.append(float(metrics["oos_ic"]))
        self.expression.regime = self._current_regime_name(self.reward_df)
        info.update(metrics)
        return self.encode_state(), float(metrics["reward"]), self.done, info
