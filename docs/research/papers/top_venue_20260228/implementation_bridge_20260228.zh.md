# Paper -> OpenAlice Implementation Bridge (2026-02-28)

## 目标
将深读结论直接转换为当前仓库可执行改造，而不是停留在综述层。

## 改造包 A：Conformal 概率层

- 来源论文: CQR, Adaptive Conformal, Covariate-Shift Conformal
- 改造点:
  - 在 `wait_clean_and_retrain.py` 输出概率后新增 `calibration_artifacts/`。
  - 新增字段: `lower_q`, `upper_q`, `coverage_est`, `sharpness`。
  - 交易门控读取 `lower_q` 作为入场硬阈值。
- 验收:
  - `gate_pass_robust_ci` 失败率下降；`error_ratio` 不上升。

## 改造包 B：Non-stationary 表示增强

- 来源论文: iTransformer, PatchTST, Non-stationary Transformer, Autoformer
- 改造点:
  - 增加 `feature_heads/nonstationary_ts_head.py`（蒸馏输出，不替换主干）。
  - 输出 `regime_shift_score`, `patch_repr_score`, `variate_corr_score`。
  - 使用 stacking 组合当前模型概率。
- 验收:
  - `gate_pass_robust_uplift` 失败率下降；`turnover` 不恶化。

## 改造包 C：执行微观结构约束

- 来源论文: DeepLOB, HFT Predictability
- 改造点:
  - 增加 `execution_quality_score`（LOB proxy + 事件密度特征）。
  - 执行层 `veto`: 当冲击风险高且置信区间窄时拒单。
- 验收:
  - `net_trim10` 提升；`cost_execution` 相关卡片通过率提升。

## 改造包 D：协议与复杂度治理

- 来源论文: Empirical Asset Pricing (Gu/Kelly/Xiu), Virtue of Complexity
- 改造点:
  - 固化 nested walk-forward + purged split。
  - 模型复杂度升级必须附带 shrinkage/regularization 证据。
- 验收:
  - OOS 指标稳定，不出现“样本内提升、样本外坍塌”。

## 执行顺序

1. A（1-2 天）
2. D（并行立即）
3. B（2-3 天）
4. C（2 天）

## 停止条件

若两轮后 `window8` 的三项核心失败率无下降趋势，则回退最近稳定版本并重设假设。
