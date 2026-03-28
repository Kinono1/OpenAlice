# G3/G4 候选收敛决策（2026-03-03）

## 输入
- 运行：`data/research/strategy/runs/latest_strategy_g3g4_iteration.md`
- 失败拆解：`data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.md`
- phase-B 搜索：`data/research/strategy/analysis/g3g4/latest_phaseb_family_search.md`

## 本轮结论
- 流程执行成功（全链路 green），但策略结论仍 `NO_GO`。
- 主要卡点不变：`fdrQ=0.369772 > 0.1`。
- `shift` profile 已把 `wfoFailureDensity` 从 `0.733333` 压到 `0.680556`，方向正确。

## 候选处理结果

### 保留（Keep）
1. `T43 trend_24_72_long_short`
2. `T42 trend_21_70_long_short`
3. `T46 trend_34_89_long_short`

原因：
- 在当前候选池内仍是最小 hard gap 的基线组；
- phase-B 扩展候选未带来更优 gate 结果。

### 淘汰（Drop）
- 本轮 phase-B 中 `hardGapMagnitude > 1.0` 的候选组（trend/breakout/ensemble 混合组）。

原因：
- 与基线相比，FDR 与 PBO 缺口更大，且无 WFO 通过增益。

### 下一轮扩展（Expand, 限制性）
- 仅允许 3-5 组“小步变体”，每组只改 1 个关键参数；
- 仍以 trend 主干为核心，不做大规模家族扩展。

## 下一轮执行命令（Day1）
1. `pnpm run strategy:g3g4:phaseb-search`
2. `python3 scripts/strategy_g3g4_iteration.py --execute-chain --with-phaseb-search --profile fast --protocol-profile shift --continue-on-error`
3. `python3 scripts/strategy_g3g4_failure_breakdown.py --run-id <latest_run_id>`

## 停止条件
- 连续 2 轮 `fdrQ` 无下降：停止扩搜，改做检验协议/样本分层修复。
- 连续 2 轮 `wfoFailureDensity` 上升：停止候选扩展，先修 WFO 稳定性。
