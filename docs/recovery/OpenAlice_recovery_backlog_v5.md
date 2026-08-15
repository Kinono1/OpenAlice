此文件基于原计划 v4（Artifact-Bound Execution Backlog）的 lines 1-994，纳入了 2026-05-08 代码审查的 10 项硬门控修改。旧版内容已移入 archive 文件。所有新 blocker 映射到 P0/P1/P2 具体任务。

# OpenAlice v5 Recovery Backlog — Code-Review Version

**日期**: 2026-05-08（10 项硬门控更新）
**版本**: v5 — 基于 runtime artifact + 2026-05-08 代码审查硬门控
**状态**: 待执行

---

## ⚠️ 当前硬状态：Research-only Blocked（不可撤销声明）

截至 2026-05-08T08:23:11Z snapshot，OpenAlice 当前状态为：

| 维度 | 值 |
|------|-----|
| overallPlanCompletionPct | **49%** |
| effectiveActionability | **research_only_blocked** |
| paperTradingAllowed | **false** |
| liveTradingAllowed | **false** |
| canPromote | **false** |
| strategy_promotion.finalVerdict | **quarantined** |

**本计划当前不得被解释为 paper trading 恢复计划，更不得被解释为 live trading 恢复计划。**

当前唯一允许的目标是：
1. 修复 P0 安全隔离（accounts.json 硬隔离、lock 自动释放、kill switch 强制启用）
2. 修复 dirty worktree quarantine → evidence chain 传播
3. 建立 append-only event ledger
4. 提升 cost evidence coverage（当前 2/947 = 0.21%）
5. 提升 MFE/MAE evidence coverage（当前 10/947 = 1.06%）
6. 补齐 trial ledger / WFO / PBO / DSR / FDR
7. 消除 dirty worktree quarantine
8. 保持所有策略 quarantined

**在 WFO、PBO、DSR、FDR、trial ledger 全部通过前，策略 promotion 永久 blocked。**

---

## 0. 当前 Truth Snapshot

> 以下全部摘自 2026-05-08 当天的 runtime artifact。后续任何恢复动作必须先刷新这些 artifact，再读新值，不可基于本文档的静态数字做决策。

### 0.1 系统可行动性

| 字段 | 值 | 来源 |
|------|-----|------|
| effectiveActionability | **research_only_blocked** | `system_status_reason_chain.latest.json → /effectiveActionability` |
| liveTradingAllowed | **false** | `system_status_reason_chain.latest.json → /liveTradingAllowed` |
| paperTradingAllowed | **false** | `system_status_reason_chain.latest.json → /paperTradingAllowed` |
| canPromote | **false** | `system_status_reason_chain.latest.json → /canPromote` |
| overallPlanCompletionPct | **49** | `system_status_reason_chain.latest.json → /overallPlanCompletionPct` |
| generatedAt | 2026-05-08T06:19:44.641Z | `system_status_reason_chain.latest.json → /generatedAt` |

**解读**: 系统不是"瘫痪"，而是 research_only_blocked——数据在流动、进程在跑、门控在工作。问题是证据层不完整导致 promotion 全部阻断。P0 后可进入 observation-only / replay-only，**是否进入 paper-light 必须由 P0 healthcheck + cost evidence + MFE/MAE evidence + trial ledger + dirty worktree quarantine 全部通过后重新判定**。

### 0.2 进程状态（抽查，非 runtime artifact）

| 进程 | 状态 | 启动路径 |
|------|------|----------|
| ai.openalice.main | **运行中** | `/opt/homebrew/Cellar/node/25.2.1/bin/node` + `node_modules/.bin/tsx` |
| ai.openalice.paper-monitor | **运行中（⚠️ NO-OP）** | 同一路径，但 5 个 SKIP flags 全 true |
| binance data backfill (markPriceKlines) | **运行中** | `scripts/fast_binance_data_vision_backfill.ts` |

**注意**: paper-monitor 进程在跑但 SKIP_DATA SKIP_PAPER SKIP_OPTIMIZE SKIP_VALIDATION SKIP_SECOND_LEVEL 全部为 true，当前是空转 no-op。

### 0.3 数据覆盖

| 字段 | 值 | 来源 |
|------|-----|------|
| expectedAssets | **13** | `live_data_freshness.latest.json → /summary/expectedAssets` |
| presentAssets | **13** | `live_data_freshness.latest.json → /summary/presentAssets` |
| freshAssets | **12** | `live_data_freshness.latest.json → /summary/freshAssets` |
| 1h common periods | 1276 | `live_data_freshness.latest.json` |
| publicDataUsableForLiveOnlyResearch | **true** | `live_data_freshness.latest.json → /summary/publicDataUsableForLiveOnlyResearch` |

### 0.4 路由成本（runtime API verified — 仅作为 cost design budget，非 realized evidence）

| 路由 | totalExpectedCostBps | maxAllowed |
|------|---------------------|------------|
| passive_passive | **18** | 20 |
| passive_taker | **24** | 20 |
| taker_taker | **26** | 20 |
| twap | **27** | 20 |

Fee snapshot: maker=2 bps, taker=5 bps, source=api, verifiedByRuntime=true。

**重要降级**: 当前 routeCostBudget 只能作为 **cost design budget**，不是 **realized execution evidence**。由于 947 笔 closed trades 中仅 2 笔具备 predicted cost evidence（0.21%），route-level execution quality 仍为 **blocked**。18/24/26/27 bps 数字不得用于 promotion evidence。

### 0.5 策略 Promotion 全貌

| Gate | 状态 | 关键阻断 |
|------|------|----------|
| global_release | **fail** | release_gate_status_expired (2026-05-06) |
| research | **fail** | wfo_failed, pbo_indeterminate, dsr_missing, fdr_missing, trial_ledger_missing |
| monetization | **fail** | no_trade_benchmark_failed, simple_benchmark_pass_count_below_2 |
| paper | **fail** | 30+ 阻断（P1 evidence trust 6 维度全 quarantine、trial ledger skeleton、cost quarantine、stop_loss_cluster） |
| live | **fail** | tiny_cap_not_reviewed |

**finalVerdict: "quarantined"**

### 0.6 PnL 诊断（shadow 口径，仅供参考）

| 字段 | 值 |
|------|-----|
| closedTrades | 947 |
| context OK | **0/947 (0%)** |
| cost evidence (any) | **2/947 (0.21%)** |
| expected gross/net edge | **0/947 (0%)** |
| MFE/MAE coverage | **10/947 (1.06%)** |
| overall PF | 0.8646 |

### 0.7 其他关键阻断

- WFO: 5 windows 2 pass/3 fail, ratio=0.6 > 0.3 threshold
- IC: 15/15 factor symbol pairs all decayed
- Research incubation: no active line
- Data catalog: 79/99 complete, primary blocker=ai_scientist_validation_gate (15)
- Dirty worktree: 55 modified + 187 untracked — 证据不可复现

---

## 1. 这份计划是什么、不是什么

**是什么**: 一份绑定当前 runtime artifact 的恢复 backlog。每条任务都映射到 reason-chain 的具体 blocker、evidence path、当前完成百分比和 next action。

**不是什么**: 一份独立于 artifact 的"策略优化方案"。本文档里的任何数字如果与 runtime artifact 冲突，以 artifact 为准。Artifact 刷新后本文档即过期。

---

## 2. ⚠️ 核心约束（违反即作废）

1. **禁 live trading / paper trading**。当前 artifact 已强制: liveTradingAllowed=false, paperTradingAllowed=false, canPromote=false。P0 后只能进入 observation-only / replay-only，是否进入 paper-light 必须由 P0 healthcheck + cost evidence + MFE/MAE evidence + trial ledger + dirty worktree quarantine 全部通过后重新判定。
2. **禁 production API key**。只允许 demo trading key 或完全本地 paper executor。
3. **所有改动必须先刷新对应 artifact，再基于新 artifact 决策。** 不允许基于本文档的静态数字做执行判断。
4. **AI 自优化必须先审计写入历史，再以 read-only/suggestion-only 模式启动。** 未审计前不得以任何模式运行。
5. **100x 通道永久禁用**。microstructure_100x 在 blocked list 中。
6. **accounts.json 非空时 healthcheck 必须 fail**，除非 explicit_live_enable=true 且所有 live gate 通过。
7. **dirty worktree (modified + untracked > 0) 时所有 evidence report 标记 dirty，所有 promotion gate 自动 fail。**
8. **50x/75x/99x 杠杆与 100x 同等对待：在 research_only_blocked 状态下禁止任何 >1x 杠杆。**

---

## 3. 恢复阶段

### P0 — 安全隔离 + 证据层恢复（目标: 不可回退的安全基线）

**P0 不是"装工具、清锁、重启服务"。** 进程已经在跑。P0 的目标是建立不可回退的执行安全基线：accounts.json 空文件不能是唯一隔离、lock 不能永久死锁、dirty worktree 不能无告警。

#### P0-1: 修复 PATH 不一致（非全局安装）

**问题**: 交互 shell、launchd 环境、repo-local node_modules/.bin/tsx 三者的 PATH 不一致。

**动作**:
```bash
launchctl getenv PATH
/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice/node_modules/.bin/tsx --version
```
如果 launchd PATH 缺少 Homebrew，在 launchd plist 中添加:
```
<key>EnvironmentVariables</key>
<dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
```
不做全局 `npm install -g corepack`。

**验收**: `launchctl getenv PATH` 包含 Homebrew 路径。

#### P0-2: 清理死锁 + 添加强制释放

**动作**:
```bash
# 先检查 PID 存活状态
kill -0 90153 2>/dev/null || rm -rf data/runtime/locks/realtime_shadow_monitor.lock
# 清理已确认的死锁
rm -rf data/runtime/locks/paper_policy_shadow_settle.lock
```

**代码改动**: 锁管理工具中添加 age > 2 expected_runtime 的强制释放逻辑（必须同时检查 PID 存活状态）。

**验收**: `system_status_reason_chain` 刷新后不再出现 lock exists 类 blocker。所有锁的 age < 2 expected_runtime。

#### P0-3: 同步刷新所有关键 Artifact

**验收标准（P0 完成）**:
1. system_status_reason_chain.generatedAt < 1h
2. reason-chain 中无 stale/hash mismatch blocker
3. 所有关键 artifact 的 generatedAt 在同一 4h 窗口内
4. strategy_promotion 中无 promotion-critical dirty 导致的 quarantine
5. runtime locks 中无 age > 2 expected_runtime 的 lock
6. `pnpm healthcheck:p0` 退出码 = 0

#### P0-4: AI 自优化写入审计（P0 必须同步完成）

**在审计完成前，AI 自优化循环不得以任何模式启动。**

#### P0-CR1: 实时交易硬隔离（最高优先级）

**代码审查引用**: CR-1（accounts.json 空文件是唯一隔离层）、CR-10（Zod schema 无交叉验证）

**问题**: `data/config/accounts.json` 为空 `[]` 是唯一阻止实时交易的隔离层。一旦填入账户即可触发生产 API 连接。Zod schema 无交叉验证。

**要求**: 在 P0 完成前实现代码级、配置级、运行时三级隔离：
1. **默认 force paper_only = true** — 任何没有 explicit_live_enable 标记的账户一律 paper_only
2. **sandbox=false 时禁止加载任何 trading account**
3. **demoTrading=true 不得与 production endpoint / production credential 同时存在**
4. **Zod schema 必须校验 sandbox/demoTrading/account permission 的交叉一致性** — 通过 z.refine() 实现
5. **liveTradingAllowed=false 时所有 order submit path 必须 hard fail**
6. **close/reduce/order submit 统一进入同一个 execution guard**
7. **accounts.json 非空时 healthcheck 必须失败**，除非 explicit_live_enable=true 且所有 live gate 通过

**验收**:
- sandbox=false,demoTrading=false 的账户 → 启动时 Zod 拒绝
- 有效 demoTrading 账户 → paperTradingAllowed 仍为 false（系统级隔离）
- 所有 order submit 路径通过同一个 execution guard

#### P0-CR3: Stale Lock 自动释放与审计

**代码审查引用**: CR-3（死锁永不自动释放）

**问题**: `scripts/openalice_cron_lock.sh` 的 mkdir 原子锁检测到 stale 后只发通知不移除目录。若进程被 SIGKILL 完锁永久存在。

**要求**:
1. lock 文件必须记录 pid、hostname、created_at、command_hash
2. 若 pid 不存在且 lock age > max_runtime 2，允许自动释放
3. 自动释放前写入 `stale_lock_audit.jsonl`
4. 自动释放后触发一次 healthcheck
5. 若同一任务 24h 内出现 >=2 次 stale lock，升级为 P0 failure
6. 先 atomic rename 到 quarantine/ 再删除（防止竞态条件）

**验收**: `openalice_cron_lock.sh` 中检测到 stale 时自动重试获取；`stale_lock_audit.jsonl` 存在。

#### P0-CR8: Dirty Worktree Quarantine 传播到 Evidence Chain

**代码审查引用**: CR-8（dirty worktree 不传播到 evidence chain）、CR-9（effectiveActionability 缺失 warmup 检查）

**问题**: 当前 `modified=55, untracked=187`，但 dirty worktree audit 未被 buildSystemStatusReasonChainReport 的 Allocator reason 消费。dirty quarantine 只在 promotion bundle 层执行，不在 reason chain 层。

**要求**:
1. `buildSystemStatusReasonChainReport` 将 dirtyWorktreeAudit 传入 `buildAllocatorReason`
2. dirty worktree 状态下所有 evidence report 标记 dirty
3. dirty worktree 状态下所有 promotion gate 自动 fail
4. 禁止 paper execution
5. 禁止 allocator 读取该状态作为有效证据
6. 必须生成 git diff --stat、git diff --name-only、untracked manifest
7. 必须先 commit / stash / archive / delete 后再进入 healthcheck

**验收**: dirty worktree 状态下 effectiveActionability 至少为 research_only_blocked；reason chain 中存在 dirty worktree 组件。

#### P0-CR10: Kill Switch 强制启用

**问题**: risk.json 中 killSwitch=false, kill-switch.json 中 defaultPolicy=block_new_only。

**要求**:
1. kill switch 默认启用且不可在 research_only_blocked 状态下关闭
2. defaultPolicy 改为 `block_all`（含强制平仓路径）
3. kill switch 状态接入 system_status_reason_chain
4. healthcheck 在 kill switch disabled 时 fail

---

### P1 — 证据覆盖闭环（Zero-Order Capture Loop）

**不是"止血优化"。** 不调参、不切换路由、不提高置信度门槛、不修策略公式。目标是证明每笔候选信号有完整 context/cost/route/decision hash/settlement/MFE/MAE。

#### P1 范围

```
资产:   全部 13 个 fresh 资产
杠杆:   1x only
执行:   shadow only（不产生 paper order，只记录信号+context+cost）
AI:     read-only / suggestion-only（审计通过后）
路由:   不切换。先记录每条信号的 route intent，不做执行。
```

#### P1 验收标准

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| context coverage | 0% | >=95% |
| cost evidence coverage | 0.21% (2/947) | >=95% |
| MFE/MAE coverage | 1.06% (10/947) | >=95% |
| expected gross/net edge 记录率 | 0% | >=95% |
| paper_pnl_diagnostics 每日刷新 | stale | 连续 7 天 fresh |

**在达到 95% 捕获覆盖之前:**
- 不允许讨论切换 passive_passive
- 不允许讨论提高 confidence 门槛
- 不允许讨论 ATR 止损
- 不允许讨论修改信号公式
- 不允许讨论删除币种

#### P1-RouteCost Gate

**代码审查引用**: 0.21% cost evidence coverage 不可支撑 route 讨论

**问题**: 947 笔里只有 2 笔有预测成本证据。当前 routeCostBudget 只能作为 cost design budget，不是 realized execution evidence。

**要求**: 在 predicted cost evidence coverage < 95% 前：
1. 禁止比较 route performance
2. 禁止声称 passive_passive 优于 taker_taker
3. 禁止使用 18/24/26/27 bps 作为 promotion evidence
4. 所有 route cost 只能标记为 design budget，不得标记为 realized evidence
5. route 相关参数修改必须登记为 trial

#### P1-MFE/MAE Gate

**代码审查引用**: 1.06% MFE/MAE coverage 不可支撑止损讨论

**问题**: 947 笔中仅 10 笔有 MFE/MAE 路径证据。当前的 pathDiagnostics（read-only OHLC reconstruction）不可替代 decision-time ledger evidence。

**要求**: 在 MFE/MAE ledger coverage < 95% 前：
1. 禁止修改 stop-loss policy
2. 禁止上线 ATR stop
3. 禁止声称固定止损误触
4. 禁止用 pathDiagnostics 替代 decision-time ledger evidence
5. pathDiagnostics 只能作为只读重建诊断，不得作为 promotion-grade evidence

#### P1-CR4: 账户文件损坏 fail-closed

**代码审查引用**: CR-4（JSON 解析失败静默回退 equity=100k）

**问题**: `paper_trade_microstructure_stress.ts:307-316` 和 `paper_trade_volume_breakout.ts:384-397` 中 catch 块静默重置 equity=100k，所有历史丢失。

**要求**: 任何账户状态文件出现以下情况，系统必须立即 fail closed：
- JSON parse failed, schema invalid, checksum mismatch, equity missing, position missing

**禁止行为**：
1. 禁止静默创建新账户
2. 禁止默认 equity=100000
3. 禁止继续生成 PnL 报告
4. 禁止继续 paper execution

**要求**：
1. 损坏文件自动复制到 quarantine/ 下备份
2. 写入 `account_corruption_incident.jsonl`
3. 需要人工确认或恢复最近 valid snapshot
4. PnL ledger 标记为 `invalid_since_corruption_ts`

#### P1-CR11: No-op Process Gate

**代码审查引用**: CR-11（5 个 SKIP flags 全 true，空转 no-op）

**问题**: Paper-monitor 有 5 个 SKIP flags 全部为 true，进程运行但不做任何事，制造"系统正常"假象。

**要求**: 任何 monitor / collector / executor 如果关键 SKIP flags 全 true：
1. 状态不得标记为 `running_ok`
2. 必须标记为 `no_op`
3. healthcheck 必须 warning 或 fail
4. report 中必须显示 effective work count

#### P1 持续周期

**最少 7 天连续运行**，所有捕获指标 >=95%。如果 7 天后未达标，继续 P1，不得进入 P2。

---

### P2 — Alpha 证伪（冻结 Trial Universe + 统计协议）

**前置条件**: P1 捕获闭环达标（context/cost/MFE/MAE 覆盖率 >=95%），且有 >=100 笔完整捕获的 closed trades。

#### P2-1: 冻结 Trial Universe

#### P2-2: 统计验证（含完整计算定义）

**WFO**: train=30d, test=7d, step=5d, maximum folds=5, pass=median OOS PF > 1.05

**PBO**: method=CSCV, partitions=8, pass=PBO < 0.2

**DSR**: pass probability > 95%

**FDR**: method=BY-FDR (Benjamini-Yekutieli), BH as auxiliary only, pass q-value < 0.10

**Promotion hard block**: 只要存在以下任一状态，所有策略保持 quarantined：
1. WFO failed
2. PBO indeterminate
3. DSR missing
4. FDR missing
5. trial ledger missing
6. complete trial universe missing

#### P2-3: Trial Ledger 修复

**要求**:
1. 不能从不完整、未冻结、PIT 不明的 trial 事后合成 promotion-grade p-value。不可重建的 trial 应标记为 `not_reconstructable` / `quarantined`。
2. 每一次人工或自动修改都必须登记为 trial，包括改 confidence threshold、stop-loss、route、universe、funding weight、holding window、spread filter、leverage cap、allocator 参数。

#### P2-CR5: Leverage Policy

**代码审查引用**: CR-5（仅阻止 >=100x）

**问题**: production-leverage-guard.ts 中 FORBIDDEN_PRODUCTION_LEVERAGE=100，50x/75x/99x 均通过。

**要求**:
1. research_only_blocked 状态下所有 leverage > 1x 禁止
2. paper-light 阶段只允许 1x
3. leverage > 3x 只能在 offline stress simulation 中存在
4. leverage >= 10x 永久不得进入 live
5. leverage guard 改为可配置阈值（默认 1x 或 3x）
6. 覆盖所有杠杆设置路径（订单级 + 账户级）

---

### P3 — 策略改造（仅基于 P2 失败模式）

**前置条件**: P2 统计验证通过。

**禁止**: 从"看起来合理"的交易直觉出发做策略改造。

---

## 9. 推荐策略线与砍策略清单

> 本节不是 P0/P1/P2 的前置条件。P0/P1/P2 完成前所有策略线禁止交易（paperTradingAllowed=false）。本节描述的是**一旦证据链恢复后**，当前代码审查结论指向的三条可行方向。

### 9.1 当前 snapshot 对策略方向的约束

开工前先看数字：

| 约束 | 当前值 | 影响 |
|------|--------|------|
| freshAssets | 12 | 不足支撑 20+ 币横截面 |
| cost evidence coverage | 0.21% | 高频策略的成本讨论不可靠 |
| MFE/MAE coverage | 1.06% | stop-loss/take-profit 讨论不可靠 |
| paperTradingAllowed | false | 所有策略当前只能 observation-only |
| cross-sectional 因子 | 15/15 factor x symbol 对 decayed | 旧 cross_sectional 信号不可用 |
| 旧的 microstructure_100x | blocked + 无 L2 | 永久禁用 |
| 旧的 volume_breakout | 5m 高频 + cost coverage 0.21% | P1 覆盖达标前不可恢复 |

### 9.2 三条推荐策略线

> 按优先级排序。**任何策略线在 paperTradingAllowed=false 解除前都只能 observation-only。**

#### 策略 A：ETH/BTC Funding + Basis Carry（优先级最高）

**赚钱逻辑**: 永续合约资金费率是多空之间的实际现金流。当永续持仓过度拥挤时（多头过多→正 funding），空永续/多现货可收取 funding 收益。

**经济解释级别**: **有**。非技术指标提取，是交易所合约机制可观测现金流。

**仅 observation-only，不交易**。每 8h 记录 funding/basis，每天生成 `carry_opportunity_report`。

**计划（P1 覆盖达标后 paper-light）**:

Entry 条件:
- funding_rate_8h > 0.03%
- funding_rate_zscore_30d > 2.0
- basis_bps > 10
- spread_bps < 5
- orderbook_depth_10bps 覆盖下单额 20x
- realized_vol_24h 不处于最高 20% 分位

Exit 条件:
- funding_rate_8h < 0.01%
- basis_bps < 3
- funding_zscore < 0.5
- realized_vol_1h 出现 30d 90% 分位异常

**约束**:
- 只做 ETH、BTC（不做小币）
- 1x 杠杆
- capital 100-300 USDT 上限（进入 paper-light 时）
- max daily loss 0.5%
- **理论年化 32.85%**（未扣 cost 和 basis change，真实净收益须后处理）

**kill 条件**: 60 天 observation-only 模拟 net Sharpe < 0.5 → 停止此方向。

#### 策略 B：高流动性币种横截面 Rank Factor（次优先）

**赚钱逻辑**: 不预测单一币种涨跌，而是预测"未来 24h 谁相对更强"。每 24h 轮动，做多 top N。

**为什么比 5m breakout 更适合**:
- 交易频率低 → 成本占比小 → 统计验证更容易
- 不需要毫秒级执行
- 24h 周期 = 24h 收集一次完整 decision context + MFE/MAE + settlement

**当前约束**: 可用币数不足。freshAssets=12，实际准入要求超过 20 币。**cross-sectional rank factor 的 observation-only 起步条件是 freshAssets >= 20。**

**第一版假设公式**（非结论，是第一版待验证模型）:
```
score = 0.35 * z(mom_24h) + 0.25 * z(mom_7d) + 0.15 * z(mom_4h)
        - 0.15 * z(realized_vol_24h) - 0.10 * z(spread_bps)
        + 0.10 * z(depth_10bps) - 0.10 * z(positive_funding_zscore)
```

Universe: >=20 币，准入要求 daily_volume_usd > 100M, spread_bps < 10, depth_10bps 充足。

**仅 observation-only**，每天生成一次 rank_report，计算 Rank IC，不产生订单。

**通过条件（可进入 paper-light）**:
- Rank IC 30 日滚动均值 > 0.03
- Top 3 组合成本后收益 > BTC benchmark
- 最大回撤 < BTC 回撤的 70%
- 换手后手续费不吃掉 50% 以上毛收益
- OOS 60 天仍有效

**kill 条件**: 跑不赢 BTC benchmark → 停止。

#### 策略 C：No-Trade Risk Filter（最高优先级上线）

**赚钱逻辑**: 不直接创造收益，但减少在错误时间交易的亏损。验收标准不是"赚钱"，而是可量化的亏损减少。

**这是唯一不需要证明 alpha 就能上线的方向。** 可用历史数据回放验证。

**禁交易条件**:

| 类别 | 条件 | 来源 |
|------|------|------|
| 市场级 | BTC 1h return < -3% 或 BTC 4h return < -6% | market data |
| 市场级 | BTC realized_vol_1h > 30d 95% 分位 | OHLCV |
| 流动性 | spread_bps > 10 或 depth_10bps 不足 | orderbook |
| 数据 | data freshness > 2min 或 context_status != ok | runtime |
| 宏观 | FOMC ±2h, CPI ±1h, 交易所异常公告 | 单独维护的 event calendar |

**验证指标（可回放测量）**:
- 过滤后 drawdown 下降
- 过滤后 avg loss 下降
- 过滤后 bad trade cluster 减少（同方向连续亏损笔数）

### 9.3 必须砍掉的策略线

| 策略 | 原因 | 砍法 |
|------|------|------|
| microstructure_100x | 无 L2、无 spread、无 fill 模型、100x 杠杆 30s 持仓 | **永久砍** |
| 5m volume_breakout | cost evidence 0.21%、MFE/MAE 1.06%，高频条件不满足 | **P1 覆盖达标前禁止恢复** |
| AI 自动优化策略 | cron_continuous_improvement 已失败 500+ 次 | **砍成 suggestion-only**（可生成假设/报告/patch diff，不可自动改参数/开策略/加杠杆） |

### 9.4 Observation-only → Paper-light 过渡路线图

```
P0 完成 → P1 Observation-only（所有策略线）
  ├─ 策略 C: No-Trade Risk Filter（立即，用历史数据回放验证）
  ├─ 策略 A: 每天生成 carry_opportunity_report（不进 order）
  │   └─ 每 8h 记录 funding/basis, 每 24h 计算模拟收益
  └─ 策略 B: 每天生成 rank_report + Rank IC（不进 order，等 freshAssets >= 20）
P1 达成 95% 覆盖 → P1.5 策略选择
  └─ 哪条策略的 data evidence 先达标 → 先进入 paper-light
P2 → 证伪
  └─ 未通过 P2 统计验证的策略 → kill
```

### 9.5 最终判断

你当前完成度 49%，不是缺"更聪明的策略"。缺的是：
1. 安全门锁好（P0 accounts.json 隔离、lock、dirty quarantine）
2. 证据覆盖填平（P1 cost/MFE/MAE >=95%）
3. 一个有经济解释、低频、成本后能活、60 天 observation 后仍有效且通过 WFO/PBO/DSR/FDR 的策略线

以上三条策略线中，只有同时满足这三条的才能从 observation-only 进入 paper-light。在那之前，运行 generate_snapshot.sh，看数字说话。

---

## 附录 A: 代码审查发现 — 硬门控映射表

### Critical（4）

| ID | 文件:行 | 问题 | 映射任务 |
|----|---------|------|----------|
| CR-1 | `data/config/accounts.json` | accounts.json 为空是唯一实时交易隔离 | P0-CR1 |
| CR-2 | `allocator.ts:553-562` | BL 协方差矩阵为对角线近似，BL 模型被破坏 | P2 待修复 |
| CR-3 | `openalice_cron_lock.sh:37-51` | 死锁永不自动释放 | P0-CR3 |
| CR-4 | `microstructure_stress.ts:307 + volume_breakout.ts:384` | 账户文件损坏静默重置 equity=100k | P1-CR4 |

### High（6）

| ID | 文件:行 | 问题 | 映射任务 |
|----|---------|------|----------|
| CR-5 | `production-leverage-guard.ts:3-9` | 仅阻挡 >=100x | P2-CR5 |
| CR-6 | `execution.ts:84-102` | reduce/close 绕过所有仓位调整门控 | P2 待修复 |
| CR-7 | `cross-sectional-momentum.ts:154` | 资金费率 3x 魔法数字 | P2 待修复 |
| CR-8 | `build_system_status_reason_chain.ts:403` | Dirty worktree 不传播到 evidence chain | P0-CR8 |
| CR-9 | `build_system_status_reason_chain.ts:431-435` | effectiveActionability 缺失 warmup 检查 | P0-CR8 |
| CR-10 | `config.ts:275-286 + 441-449` | Zod 无 sandbox/demoTrading 交叉验证 | P0-CR1 |

### Medium（8）

| ID | 文件:行 | 问题 | 映射任务 |
|----|---------|------|----------|
| CR-11 | `launch_realtime_shadow_monitor.sh:37-41` | 5 SKIP flags 全 true，空转 no-op | P1-CR11 |
| CR-12 | `paper_open_context.ts:89` | featuresAvailable == 非 stale | P1 待修复 |
| CR-13 | `paper_open_context.ts:93` | flashContextStatus 完全重复 | P1 待修复 |
| CR-14 | `evidence_manifest.ts:58-62` | exit code !=0 掩盖 dirty | P0-CR8 |
| CR-15 | `paper_open_context.ts:102-131` | risk_reduced 被忽略 | P1 待修复 |
| CR-16 | `volume-breakout.ts:21 vs 52` | stopLoss 文档 0.5% 实际 3.0% | P2 待修复 |
| CR-17 | `paper_trade_*.ts` | 无路由选择逻辑 | P1 待修复 |
| CR-18 | 多个 cron .sh | 硬编码 node_modules/.bin/tsx | P0 待修复 |
