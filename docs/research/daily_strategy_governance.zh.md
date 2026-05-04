# Daily Strategy Governance（每日策略治理）

这个流程用于把“数据更新 -> 外部基线 -> 准入门控 -> 失败分解 -> 自适应优化执行 -> 健康检查”串成一个低噪声日更闭环。
从 2026-02-27 起，流程默认在最前面增加代码审查门禁（`review gate`），以实现“边跑边治理”。

## 一键运行

```bash
pnpm research:strategy-governance:daily
```

仅做联通验证（不写入结果）：

```bash
pnpm research:strategy-governance:dry
```

## 默认执行顺序

1. `scripts/systematic_review_gate.py`（默认 `--mode changed`，阻断 `critical/high`）
2. `scripts/daily_crypto_data_pull.sh`
3. `scripts/external_benchmark_harness.py`
4. `scripts/strategy_admission_gate.py`
5. `scripts/failure_breakdown.py`
6. `scripts/daily_strategy_optimize.sh`（默认 `OPTIMIZE_DIRECTION=adaptive`）
7. `scripts/daily_strategy_health_check.sh`
8. `scripts/gate_summary_snapshot.py`（打印最新 gate 汇总快照，含幂等 `duplicate/retry_override/retry_rejected` 指标）

脚本带进程锁：`.locks/daily_strategy_governance.lock`，并发启动会自动跳过。

## 常用环境变量

- `RUN_DATA_PULL=0|1`（默认 `1`）
- `RUN_EXTERNAL_BENCHMARK=0|1`（默认 `1`）
- `RUN_ADMISSION=0|1`（默认 `1`）
- `RUN_FAILURE_BREAKDOWN=0|1`（默认 `1`）
- `RUN_OPTIMIZE_LOOP=0|1`（默认 `1`）
- `RUN_HEALTH_CHECK=0|1`（默认 `1`）
- `RUN_GATE_SUMMARY=0|1`（默认 `1`）
- `RUN_REVIEW_GATE=0|1`（默认 `1`）
- `CONTINUE_ON_ERROR=0|1`（默认 `1`，失败不中断后续步骤）
- `DRY_RUN=0|1`（默认 `0`）
- `REVIEW_GATE_MODE=repo|changed`（默认 `changed`）
- `REVIEW_GATE_BLOCK_SEVERITIES=critical,high`
- `FAILURE_WINDOWS=8,20,30`
- `ADMISSION_MIN_STABILITY_CYCLES=2`
- `EXTERNAL_BENCHMARK_MANIFEST=<path>`
- `OPTIMIZE_DIRECTION_MODE=adaptive|cycle|risk|execution|regime|alpha|diversified`（默认 `adaptive`）
- `OPTIMIZE_TOP_K=2`
- `OPTIMIZE_MAX_RUNS_PER_CARD=2`
- `OPTIMIZE_SKIP_WATCH=1`
- `OPTIMIZE_DRAIN_QUEUE_FIRST=1`
- `OPTIMIZE_EXECUTE=1`
- `OPTIMIZE_CONTINUE_ON_ERROR=1`

示例：只更新榜单与准入，不跑数据拉取和健康检查

```bash
RUN_DATA_PULL=0 RUN_HEALTH_CHECK=0 pnpm research:strategy-governance:daily
```

## Cycle 降噪策略（2026-02-28 起默认）

为减少“无效训练内容”占比，`continuous_strategy_search.py` 默认启用两层降噪：

1. 历史 gate 预筛（history prune）
   - 按最近 `14` 个 cycle 统计 recipe 的 `gate_pass_lift`/`eligible` 通过率；
   - 当某 recipe 历史样本数达到阈值（默认 `3`）且两个通过率同时偏低时，优先从候选池剪枝；
   - 当前默认阈值：`min_recipe_lift_pass_rate=0.35`，`min_recipe_eligible_rate=0.10`；
   - 若剪枝过猛导致候选不足，会自动回补“损失最小”的 recipe，避免搜索停摆。

2. Stage2 条件执行（eligible-only）
   - 每个 cycle 先执行 main board（H0/H4/H5/H6）；
   - 仅当主板 winner 为 `eligible` 挑战者（非 H0 回退）时，才继续执行 mixed S0/S1；
   - 若主板无可晋级候选，默认跳过 Stage2，并在 cycle report 中记录 `stage2SkipReason`。

可调参数（`continuous_strategy_search.py`）：
- `--history-window-cycles`
- `--min-recipe-trials`
- `--min-recipe-lift-pass-rate`
- `--min-recipe-eligible-rate`
- `--disable-history-prune`
- `--stage2-on-eligible-only / --no-stage2-on-eligible-only`

## V3+ 观测字段（2026-02-28）

本轮治理新增“可观测优先”的 schema 与诊断字段，默认保持 gate 判决逻辑不变：

1. `search_state.json` / cycle report schema
   - `searchStateSchemaVersion=2.1.0`
   - `schemaVersion=2.1.0`
   - 新增 `schemaFeatures`、`legacyBackfilled`、`challengerCount`、`eligibleChallengerCount`、`candidateSurvivalRate`
   - 历史记录缺失 `stage2Executed/stage2SkipReason/selectionMeta` 时自动回填

2. regime 数值稳定与诊断
   - `wait_clean_and_retrain.py` 新增参数：
     - `--regime-kmeans-zclip`
     - `--regime-kmeans-scale-floor`
     - `--regime-kmeans-min-cluster-balance`
     - `--regime-kmeans-balance-threshold-mode`
     - `--regime-labeling-mode`
     - `--regime-kmeans-diagnostics-level`
   - `ml_ensemble_v1.py` 输出 `regimeSummary.diagnostics`

3. 诊断贯通
   - `retrain/summary.json` 新增 `regimeDiagnostics`
   - `board_main_aggregate.csv` / `board_mixed_aggregate.csv` 新增:
     - `regime_fallback_ratio_mean`
     - `regime_numeric_warning_mean`
     - `regime_cluster_balance_min`
     - `regime_time_index_miss_mean`
     - `regime_future_alignment_risk_mean`
   - `decision.md` 新增 `Regime Diagnostics Risk` 段落（提示用途，不影响 gate 判决）

## 建议定时（cron）

每天 UTC 01:10 跑一次：

```bash
10 1 * * * cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice && /bin/bash scripts/daily_strategy_governance.sh >> logs/daily_strategy_governance.log 2>&1
```

如果机器长时间关机，`daily_crypto_data_pull.sh` 会按 state 自动补历史缺口。
