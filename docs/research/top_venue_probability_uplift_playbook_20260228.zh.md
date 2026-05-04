# OpenAlice 预测概率提升：顶会顶刊深读与执行手册（2026-02-28）

## 0. 当前痛点（以门控指标定义问题）

当前 `strategy-watch` 最新失败分解显示：

- `window8 champion_h0_ratio = 1.0`
- `window8 transfer_false_ratio = 1.0`
- `main_gate_fail_ratio.gate_pass_robust_uplift = 0.6667`
- `main_gate_fail_ratio.gate_pass_robust_ci = 0.5`
- `transfer_gate_fail_ratio.gate_pass_robust_delta = 1.0`

这说明不是单纯“训练没跑起来”，而是三类本质问题：

1. 概率输出不够可用（置信度与真实命中偏离，导致风险闸门拒绝）。
2. 时序非平稳导致策略在新窗口失效（uplift 不稳，CI 下界过弱）。
3. 跨域/迁移泛化弱（UM -> mixed transfer 失败）。

---

## 1. 顶会/顶刊论文白名单（逐篇深读）

以下论文按“对当前失败项的直接解释力”排序。每篇都给出可落地改造位点。

### P1. Conformalized Quantile Regression (NeurIPS 2019)

- 链接: https://arxiv.org/abs/1905.03222
- 核心结论: 用 CQR 在有限样本下提供覆盖率可控、且异方差自适应的预测区间。
- 对我们的作用:
  - 直接打 `gate_pass_robust_ci`（让区间可信、减少过窄置信带）。
  - 降低“高置信但错”的交易信号。
- 落地改造:
  - 在 `wait_clean_and_retrain.py` 产出的分类概率后增加 CQR 头。
  - 将 entry 条件从 `p > threshold` 升级为 `lower_q > action_floor`。

### P2. Adaptive Conformal Predictions for Time Series (2022)

- 链接: https://arxiv.org/abs/2202.07282
- 核心结论: 在时间依赖/分布漂移场景中，用自适应学习率更新 conformal 半径，维持覆盖率。
- 对我们的作用:
  - 直接打 `transfer_false_ratio`（新 regime 下可靠性塌陷问题）。
- 落地改造:
  - 给每个 regime 维护独立 conformal state。
  - 在 live 推理阶段在线更新 interval width。

### P3. Conformal Prediction Under Covariate Shift (ICML 2020)

- 链接: https://arxiv.org/abs/1904.06019
- 核心结论: 用重要性加权修正 covariate shift 下的覆盖率偏移。
- 对我们的作用:
  - 对 mixed/source transfer gate 是直接补丁（分布不一致下做校正）。
- 落地改造:
  - 在 `transfer` 验证时加入 density-ratio weighting。
  - gate 指标改为“加权 robust delta + 加权覆盖率”。

### P4. iTransformer (ICLR 2024)

- 链接: https://openreview.net/forum?id=JePfAI8fah
- 核心结论: 变量维建模替代传统时间 token 设计，可提升多变量预测稳定性。
- 对我们的作用:
  - 提升 regime 识别与概率输出稳定性，缓解 uplift 波动。
- 落地改造:
  - 作为第二信号头（不替换主模型），输出 `p_up_iT`。
  - 与当前模型做 stacking + 温度缩放。

### P5. PatchTST (ICLR 2023)

- 链接: https://arxiv.org/abs/2211.14730
- 核心结论: patch token + channel-independence 对长期时序预测更稳。
- 对我们的作用:
  - 减少噪声敏感性，提高 `robust_uplift` 可重复性。
- 落地改造:
  - 用 patch window 生成特征给现有树模型（先不引入全神经端到端）。

### P6. Non-stationary Transformers (NeurIPS 2022)

- 链接: https://arxiv.org/abs/2205.14415
- 核心结论: 通过去平稳化/再平稳化机制提升非平稳序列可预测性。
- 对我们的作用:
  - 直接针对我们 regime 切换时概率崩塌。
- 落地改造:
  - 将非平稳统计量（rolling mean/var shift）加入 gating feature。
  - 对高 shift 时段自动抬高入场置信度阈值。

### P7. Autoformer (NeurIPS 2021)

- 链接: https://arxiv.org/abs/2106.13008
- 核心结论: 分解 + 自相关机制改善长期依赖学习。
- 对我们的作用:
  - 提升“趋势段”和“均值回归段”拆分能力，减少错误合并。
- 落地改造:
  - 将分解后的 trend/seasonal 特征接入现有训练管线。

### P8. DeepLOB (IEEE TSP 2019)

- 链接: https://arxiv.org/abs/1808.03668
- 核心结论: CNN + LSTM 在 LOB 结构上有效提取短周期价格方向信号。
- 对我们的作用:
  - 强化 `cost_execution` 方向，提升成交后净收益概率。
- 落地改造:
  - 在现有 OHLCV 管线外并行增加 LOB-only 分数，作为执行层 veto/boost 信号。

### P9. Empirical Asset Pricing via Machine Learning (RFS 2020)

- 链接: https://academic.oup.com/rfs/article/33/5/2223/5758276
- 核心结论: 系统比较 ML 在资产定价预测中的收益与稳健性，并强调严格的样本外验证。
- 对我们的作用:
  - 纠正“回测看起来强，门控过不了”的评估错配。
- 落地改造:
  - 强制使用统一的 walk-forward + nested CV 协议，禁止任意窗口调参。

### P10. The Virtue of Complexity in Return Prediction (NBER WP 29330)

- 链接: https://www.nber.org/papers/w29330
- 核心结论: 更复杂模型在收益预测中可带来额外信息提取，但需要强约束防过拟合。
- 对我们的作用:
  - 给“是否引入更复杂模型”明确边界条件（复杂度可上，但验证必须更严）。
- 落地改造:
  - 新模型上线前必须通过 `transfer + CI + turnover` 三门同时通过。

### P11. How and When are High-Frequency Stock Returns Predictable? (NBER WP 30265)

- 链接: https://www.nber.org/papers/w30265
- 核心结论: 高频可预测性具备条件性与时变性，稳定 alpha 依赖于状态分层。
- 对我们的作用:
  - 支持“分 regime 训练/阈值分治”的策略框架。
- 落地改造:
  - 各 regime 使用不同阈值与仓位 clamp，不再单阈值全市场。

### P12. Calibrated and Sharp Uncertainties in Deep Learning via Density Estimation (ICML 2022)

- 链接: https://proceedings.mlr.press/v162/zhao22d.html
- 核心结论: 同时优化 calibration 与 sharpness，避免“保守但无用”区间。
- 对我们的作用:
  - 避免 CQR 引入后区间过宽导致交易机会流失。
- 落地改造:
  - 在校准目标中加入 sharpness 惩罚，控制可交易性。

---

## 2. 论文 -> 失败指标 的一一映射

- `gate_pass_robust_uplift`:
  - iTransformer, PatchTST, Non-stationary Transformers, Autoformer
- `gate_pass_robust_ci`:
  - CQR, Adaptive Conformal, Calibrated+Sharp Uncertainty
- `gate_pass_robust_delta` (transfer):
  - Conformal under Covariate Shift, Adaptive Conformal, regime 分层门控
- `cost_execution` 与 after-cost 净效用:
  - DeepLOB + HFT predictability 文献的微观结构状态特征

---

## 3. 48 小时执行计划（从“读论文”直接到“跑实验”）

### T0: 统一验证协议（今天）

1. 固化统一评估协议: nested walk-forward + purged split + identical symbol universe。
2. 指标白名单: `robust_mean`, `robust_ci_lb95`, `net_trim10`, `transfer_pass`, `error_ratio`。
3. 增加“概率校准看板”: ECE, Brier, coverage, interval width。

### T1: 概率质量线（今天到明早）

1. 在现有概率输出后接 `CQR + adaptive conformal`。
2. 增加 `shift-aware` 校准（covariate-shift weighting）。
3. 门控替换: `p_threshold` -> `lower_confidence_threshold`。

### T2: 非平稳表示线（明早到中午）

1. 实现 `iTransformer/PatchTST` 的轻量特征蒸馏版本。
2. 不替换主模型，先做 stacking 与 temperature scaling。
3. 对每个 regime 单独学习阈值。

### T3: 执行微观结构线（明午到晚）

1. 加 LOB 风格特征头（先 proxy，不强依赖全量 L2 深度）。
2. 执行层引入 slippage-conditioned veto（高冲击时禁入）。

---

## 4. 验收门槛（硬指标）

相对当前基线，至少同时满足：

1. `window8 gate_pass_robust_uplift` 失败比例下降 >= 20%。
2. `window8 gate_pass_robust_ci` 失败比例下降 >= 20%。
3. `transfer_false_ratio` 从 1.0 降到 <= 0.8（第一阶段目标）。
4. `error_ratio` 不上升，`turnover` 不显著恶化。

达不到就回滚到上一个稳定 champion，不做 live 放大。

---

## 5. 结论

- 你说得对，关键不是“多跑几轮”，而是提高概率质量与迁移稳健性。
- 这批顶会/顶刊文献给出的不是单点技巧，而是一整套可执行路线：
  - `校准`（CQR/Conformal）
  - `非平稳表示`（iTransformer/Non-stationary）
  - `执行摩擦约束`（DeepLOB/HFT predictability）
  - `严格样本外协议`（RFS/NBER 资产定价证据）

本手册可直接作为下一轮实验卡编排输入。
