# OpenAlice 策略研究总计划（2026-02-27）

## 0. 计划定位

- 目标：把“持续搜索但难过门槛”的现状，转成“可重复通过主榜 + transfer gate”的稳定流程。
- 范围：仅覆盖当前 `cvar-next` 自动搜索链路，不改交易主链上线策略（默认继续 H0）。
- 执行基线日期：2026-02-27（UTC）。

## 1. 现状基线（来自自动失败分解）

数据源：
- `data/research/strategy-watch/analysis/latest_failure_breakdown.json`
- `data/research/strategy-watch/analysis/latest_failure_breakdown.md`

关键事实：
- Window=8：`champion_h0_ratio=1.0000`，`transfer_false_ratio=1.0000`
- Window=20：`champion_h0_ratio=0.7000`，`transfer_false_ratio=1.0000`
- Window=30：`champion_h0_ratio=0.6667`，`transfer_false_ratio=1.0000`

主榜失败门槛（最近 20 cycles）：
- `gate_pass_robust_uplift`: 0.3500
- `gate_pass_lift`: 0.3333
- `gate_pass_robust_ci`: 0.3167
- `gate_pass_variance`: 0.2167

transfer 失败门槛（最近 20 cycles）：
- `gate_pass_robust_delta`: 0.7000
- `gate_pass_turnover_cap`: 0.3000

结论：
- 失败不是“流程挂了”，而是“候选策略质量 + 跨源泛化能力”不足。
- 下一阶段要优先打通 `robust_uplift/lift`（主榜）和 `robust_delta/turnover`（transfer）。

## 2. 总体目标与硬门槛（14 天）

### 2.1 一级目标（必须同时满足）

1. 最近 8 cycles 的 `champion_h0_ratio <= 0.50`
2. 最近 8 cycles 的 `transfer_false_ratio <= 0.50`
3. `gate_pass_robust_delta` 失败率（window=8）下降到 `<= 0.50`
4. `gate_pass_robust_uplift` 失败率（window=8）下降到 `<= 0.25`

### 2.2 二级目标（上线前仍需观察）

1. 至少出现连续 2 个 cycle：`champion != H0` 且 `transferPass=True`
2. 新冠军在 `window=20` 不出现显著退化（`robust_ci_lb95` 不低于基线）
3. 维持 `error_ratio_mean <= 0.2`

## 3. 论文证据到改进方向映射（deep-dive）

证据源：
- `data/research/strategy-watch/deep-dive/latest_digest.md`
- `data/research/strategy-watch/deep-dive/latest_experiment_cards.md`

优先参考（按问题映射，不按论文分数）：

1. `2601.07852v1` Utility-Weighted Forecasting and Calibration  
   用途：把预测目标直接对齐交易效用和摩擦，优先解决 `robust_uplift` 与 `lift` 失效。
2. `2510.02986v1` FR-LUX: Friction-Aware, Regime-Conditioned  
   用途：在制度切换 + 交易摩擦下约束策略更新，重点压 `variance` 与 `turnover`。
3. `2512.22476v1` AutoQuant  
   用途：执行约束 + 双筛选治理，降低“参数搜索乐观偏差”，增强 transfer 稳定性。
4. `2509.12764v1` Myopic Optimality  
   用途：提醒 RL 策略在高摩擦下容易退化，作为“不要盲目上 RL”的反证基准。
5. `2502.13722v2` Deep Learning for VWAP Execution in Crypto  
   用途：补 execution 层成本模型，提高 `turnover_cap` 和净收益稳定性。
6. `2601.22113v2` Diverse Approaches to Optimal Execution Schedule  
   用途：执行调度层，优化冲击/风险平衡，减少 transfer 场景下的鲁棒损失。
7. `2508.15922v1` Probabilistic Forecasting Cryptocurrencies Volatility  
   用途：引入分位/不确定性信息，缓解 `robust_ci` 门槛失败。
8. `2602.07018v2` Sentiment Regimes and Adverse Selection  
   用途：事件-制度耦合特征，提升 regime 切换时的有效 lift。

## 4. 研究工作流（全量分阶段）

## Phase A（D1-D2）基线固化与可观测性

目标：
- 把失败分解、论文深挖、候选卡片产物标准化为每日固定输出。

执行项：
1. 每次优化 loop 后自动跑失败分解：
   - `pnpm research:failure-breakdown`
2. 每日深挖论文快照（独立目录）：
   - `pnpm research:strategy-watch -- --query-profile crypto_plus --out-dir data/research/strategy-watch/deep-dive --state-file data/research/strategy-watch/deep-dive/state.json --lookback-days 540 --cards-source recent_only --max-cards 16`
3. 报警阈值绑定失败分解结果：
   - 若 `champion_h0_ratio(window=8)>0.8` 连续 3 次，暂停新增大改，仅做稳健修复。

验收：
- `analysis/latest_failure_breakdown.{json,md}` 每日更新。
- deep-dive 卡片可持续生成（允许单次 429，不能连续 24 小时失败）。

## Phase B（D3-D5）主榜门槛攻坚（robust_uplift/lift）

目标：
- 降低主榜门槛失败率，减少 H0 回退依赖。

执行项：
1. Utility-weighted 目标重排（参考 2601.07852）：
   - 将候选排序从单点准确率进一步约束到净效用/成本敏感。
2. 不确定性校准增强（参考 2508.15922）：
   - 在候选筛选引入分位/校准信号，抑制高方差虚高模型。
3. regime 条件化开关（轻量）：
   - 仅在高置信 regime 下开放进攻型策略，其他 regime 使用保守 clamp。

实验协议：
1. Smoke：每方向先 `--max-runs 4`
2. Full：通过 smoke 后跑全 seeds
3. 每个改动单变量，不并发引入 2 个核心机制

验收：
- window=8 的 `gate_pass_robust_uplift` 失败率下降到 `<=0.30`
- window=8 的 `gate_pass_lift` 失败率下降到 `<=0.30`

## Phase C（D6-D9）transfer 攻坚（robust_delta/turnover）

目标：
- 把 `transferPass=False` 的结构性失败压下去。

执行项：
1. 跨源一致性惩罚（source-invariant penalty）：
   - 对 UM-only 与 mixed 的性能差异显式正则，降低 `robust_delta` 失败。
2. 成本/换手联合约束（参考 FR-LUX + VWAP）：
   - 在目标中提高 turnover 惩罚权重，加入流动性分层成本。
3. 执行时序策略（参考 execution schedule）：
   - 高冲击时段降频，平滑执行节奏。

验收：
- window=8 的 `gate_pass_robust_delta` 失败率下降到 `<=0.65`
- window=8 的 `gate_pass_turnover_cap` 失败率下降到 `<=0.20`

## Phase D（D10-D12）统计稳健与抗过拟合治理

目标：
- 避免“看起来提升，实际不可迁移”。

执行项：
1. 强化双筛选治理（参考 AutoQuant）：
   - 先主榜过门槛，再 transfer 过门槛，任何一级不通过即拒绝晋级。
2. 失败原因归因闭环：
   - 对每个失败 cycle 打标签（主因 + 次因）并回写统计。
3. 多窗口一致性检查：
   - 8/20/30 三窗口趋势方向必须一致，防止短窗偶然性。

验收：
- 连续 5 个 cycle 的 `error_ratio_mean <= 0.2`
- 不出现“window=8 改善但 window=20/30恶化”的反向漂移

## Phase E（D13-D14）影子验证与晋级决策

目标：
- 仅在“主榜 + transfer + 稳健性”都达标时考虑晋级。

执行项：
1. 候选冠军固定后做一轮 shadow（不加资金，仅并行记录）
2. 若 shadow 出现门槛回退，立即回滚 H0 并归档失败模式

最终决策标准：
1. 满足第 2 章一级目标
2. 最近 2 个 cycle 连续 `champion != H0` 且 `transferPass=True`
3. 没有新增系统性风险告警（health check 为 `ok`）

## 5. 每日执行清单（固定 SOP）

1. 论文扫描与实验卡更新  
   - `pnpm research:strategy-watch -- --query-profile crypto_plus`
2. 运行优化 loop（已有 launchd）  
   - `bash scripts/daily_strategy_optimize.sh`
3. 队列排空  
   - `pnpm research:strategy-drain-queue -- --max-items 1`
4. 健康检查  
   - `pnpm research:strategy-health-check`
5. 失败分解  
   - `pnpm research:failure-breakdown`
6. 每日晚间查看三份产物：
   - `execution/latest_loop_report.json`
   - `health/latest_health_report.json`
   - `analysis/latest_failure_breakdown.md`

## 6. 风险登记与应对

1. arXiv 429 限流  
   - 应对：降低 query 并发，增加重试退避；保留上次有效 `latest_*`。
2. 长训练占用导致队列积压  
   - 应对：保持 `queue_max_items` + `queue_legacy_max_items`，并持续 drain。
3. 伪提升/过拟合  
   - 应对：强制双榜门槛 + 多窗口一致性 + 失败分解榜回归。
4. 高频改动造成不可比  
   - 应对：单变量实验 + 固定 seeds + 固定 universe。

## 7. 本计划的“完成定义”

满足以下条件才算“完成本轮研究计划”：

1. 一级目标 4 条全部达成；
2. 形成至少 1 套可复用的非 H0 策略配置，并连续通过 transfer；
3. 失败分解榜显示主失败门槛从“结构性失败”转为“偶发失败”；
4. 所有产物可由命令复现，不依赖手工分析。

