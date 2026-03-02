# External Benchmark Harness 使用说明

## 目标

把外部框架（Freqtrade / Qlib / Hummingbot / 其他）的回测结果统一映射为 OpenAlice 风格指标，并按当前 H0 基线执行主榜 gate 对比。

产物目录：
- `data/research/external-benchmark/latest_external_benchmark_report.json`
- `data/research/external-benchmark/latest_external_benchmark_report.md`
- `data/research/external-benchmark/external_main_aggregate.csv`

## 快速开始

1. 生成示例 manifest（只生成一次）：
```bash
pnpm research:external-benchmark:init
```

2. 编辑 manifest：
- 文件：`data/research/external-benchmark/inputs/runs_manifest.json`

3. 运行 benchmark：
```bash
pnpm research:external-benchmark
```

4. 检查环境可用性（可选）：
```bash
pnpm research:external-benchmark:probe
```

## Manifest 格式

顶层字段：
- `runs`: 数组

每个 run 支持字段：
- `run_id`: 唯一 ID（必填）
- `framework`: `freqtrade`/`qlib`/`hummingbot`/自定义（建议填）
- `strategy`: 策略名（建议填）
- `artifact`: 结果文件路径（必填，支持相对仓库路径）
- `artifact_type`: `freqtrade_backtest_json` / `generic_metrics_csv` / `openalice_leaderboard_csv` / `auto`
- `candle_count`: 仅 `freqtrade_backtest_json` 可选，用于更准确换手估算

## 支持的输入类型

1. `generic_metrics_csv`
- 每行一个标的或分片结果，需包含以下指标（或可识别别名）：
  - robust: `robust_cost_aware_utility` / `robust`
  - cost: `cost_aware_utility` / `cost`
  - net: `net_return_pct_after_cost` / `net_return_pct`
  - lift: `accuracy_lift` / `lift` / `winrate`
  - turnover: `turnover_per_bar` / `turnover`

2. `openalice_leaderboard_csv`
- 直接复用 OpenAlice 的 `leaderboard.csv` 字段。

3. `freqtrade_backtest_json`
- 读取 `results_per_pair` 并做近似映射：
  - `net_return_pct_after_cost` ← `profit_total_pct`（或兼容字段）
  - `accuracy_lift` ← `winrate - 0.5`
  - `turnover_per_bar` ← `trades / candle_count`（若未提供 candle_count 则退化估算）
  - `robust_cost_aware_utility` ← `net - 0.5 * abs(drawdown_pct)`（近似）

## Gate 对齐规则

脚本会自动读取最近一个 `completedRuns>=24` 的 cycle 中 `H0` 主榜指标，按主榜规则判定：
- `gate_pass_robust_uplift`
- `gate_pass_robust_ci`
- `gate_pass_variance`
- `gate_pass_lift`
- `gate_pass_net_trim10`
- `gate_pass_error_ratio`
- `eligible`（以上全部通过）

## 注意事项

1. 外部框架结果与 OpenAlice 指标并非完全同构，`freqtrade_backtest_json` 属近似映射，优先使用 `generic_metrics_csv` 精确对齐字段。
2. GPL/AGPL/Commons-Clause 项目建议仅作为外部 runner，不要直接拷贝代码进核心仓库。
3. 建议先跑 smoke 级别的小样本，再扩大到完整资产池。

