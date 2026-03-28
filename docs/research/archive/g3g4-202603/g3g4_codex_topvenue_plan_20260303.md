# G3/G4 顶会顶刊驱动修复计划（Codex）

## 0. 当前问题
- 目标未过：`G3/G4 = fail/fail`
- 核心瓶颈：`fdrQ=0.3698 > 0.1`
- 次级瓶颈：`wfoFailureDensity` 高（约 0.73），失败原因集中在 `degradation_exceeded` 与 `non_positive_sharpe`

## 1. 计划目标（本轮）
1) 不是追求立即 GO，而是把 `fdrQ` 和 `wfoFailureDensity` 同步往下压。
2) 用顶会顶刊证据约束搜索空间，减少盲扫参数。
3) 形成可复现的实验记录与下一轮候选池。

## 2. 3小时执行计划

### Phase A（0-45 分钟）：证据更新（Codex 检索）
- 任务：补充 2023-2025 相关顶刊/顶会证据（FDR/多重检验、WFO 稳定性、时序模型泛化）
- 输出：`docs/research/g3_g4_top_venue_research_brief_20260303_update.md`
- 验收：至少 8 条高质量来源，且每条映射到一个可执行改动

### Phase B（45-120 分钟）：协议层修复优先
- 任务：
  - 固化 ranking 目标：`min(wfoFailureDensity) -> min(hardGapMagnitude) -> max(sharpe)`
  - 增加 WFO 失败分段诊断（按窗口/regime）
  - 生成 phase-B 候选池并跑 fast iteration
- 命令：
  - `pnpm run strategy:g3g4:phaseb-search`
  - `python3 scripts/strategy_g3g4_iteration.py --execute-chain --with-phaseb-search --profile fast --continue-on-error`
- 验收：新一轮 breakdown 产出，且 `wfoFailureDensity` 不劣化

### Phase C（120-180 分钟）：候选收敛与决策
- 任务：
  - 比较 baseline 与本轮 top candidates
  - 输出“保留/淘汰/下一轮扩展”名单
  - 更新 72h runbook 的 Day1/Day2 参数
- 输出：
  - `docs/research/g3g4_candidate_decision_20260303.md`
- 验收：明确下一轮只保留 3-5 组候选

## 3. 硬性停止条件（防止盲跑）
- 连续 2 轮 `fdrQ` 无下降：停止扩搜，转入检验协议调整
- 连续 2 轮 `wfoFailureDensity` 上升：停止模型扩展，先修 WFO 稳定性
- 若 `G0/G1` 再次失败：先修环境/前置校验，不继续策略层迭代

## 4. 本轮最小执行集（手机速用）
1. `pnpm run env:verify`
2. `pnpm run strategy:g3g4:phaseb-search`
3. `python3 scripts/strategy_g3g4_iteration.py --execute-chain --with-phaseb-search --profile fast --continue-on-error`
4. `python3 scripts/strategy_g3g4_failure_breakdown.py --run-id <latest_run_id>`

