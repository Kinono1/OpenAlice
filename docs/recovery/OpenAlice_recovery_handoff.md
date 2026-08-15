# OpenAlice Handoff — 2026-05-08

来源: 原始计划文件 lines 3103+

下面是可以直接复制给新 Codex 的接手 prompt。它包含当前 goal、完成度、已完成工作、未完成工作、正在做到一半的改动、验证命令、安全边界和下一步顺序。

你现在接手本机 OpenAlice 仓库任务。不要从头重读一切，先按下面 handoff 从当前 artifacts 和代码继续。

**仓库路径：** `/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice`

**外部数据路径：**
- `/Volumes/shield/cryptoData`
- `/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl`

**当前 active objective：** 将 OpenAlice 升级为多源 crypto 数据验收、策略研究、量化框架对标和交易 gate 主系统。以 `/Volumes/shield/cryptoData` 作为外部多源原始数据仓库，以 AI-Scientist crypto_dl 作为策略候选探索来源；系统性对标 QuantConnect LEAN、NautilusTrader、Freqtrade、vectorbt、Qlib、Hummingbot 等优秀量化工具，吸收 backtest/live parity、event-driven execution、order book matching、protections、hyperopt、portfolio/risk management、connector abstraction、fast parameter sweep、research workflow、evidence reporting 等能力，重点提升 OpenAlice 策略质量和证据链，而不是绕过交易限制。

---

## 绝对安全约束

- 不要打印 .env、API key、secret、passphrase、EXCHANGE_PASSWORD。
- 不要运行会泄露环境变量或进程 secret 的宽泛命令。
- 不要设置 `OPENALICE_ALLOW_UNGATED_PAPER_LANES=true`。
- 不要强行开启 paper/live。
- 不要发布 non-flat paper/live target。
- 不要修改 best_config.json 来强推策略。
- 不要降低 WFO/FDR/PIT/route-cost/slippage/prospective/paper/live/release gates。
- 不要把 research-only artifact 当成交易授权。
- 不要把 AI-Scientist candidate 当成可交易策略，它只能作为 research candidate，必须经过 OpenAlice 二次验收。
- 不要 revert 用户或其他 agent 的 dirty worktree。
- 当前 worktree 很脏是预期状态，只处理任务相关文件。
- 当前 goal 仍 active，不能标记 complete。

## 技能/协作规则

`/Users/kino/Files/AGENTS.md` 要求每次先做 skills routing。相关技能是 trading-router、risk-core、backtest-core、market-intel-core。

开始后先读：
- `/Users/kino/Files/work_projects/code/expCode/effeciency/skills-hub/AGENTS.md`
- `/Users/kino/Files/work_projects/code/expCode/effeciency/skills-hub/HUB_RULES.md`

然后继续当前 OpenAlice 工作。

---

## 当前完成度（以最新 runtime artifacts 为准）

**最新 reason-chain：** `data/runtime/system_status_reason_chain.latest.json`
- generatedAt = 2026-05-08T05:58:32.539Z
- overallPlanCompletionPct = 49
- effectiveActionability = research_only_blocked
- paperTradingAllowed = false
- liveTradingAllowed = false
- canPromote = false

**goal completion audit：** `data/runtime/openalice_goal_completion_audit.latest.json`
- Goal complete = false
- Effective actionability = research_only_blocked
- Overall plan completion = 49%
- Checklist completion = 66%
- Required blocked/missing = 7/0
- paper/live/promote = false/false/false

**当前结论：**
- 仍然不能证明赚钱。
- 仍然不能 paper。
- 仍然不能 live。
- 仍然不能 promotion。
- 这不是"盈利进步"，而是数据链路、安全 gate、证据链和策略缺陷覆盖的工程进步。
- 当前 goal 不能完成，不能调用 update_goal complete。

---

## 最新真实状态摘要

1. OKX public data 可用于 research，live data fresh。reason-chain 里 Live data = available，但 usableForPromotion=false，usableForPaperExecution=false。

2. OpenAlice data catalog 仍 blocked，但有进展：data catalog complete = 76/99（之前是 73/99）。

3. ETH carry 仍 blocked：`data/research/eth_carry_research_evidence_status.latest.json`
   - status = research_only_blocked
   - profitabilityVerdict = cannot_claim_profitable
   - blockers 包括 WFO/significance/risk_simulation/economics/net_expectancy/prospective/paper telemetry/trial ledger/FDR

4. Strategy quality gate coverage 有小幅实际提升：
   - `data/research/strategy_quality_gate_coverage.latest.json`
   - status = blocked, defects = 48, monitorFindings = 16
   - monitorCovered = 17, monitorUncovered = 31, coveragePct = 35
   - p0p1OpenOrPartial = 27, p0p1OpenOrPartialUncovered = 17
   - p0OpenOrPartialUncovered = 4, p1OpenOrPartialUncovered = 13
   - 之前 coveragePct = 33，p0p1OpenOrPartialUncovered = 18

5. risk_controls 当前还剩未覆盖：
   - 3.2 MarketIntel blacklist is reactive
   - 3.6 leverage is not volatility adaptive
   - 3.3 已经从未覆盖里移除。

---

## 已经完成并验证的工作

完成了缺陷 3.3 panic/regime no-open gate。

**核心行为：** event-risk-freeze / vol-stress 下，如果 governance 被压到 reduce：
- new open 必须 blocked
- genuine reduce/close 仍 pass-through

**已完成文件：**
- `src/domain/strategy/execution.ts`
- `src/domain/strategy/execution-decision.spec.ts`
- `scripts/build_panic_regime_no_open_gate_status.ts`
- `scripts/build_panic_regime_no_open_gate_status.spec.ts`
- `scripts/build_strategy_defect_monitor.ts`
- `scripts/build_strategy_defect_monitor.spec.ts`
- `scripts/build_strategy_defect_registry.ts`
- `scripts/build_strategy_defect_registry.spec.ts`
- `package.json`

**新增 runtime artifact：** `data/runtime/panic_regime_no_open_gate_status.latest.json`

该 artifact 当前：
- status = pass, researchOnly = true, diagnosticOnly = true
- promotionEligible = false, paperTradingAllowed = false, liveTradingAllowed = false
- executionAllowed = false
- eventFreezeRegime = event-risk-freeze, eventFreezeActionStatus = reduce
- eventFreezeOpenDecisionMode = blocked, eventFreezeReduceDecisionMode = pass-through
- volStressRegime = vol-stress, volStressOpenDecisionMode = blocked
- volStressReduceDecisionMode = pass-through
- blockers = []

**已跑过并通过：**
```bash
./node_modules/.bin/vitest run --config vitest.scripts.config.ts \
  scripts/build_panic_regime_no_open_gate_status.spec.ts \
  scripts/build_strategy_defect_monitor.spec.ts \
  scripts/build_strategy_defect_registry.spec.ts \
  scripts/build_strategy_quality_gate_coverage.spec.ts
# 4 files passed, 13 tests passed

./node_modules/.bin/vitest run \
  src/domain/strategy/execution-decision.spec.ts \
  src/domain/strategy/governance/governance.spec.ts
# 2 files passed, 18 tests passed

./node_modules/.bin/tsc --noEmit --pretty false
# 通过，无输出
```

**已刷新 artifacts：**
```bash
./node_modules/.bin/tsx scripts/build_panic_regime_no_open_gate_status.ts
./node_modules/.bin/tsx scripts/build_strategy_defect_monitor.ts
./node_modules/.bin/tsx scripts/build_strategy_defect_registry.ts
./node_modules/.bin/tsx scripts/build_strategy_quality_gate_coverage.ts
./node_modules/.bin/tsx scripts/build_openalice_goal_completion_audit.ts
./node_modules/.bin/tsx scripts/build_system_status_reason_chain.ts
```

**刷新结果重点：**
- Strategy defect monitor: findings = 16, blocked = 5, p0 = 3, p1 = 2
- Strategy defect registry: defects = 48, open = 15, partial = 18, watch = 15, pass = 0
  - p0OpenOrPartial = 10, p1OpenOrPartial = 17
- Strategy quality gate coverage: coveragePct = 35, p0p1OpenOrPartialUncovered = 17
  - risk_controls uncovered = [3.2, 3.6]

---

## 当前正在进行但尚未完成的工作

开始推进缺陷 3.2：MarketIntel blacklist is reactive。

**目标：** 让 MarketIntel risk_off / severe_news / lane_not_allowed / bannedSymbols 在新开仓前形成硬拒绝证据，类似刚完成的 3.3：
- 新开仓 blocked
- 不授权 paper/live/promotion
- 生成 runtime artifact
- 接入 strategy_defect_monitor
- 接入 strategy_defect_registry
- 让 3.2 从 risk_controls uncovered 中移除

**已开始修改/新增但未完成验证：**

`src/runtime/paper_open_context.ts`
- 新增 PaperOpenContextStatus = symbol_blocked
- buildPaperOpenContextSnapshot 增加 symbol?: string 参数
- resolvePaperOpenContextStatus 增加 bannedSymbols 检查
- 用 isMarketIntelSymbolBanned(context, symbol) 判断 symbol_blocked

`scripts/paper_trade_cross_sectional.ts`
- buildMarketIntelOpenContextSnapshot 增加 symbol?: string
- 开仓/rejected shadow open 上下文开始传 order.symbol

`scripts/paper_trade_volume_breakout.ts`
- buildPaperOpenContextSnapshot 调用开始传 signal.symbol
- 注意：我临时用了 new Date()，新 Codex 需要检查是否应该改成调用处已有决策时间，避免 PIT/测试不稳定。

`scripts/paper_trade_microstructure_stress.ts`
- buildPaperOpenContextSnapshot 调用开始传 signal.symbol
- 同样注意 new Date() 需要检查是否应改为已有 gate/decision time。

**新增文件：**
- `scripts/build_market_intel_no_open_gate_status.ts`
- `scripts/build_market_intel_no_open_gate_status.spec.ts`

**package.json 已开始接入：**
- 新增脚本：`research:strategy:market-intel-no-open-gate = tsx scripts/build_market_intel_no_open_gate_status.ts`
- status:research-evidence 中已插入，位置在 build_stale_data_no_open_gate_status.ts 和 build_panic_regime_no_open_gate_status.ts 之间

**但 3.2 还没有完成：**
- 还没跑新 spec。
- 还没接入 scripts/build_strategy_defect_monitor.ts。
- 还没接入 scripts/build_strategy_defect_registry.ts。
- 还没更新相关 spec fixtures。
- 还没刷新 artifacts。
- 还不能声称 3.2 已覆盖。

---

## 下一步优先任务

先完成 3.2 MarketIntel no-open gate，不要切去别的方向。

### 建议具体步骤

1. 检查刚改的 paper_open_context 和三个 paper trader 调用点，确保时间参数不会破坏 PIT/测试稳定性。
   - 重点文件：src/runtime/paper_open_context.ts, scripts/paper_trade_cross_sectional.ts, scripts/paper_trade_volume_breakout.ts, scripts/paper_trade_microstructure_stress.ts

2. 跑/修新测试：
   ```bash
   ./node_modules/.bin/vitest run --config vitest.scripts.config.ts scripts/build_market_intel_no_open_gate_status.spec.ts
   ```

3. 如果失败，优先修：market intel context validUntil / coldStartRoundsRemaining / allowNewPositionsByLane fixture, symbol_blocked reject reason, package.json 脚本 wiring

4. 接入 strategy defect monitor：修改 scripts/build_strategy_defect_monitor.ts
   - CliArgs 加 marketIntelNoOpenGateStatusPath
   - parse 默认值：data/runtime/market_intel_no_open_gate_status.latest.json
   - sourceArtifacts 加 marketIntelNoOpenGateStatus
   - readJsonIfExists 加 marketIntelNoOpenGateStatus
   - build input 加 marketIntelNoOpenGateStatus
   - findings 中加入 checkMarketIntelNoOpenGate(...)
   - 新 finding id：market_intel_no_open_gate
   - status pass 条件：artifact status pass, promotionEligible=false, paperTradingAllowed=false, liveTradingAllowed=false, executionAllowed=false, 所有 check 状态正确, allowedRejectReasons=[]
   - blockers 要包括 artifact missing/not pass/execution authorization 等 fail-closed 原因

5. 更新 scripts/build_strategy_defect_monitor.spec.ts
   - parse default 断言补 marketIntelNoOpenGateStatusPath
   - sourceArtifacts fixtures 补 marketIntelNoOpenGateStatus
   - build report fixtures 补 marketIntelNoOpenGateStatus
   - temp-file run fixture 写入 marketIntelNoOpenGateStatus()
   - runStrategyDefectMonitor 参数补 marketIntelNoOpenGateStatusPath
   - summary findings 应从 16 -> 17
   - manifest recordsOut 应从 16 -> 17

6. 接入 strategy defect registry：修改 scripts/build_strategy_defect_registry.ts
   - CliArgs 加 marketIntelNoOpenGateStatusPath
   - parse 默认值：data/runtime/market_intel_no_open_gate_status.latest.json
   - sourceArtifacts 加 marketIntelNoOpenGateStatus, RegistrySources 加 marketIntelNoOpenGateStatus
   - DEFECT_CATALOG 中 3.2：evidencePaths 增加 paper_open_context.ts, market_intel_context.ts, market_intel_no_open_gate_status.latest.json；relatedMonitorFindingIds 增加 market_intel_no_open_gate
   - assessDefect case '3.2'：如果 marketIntel artifact pass 且不授权 execution，则 status watch，blocker: market_intel_no_open_gate_runtime_validated_needs_live_context_coverage；否则维持 open，blocker: blacklist_is_reactive_not_pre_trade_gate

7. 更新 scripts/build_strategy_defect_registry.spec.ts
   - 增加断言：defect 3.2 status = watch, monitorCoverage covered=true, blockers 不包含 '3.2:blacklist_is_reactive_not_pre_trade_gate'

8. 跑 focused tests：
   ```bash
   ./node_modules/.bin/vitest run --config vitest.scripts.config.ts \
     scripts/build_market_intel_no_open_gate_status.spec.ts \
     scripts/build_strategy_defect_monitor.spec.ts \
     scripts/build_strategy_defect_registry.spec.ts \
     scripts/build_strategy_quality_gate_coverage.spec.ts
   ```

9. 跑类型检查：
   ```bash
   ./node_modules/.bin/tsc --noEmit --pretty false
   ```

10. 刷新 artifacts。

### 验收 3.2 是否完成

```bash
jq '.findings[] | select(.id=="market_intel_no_open_gate")' data/research/strategy_defect_monitor.latest.json
jq '.defects[] | select(.id=="3.2") | {id,status,relatedMonitorFindingIds,monitorCoverage,blockers,observed}' data/research/strategy_defect_registry.latest.json
jq '{summary, riskQueue:(.repairQueues[]| select(.queueId=="risk_controls")), uncoveredIds:(.uncoveredDefects|map(.id))}' data/research/strategy_quality_gate_coverage.latest.json
jq '{generatedAt,overallPlanCompletionPct,effectiveActionability,paperTradingAllowed,liveTradingAllowed,canPromote}' data/runtime/system_status_reason_chain.latest.json
```

**预期如果 3.2 成功：**
- 新 artifact: data/runtime/market_intel_no_open_gate_status.latest.json 以及 .manifest.json
- strategy_defect_monitor.summary.findings: 17
- market_intel_no_open_gate.status: pass
- defect 3.2.status: watch
- defect 3.2 monitorCoverage.covered: true
- risk_controls uncovered 从 [3.2, 3.6] 变成 [3.6]
- p0p1OpenOrPartialUncovered 从 17 降到 16
- coveragePct 应该小幅上升
- overallPlanCompletionPct 可能仍是 49
- paper/live/promote 仍然必须 false

---

## 之后下一步建议

完成 3.2 后，继续 3.6 dynamic leverage by volatility missing。不要先做大而泛的策略搜索。当前最有效是继续把 P0/P1 未覆盖缺陷逐个变成 runtime artifacts，然后才谈策略盈利证明。

### 后续优先队列

1. 3.6 dynamic leverage/volatility no-open or cap gate
2. 4.2 decision context snapshot coverage
3. 4.3 PIT availableAt global audit
4. 5.3 route-cost/slippage model completeness
5. 1.1.5 cross-sectional regime filter
6. 6.3/6.4 WFO/parameter stability guards
7. 7.1 portfolio-level risk management

---

## 回答用户时必须实话实说

- 当前不是已经赚钱。
- 当前没有 active tradable strategy。
- 当前不能 paper/live。
- 当前完成度 49%。
- 今天实际进展是：
  1. 完成 3.3 panic/regime no-open gate
  2. 生成 runtime artifact 并接入 defect monitor/registry/quality coverage
  3. strategy coverage 33% -> 35%
  4. P0/P1 uncovered 18 -> 17
  5. data catalog 73/99 -> 76/99
  6. 开始但未完成 3.2 MarketIntel no-open gate

最重要：不要为了安慰用户说"快赚钱了"。现在只能说"安全 gate 和证据链在变硬，但盈利证据仍 blocked"。真正赚钱需要后面通过 PIT/WFO/FDR/route-cost/slippage/prospective/paper telemetry/release gates。

**简短版：** 当前全局还是 49%，没赚钱、不能 paper/live。真正完成的进展是 3.3 panic/regime 风险硬门落地，策略质量 coverage 从 33% 到 35%，P0/P1 未覆盖从 18 到 17；3.2 MarketIntel no-open gate 已开始写，但还没验证收尾。
