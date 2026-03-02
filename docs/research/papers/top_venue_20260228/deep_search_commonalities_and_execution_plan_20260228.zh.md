# 顶会顶刊深搜：共性/差异 + OpenAlice 执行计划（2026-02-28）

> 目标：把论文方法转成可执行实验，直接提升 `robust`/`transfer` 通过率，并提高“可交易预测概率”而不是只提点预测分数。

## 0) 当前状态快照（基于进行中的 `cvar24-conformal-full-20260228T101517-conda`）
- 主榜运行进度：`H0/H4/H5` 已完成 12/12，`H6` 接近完成，随后进入 `S0/S1`。
- 关键观察：`H0/H4/H5` 的 run-level 聚合指标几乎一致。
  - 解释：`H4` 主要改变最新一跳决策阈值（`sell -> hold`），但对回测期总体统计几乎无影响。
  - 解释：`H5` 的 safety floor 在当前 universe 上未形成足够约束（非绑定）。
- 结论：下一轮优化不能再只做“弱门槛微调”，必须引入更正交的结构变化（校准方法、regime 建模、label 机制）。

---

## 1) 深度检索论文证据（只保留可落地机制）

### A. 时序建模与分布漂移
1. `iTransformer`（ICLR 2024）
   - 核心：将“变量维度”作为 token，强化跨变量关系建模。
   - 对应 OpenAlice：多资产横截面相关性建模可增强 regime 分层稳定性。
   - 链接：https://openreview.net/forum?id=JePfAI8fah

2. `TimeMixer`（ICLR 2024）
   - 核心：分解式多尺度混合（decomposable multiscale mixing）。
   - 对应 OpenAlice：建议把单一 horizon 训练扩展为多尺度特征再集成。
   - 链接：https://openreview.net/forum?id=7oLshfEIC2

3. `PatchTST`（ICLR 2023）
   - 核心：patching + channel-independent transformer，提升长序列稳定性。
   - 对应 OpenAlice：可作为离线信号源，避免直接替换执行主链。
   - 链接：https://arxiv.org/abs/2211.14730

4. `Non-stationary Transformers`（NeurIPS 2022）
   - 核心：Series Stationarization + De-stationary Attention，显式处理时序分布漂移。
   - 对应 OpenAlice：直接映射到“regime shift 下 gate 稳定性”。
   - 链接：https://openreview.net/forum?id=ucNDIDRNjjv

5. `RevIN`（ICLR 2022）
   - 核心：可逆实例归一化（instance-level normalization）以抵御分布偏移。
   - 对应 OpenAlice：可做 symbol-level 输入正则层，降低跨源统计偏移。
   - 链接：https://openreview.net/forum?id=cGDAkQo1C0p

### B. 不确定性与覆盖率控制
6. `Conformalized Quantile Regression (CQR)`（NeurIPS 2019）
   - 核心：分位回归 + conformal 校准，得到有限样本覆盖保证。
   - 对应 OpenAlice：`decisionUseConformalLowerBound` 的理论基座。
   - 链接：https://papers.nips.cc/paper/8613-conformalized-quantile-regression

7. `Adaptive Conformal Inference Under Distribution Shift`（NeurIPS 2021）
   - 核心：在 shift 下自适应更新覆盖控制。
   - 对应 OpenAlice：`coverage_shift_weighted` 应该参与 transfer 门控。
   - 链接：https://papers.nips.cc/paper/2021/hash/0d441de75945e5acbc865406fc9a2559-Abstract.html

8. `Conformal Prediction Under Covariate Shift`（ICML 2020）
   - 核心：用重要性权重修正测试分布覆盖有效性。
   - 对应 OpenAlice：你现在的 regime-frequency 加权是可行近似，但需要 clip + 稳健统计。
   - 链接：https://proceedings.mlr.press/v119/tibshirani20a.html

9. `Conformal Risk Control`（ICLR 2024）
   - 核心：把“错误风险约束”纳入 conformal 决策，不只追 coverage。
   - 对应 OpenAlice：可把 gate 从“coverage-only”升级为“风险上界可控”。
   - 链接：https://openreview.net/forum?id=33XGfHLtZg

### C. 现实金融任务证据（问题难度）
10. `Forecasting Direction of Cryptocurrency Prices`（Applied Soft Computing, 2023）
   - 证据：明确报告加密资产方向预测中的非线性、噪声与类别不平衡问题。
   - 对应 OpenAlice：解释为什么“单次收益高”不等于可迁移稳定策略。
   - 链接：https://www.sciencedirect.com/science/article/pii/S1568494623004450

11. `TimesFM`（Google Research, 2024）
   - 核心：时间序列基础模型（foundation model）可作强基线。
   - 对应 OpenAlice：可作为“离线 teacher 信号”或横向基准，不直接接执行层。
   - 链接：https://arxiv.org/abs/2310.10688

---

## 2) 共同点与差异（只谈本质）

### 共同点（对你任务最关键）
- `预测 -> 决策` 之间必须显式建模不确定性；只看点预测会高估可交易收益。
- `覆盖率` 必须在目标分布（target/shifted distribution）上评估，不然 transfer 会失真。
- `架构升级` 的收益依赖于数据分布治理；否则复杂模型只会更快过拟合。

### 差异点（决定实验优先级）
- iTransformer/TimeMixer/PatchTST：偏“表示能力”增强。
- CQR/Adaptive/Covariate-Shift/CRC：偏“决策可靠性”增强。
- 在你当前阶段，后者优先级更高，因为当前主要失败是 gate 与 transfer 稳定性。

---

## 3) 对当前失败模式的本质解释

1. `H4/H5` 贡献偏弱不是模型没用，而是 gate 非绑定。
- H4：主要影响最新一步决策方向，难改变历史聚合指标。
- H5：阈值仍落在现有模型分布的“安全区”，过滤强度不足。

2. 现有优化回路仍有“弱正交”问题。
- 多个配置共享同一特征/label/regime 主干，导致实验信息增益低。

3. transfer 风险依然是上线阻断点。
- 论文共识与实证都指向：必须把 shift-aware 指标作为硬门控，而不是诊断项。

---

## 4) 已落地改动（本轮）

### 4.1 新增更正交实验 profile
- 文件：`scripts/profiles/cvar_next_gates_v3_shift_uncertainty.json`
- 设计目标：避免重复验证同一决策边界，强制引入结构差异。

配置说明：
- `H0`：当前 baseline。
- `H7`：`isotonic + stricter decision gate + lower alpha`（覆盖更稳，交易更保守）。
- `H8`：`kmeans regime + shift clip tightening`（强化漂移适应）。
- `H9`：`ridge 扩模 + next_return_sign label + stricter safety floor`（测试标签机制与模型多样性）。

建议启动命令（当前机器）：
```bash
/opt/miniconda3/bin/python3 scripts/run_cvar_next_matrix.py \
  --experiment-id cvar24-gatesv3-$(date +%Y%m%dT%H%M%S) \
  --profile-file scripts/profiles/cvar_next_gates_v3_shift_uncertainty.json \
  --python-bin /opt/miniconda3/bin/python3 \
  --execute \
  --continue-on-error
```

---

## 5) 超细执行计划（研究 -> 实验 -> 准入）

## Phase 1（0-6 小时）: 收口当前 run，拿到可比基线
1. 完成 `cvar24-conformal-full-20260228T101517-conda` 全量。
2. 导出主榜/副榜 + failure breakdown。
3. 产出 `gate binding report`：定位“哪些阈值从未触发”。

验收条件：
- 24 run 全部终态（done/failed 无 running/pending）。
- `decision.md`、`board_main_aggregate.csv`、`board_mixed_aggregate.csv` 完整可读。

## Phase 2（6-18 小时）: 跑 gates_v3 主榜
1. 运行主榜 16 组（H0/H7/H8/H9 x 4 seeds）。
2. 强制比较三类差异：
   - `robust_ci_lb95`（稳定收益下界）
   - `conformal_coverage_shift_mean`（分布偏移覆盖）
   - `error_ratio_mean`（工程可靠性）
3. 若 H7/H8/H9 均不优于 H0，触发快速改参分支（只改阈值，不改结构）。

验收条件：
- 至少 1 个 challenger 满足：
  - `gate_pass_robust_uplift=true`
  - `gate_pass_robust_ci=true`
  - `gate_pass_conformal_shift_diag=true`

## Phase 3（18-30 小时）: mixed transfer 与 shadow 准入
1. 物化 `S0/S1` 并跑副榜 transfer。
2. 以 `transfer_pass=true` 作为唯一准入门。
3. 进入 shadow（不提升资金档位）。

验收条件：
- `transfer_false_ratio` 相比上一轮下降。
- 无 `error_ratio_mean` 上升。

## Phase 4（D2-D14）: 深度路线（分两条并行）
1. 表征路线：
   - 加离线信号源（PatchTST/iTransformer/TimesFM）仅离线评估。
2. 可靠性路线：
   - 上 `Conformal Risk Control` 风格约束门控。
   - 引入 regime 自适应覆盖更新（Adaptive Conformal）。
3. 工程路线：
   - 每日定时拉数 + 开机补数（backfill） + 数据完整性断言。

KPI（14 天）:
- 主目标：`gate_pass_robust_ci` fail ratio 持续下降。
- 次目标：`transfer_pass` 提升且不牺牲 `error_ratio`。
- 上线前硬门：连续多轮稳定 + 一整轮 shadow 无重大回撤异常。

---

## 6) 直接结论
- 目前“有进步迹象”主要来自不确定性可观测性增强（conformal 指标已稳定输出），但还没到可上线级别。
- 下一跳最有效动作不是继续微调旧阈值，而是执行 `gates_v3` 这种“结构正交 + shift-aware”实验。
- 先把 transfer 稳定性打穿，再谈更大模型或实盘放量。

