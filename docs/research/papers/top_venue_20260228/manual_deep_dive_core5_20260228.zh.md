# Top5 手工深读：假设-失效模式-落地映射（2026-02-28）

> 目标：直接服务 OpenAlice 当前瓶颈（`gate_pass_robust_uplift`、`gate_pass_robust_ci`、`gate_pass_robust_delta/transfer`）。

## 1) CQR（Conformalized Quantile Regression, NeurIPS 2019）

### 核心机制（数学层）
- 先训练分位数回归器：
  - 下分位 `q_lo(x)`，上分位 `q_hi(x)`。
- 在校准集上计算不符合度：
  - `s_i = max(q_lo(x_i) - y_i, y_i - q_hi(x_i))`。
- 取 `s_i` 的 `(1-alpha)` 分位 `Q_hat`，形成最终区间：
  - `[q_lo(x)-Q_hat, q_hi(x)+Q_hat]`。

### 关键假设
- 校准集与测试集近似同分布（exchangeability）。
- 分位模型虽然可偏，但排序要有信息量（否则区间会过宽）。

### 在交易中的失效模式
- 分布突变时（regime 切换）全局 `Q_hat` 过旧：
  - 常见现象：覆盖率看似够，但 sharpness 极差（区间过宽）。
- 极端尾部波动期：`Q_hat` 被少数冲击拉大，导致机会被过滤过多。

### 对当前 gate 的直接影响
- 正向：
  - 通过 `lower bound` 决策可减少“点预测乐观偏差”，通常改善 `gate_pass_robust_ci` 的稳定性。
- 负向风险：
  - 若区间过宽，`lift` 和 `robust_uplift` 可能下降。

### OpenAlice 落地参数
- `conformalAlpha=0.10`
- `decisionUseConformalLowerBound=true`
- 监控：`meanConformalCoverageTest`、`meanConformalSharpnessPct`

---

## 2) Adaptive Conformal for Time Series（2022）

### 核心机制
- 不把 `Q_hat` 视为静态常数，而是按时间/误差反馈更新（在线自适应）。
- 本质是用近期误差分布来修正覆盖率漂移。

### 关键假设
- 覆盖偏差是可被短期反馈纠正的（drift 不是完全随机跳变）。

### 失效模式
- 更新过快：区间抖动，交易信号不稳定。
- 更新过慢：滞后，遇到 regime shift 保护不足。

### 对当前 gate 的意义
- 主要改善 `transfer` 的一致性问题，减少跨阶段覆盖崩塌。
- 对 `gate_pass_robust_delta` 是间接改善（降低转移后收益不稳定）。

### OpenAlice 落地建议
- 先做“按 regime 的自适应”而不是逐bar高频更新。
- 先在 shadow 验证 `coverage_shift_weighted` 曲线稳定后再上更快更新。

---

## 3) Conformal Under Covariate Shift（ICML 2020）

### 核心机制
- 在 covariate shift 下，用密度比权重 `w(x)=p_test(x)/p_cal(x)` 修正覆盖估计。
- 目标是“测试分布下的有效覆盖”，不是校准分布下的虚高覆盖。

### 关键假设
- 可获得可用的 shift proxy（哪怕粗粒度）来近似密度比。

### 失效模式
- 权重估计噪声很大时，方差爆炸。
- 稀有区域权重极端，导致估计不稳。

### 对当前 gate 的意义
- 直接命中 `transfer_false_ratio`：
  - 你现在最痛的是 S0->S1 迁移失败，shift-aware coverage 是必要门控。

### OpenAlice 当前实现映射
- 采用 regime 频率比近似密度比：`w_r ~= p_test(r)/p_val(r)`。
- clip 权重：`[0.25, 4.0]`（防止方差爆炸）。
- 新增 transfer 门控：`gate_pass_shift_coverage`。

---

## 4) iTransformer（ICLR 2024）

### 核心机制
- 把“变量维度”作为 token 建模，强调跨变量交互。
- 对多变量时序（多资产/多特征）通常比纯时间token更稳。

### 关键假设
- 横截面结构（特征/资产间关系）有稳定可学习模式。

### 失效模式
- 样本不足时容易过参数化。
- 在噪声高、结构弱的币种上可能退化为复杂噪声拟合。

### 对当前 gate 的现实意义
- 不是第一优先（你当前主要是门控稳定性问题）。
- 应作为“候选信号源”离线评估，不应立即替换执行层主模型。

### OpenAlice建议
- 用作离线基线组，与现有树模型并行比较：
  - 先看 `robust_ci_lb95` 和 `error_ratio`，不是先看单轮收益峰值。

---

## 5) DeepLOB（2018）

### 核心机制
- CNN + LSTM 在订单簿局部结构上提取微观模式。
- 适合高频微结构预测，不直接等同日级 OHLC 任务。

### 关键假设
- 有高频 order book 数据（L2/L3）且延迟控制能力足够。

### 失效模式
- 在 1d K线任务上迁移价值有限。
- 数据形态不匹配会导致“模型先进但问题错位”。

### 对当前任务的结论
- 可借鉴“局部模式+时序联合”思想，但不要直接迁移架构。
- 当前阶段不建议投入主线资源到 DeepLOB 复刻。

---

## 共同点（本质）
- 共同强调：
  - 不确定性估计必须和分布变化一起看。
  - 覆盖率与可交易性（sharpness）必须同时优化。
- 对你任务的含义：
  - 不是“再堆模型容量”，而是“让门控和目标函数与真实部署风险一致”。

## 差异点（为什么不能混用）
- CQR 偏静态校准，Adaptive 偏动态更新。
- CovShift Conformal关注“目标分布下有效性”，是 transfer 场景刚需。
- iTransformer/DeepLOB 属于表征能力路线，不直接解决门控失配。

## 直接执行结论（针对 OpenAlice）
1. 先做校准与迁移稳定性：`CQR + adaptive(按regime) + shift-weighted gate`。
2. 再做模型扩容：新架构只作为离线信号源，不直接进入执行主链。
3. 以失败门槛为导向验收：
   - `gate_pass_robust_uplift`、`gate_pass_robust_ci` fail ratio 必须连续下降。
   - `transfer_false_ratio` 下降且无 error_ratio 上升。
