# Strategy Admission Gate（白名单准入门控）

## 目的

把“分层引入 + 白名单准入”从原则变成自动化决策：
- directional 策略必须串行通过：
  - main gate
  - transfer gate
  - stability gate
  - shadow gate
  - whitelist admit
- market_making 策略单独赛道，不和 directional 混门控。

## 输入

1. 外部基线报告：
- `data/research/external-benchmark/latest_external_benchmark_report.json`

2. 白名单策略策略元数据（许可/路线/稳定性等）：
- `data/research/strategy-watch/policies/strategy_admission_policy.json`

## 输出

- `data/research/strategy-watch/admission/latest_strategy_admission_report.json`
- `data/research/strategy-watch/admission/latest_strategy_admission_report.md`

## 运行命令

```bash
pnpm research:strategy-admission
```

仅查看不落盘：

```bash
pnpm research:strategy-admission:dry
```

## 决策枚举

- `admit_whitelist`: 允许进入白名单
- `hold_shadow`: 缺 shadow 通过
- `hold_stability`: 连续稳定轮数不够
- `hold_transfer_gate`: transfer 不通过
- `hold_main_gate`: main gate 不通过
- `separate_track`: 做市策略单独赛道
- `reject_license`: 许可策略不允许

## 许可规则

默认可代码级集成（permissive）：
- MIT
- Apache-2.0
- BSD-2-Clause / BSD-3-Clause
- MPL-2.0

默认受限（restricted）：
- GPL / AGPL / LGPL / Commons-Clause / NOASSERTION / Other

受限许可可通过 `allow_external_runner=true` 走“外部runner模式”，但不允许直接代码集成进核心仓库。

