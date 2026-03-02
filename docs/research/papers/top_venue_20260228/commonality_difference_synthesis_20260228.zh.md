# 顶会顶刊深读：共同点与差异（面向 OpenAlice 预测概率提升）

## 1. 你当前任务的本质（先定义问题）

OpenAlice 当前失败分解（window8）核心是：

- `gate_pass_robust_uplift` 失败高
- `gate_pass_robust_ci` 失败高
- `transfer` 基本不过

这不是“模型容量不足”一个问题，而是三层耦合问题：

1. `概率质量`：预测概率是否校准（calibrated）且够尖锐（sharp）。
2. `分布迁移`：不同 regime / 数据源下覆盖率与效用是否保持。
3. `决策一致性`：预测目标与交易目标（after-cost utility）是否一致。

---

## 2. 文献分组（12 篇）

### A. 不确定性/校准组

- CQR_NeurIPS2019
- AdaptiveConformal_TS_2022
- Conformal_CovariateShift_ICML2020
- CalibratedSharpUncertainty_ICML2022

### B. 非平稳时序表示组

- iTransformer_ICLR2024
- PatchTST_ICLR2023
- NonstationaryTransformer_NeurIPS2022
- Autoformer_NeurIPS2021

### C. 微观结构与执行组

- DeepLOB_2018
- HFTPredictability_NBER30366

### D. 资产定价协议与复杂度组

- EmpiricalAssetPricing_GuKellyXiu_w25398
- VirtueComplexity_NBER30217

---

## 3. 共同点（跨论文的“共识”）

1. **都在对抗非平稳**
- 不同术语（regime shift/covariate shift/distribution shift），本质都是训练分布与部署分布不一致。

2. **都强调 OOS（样本外）而非样本内**
- 不论是 conformal 覆盖率、forecast MSE，还是 Sharpe，关键都在 out-of-sample 稳健性。

3. **都承认“点预测不够”**
- 需要区间、不确定性、或者状态条件化，单个点估计难以支撑风险决策。

4. **都隐含“分层建模”思想**
- 时间 patch、variate token、regime 条件、LOB 事件状态，本质都是把一个混杂问题拆成多个局部子问题。

5. **都在处理 bias-variance 或 sharpness-coverage 的权衡**
- 区间太宽无交易价值，太窄会失去覆盖；模型太简单欠拟合，太复杂会过拟合。

6. **都需要协议约束避免伪提升**
- 训练/验证切分、泄露控制、滚动评估是共通基础设施。

7. **都指出 friction（成本/冲击）不可忽略**
- 很多“预测提升”在 after-cost 上会被抹平或翻转。

8. **都支持“组合而非单模型神话”**
- 单一架构很难同时赢 calibration、uplift、transfer；集成与分层门控更现实。

---

## 4. 差异（真正决定可迁移性的地方）

## 4.1 目标函数差异

- 校准组：优化覆盖率与误差一致性。
- 表示组：优化预测误差（MSE/MAE）或长期依赖捕获。
- 执行组：优化交易可执行性与微观结构适配。
- 资产定价组：优化 OOS 预测与组合收益（Sharpe/alpha）。

**结论**：如果只提升 A 组或 B 组，不保证 `after-cost` 和 `transfer` 提升。

## 4.2 假设强度差异

- CQR 假设较弱（交换性）但非时序原生。
- ACI 在依赖序列上可在线修正。
- Covariate-shift conformal 依赖 density-ratio 可估。
- 表示学习组通常缺少覆盖率的显式保证。

**结论**：你需要“有保证的层 + 高表现的层”叠加。

## 4.3 粒度差异

- DeepLOB/HFT：事件级、高频。
- iTransformer/PatchTST：序列块级。
- 资产定价文献：日/月频与横截面。

**结论**：跨粒度直接迁移会失真，必须中间做状态聚合与对齐。

## 4.4 评估标准差异

- 学术时序论文常用 MSE/MAE。
- 交易文献更看 Sharpe/drawdown/turnover。
- 校准论文强调 coverage/ECE。

**结论**：单一指标会误导；OpenAlice 必须多指标门控。

## 4.5 可解释性差异

- Conformal 族机制可解释性强。
- Transformer 族表示能力强但解释弱。
- 资产定价组在经济解释上更强。

**结论**：上线前审计优先使用可解释不确定性层。

---

## 5. “本质”归纳：提升预测概率的四条铁律

1. **先校准，再放大模型容量**
- 未校准概率会把任何强模型变成风险源。

2. **先做 shift-aware，再谈 transfer**
- 不处理分布漂移，transfer gate 几乎必挂。

3. **先做决策目标对齐，再追求点预测更低误差**
- 交易任务要优化的是 net utility，不是纯 forecast loss。

4. **先守协议，再看提升**
- 没有统一 OOS 协议的提升，默认无效。

---

## 6. 直接映射到当前任务（按优先级）

### P0（立刻）

- 把 CQR + Adaptive Conformal 接到当前概率输出之后。
- 将 entry gate 从 `p > threshold` 改为 `lower_confidence > threshold`。

目标：压 `gate_pass_robust_ci` 失败率。

### P1（紧接着）

- 对 transfer 评估加入 covariate-shift 加权（density-ratio）校准。
- 按 regime 维护独立 conformal state。

目标：压 `transfer_false_ratio` 与 `gate_pass_robust_delta` 失败率。

### P2（并行）

- iTransformer/PatchTST 作为蒸馏特征头，不替换主干。
- 与当前树模型做 stacking + 温度缩放。

目标：改善 `gate_pass_robust_uplift`，同时不恶化 CI。

### P3（执行层）

- 引入 LOB proxy 与执行 veto（高冲击时禁入）。

目标：提升 `net_trim10` 与 after-cost 稳定性。

---

## 7. 你现在最该关注的判定信号

如果以下三项没有同时下降，说明“还没触达本质”：

1. `main_gate_fail_ratio.gate_pass_robust_uplift`
2. `main_gate_fail_ratio.gate_pass_robust_ci`
3. `transfer_gate_fail_ratio.gate_pass_robust_delta`

单看收益曲线或单次 run 提升都不算通过。

---

## 8. 结论

这 12 篇论文的共同结论不是“换一个更大的模型”，而是：

- **概率要可用（校准+尖锐）**
- **迁移要可控（shift-aware）**
- **目标要一致（after-cost utility）**
- **协议要严格（真实 OOS）**

对 OpenAlice 当前阶段，最优路径是“校准层 + shift 层 + 轻量表示增强”的三层叠加，而不是单点架构替换。
