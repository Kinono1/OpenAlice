# ⚠️ 存档 — 不作为执行依据 ⚠️

**此文件包含旧版计划的历史版本（v1a、v1b），其中含有已被纠正的错误和危险命令。**

## 已知残留的危险内容
- `npm install -g corepack`（已证明 PATH 不一致才是问题）
- `rm -rf data/runtime/locks/*.lock/`（锁是目录，应有进程检查的清理逻辑）
- "切换所有策略路由为 passive_passive"（未验证 fill rate/adverse selection）
- "可以考虑小资金实盘"（违反 paperTradingAllowed=false 安全约束）
- "使用 production API key 但 demoTrading=false 风险自负"（危险建议）
- 所有 JSON 行号引用在此文件中不可用

**不要将本文件中的任何命令、建议或数字直接用于执行。** 
如需了解最新计划，请阅读 `OpenAlice_recovery_backlog_v5.md`。

---

来源: `/Users/kino/Downloads/chrome/OpenAlice_全面诊断与恢复计划_2026-05-08.md` lines 997-3102

---


---

# 历史版本存档

> 以下为本次计划从 v1 到 v3 的完整演进过程。保留此文仅为追溯推理链，**不作为执行依据**。执行只参考正文 v4（Artifact-Bound Execution Backlog）。

---


## 历史版本 v1b: 系统恢复与 Alpha 证伪计划（原始版）

> 以下为 2026-05-08 原始 Alpha 证伪计划。其中 shadow PnL 口径已纠正、taker_taker=43 bps 已被 artifact 纠正为 26 bps、数据覆盖 5/34 已被纠正为 13/13/13。该版本首次引入了三套账本分离、alpha 证伪流程、kill criteria 和 passive_passive 证伪分析。保留此文仅为追溯推理过程。

# OpenAlice 系统恢复与 Alpha 证伪计划

**日期**: 2026-05-08
**项目**: OpenAlice v0.9.0-beta.8
**原始诊断标题**: OpenAlice 盈利诊断报告（深度版）
**修正说明**: 原报告将系统修复、策略优化与盈利恢复混为一谈，并将影子交易 PnL 直接等同于系统亏损。本版本严格区分 shadow / paper / actual 三套账本口径，移除未经验证的前瞻性假设，补充 alpha 证伪流程与 kill criteria。**当前系统不处于可讨论盈利的状态，而是处于需要先验证 alpha 是否存在的阶段。**

---

## 核心风险声明（必读）

当前 OpenAlice 最大风险不是某个策略参数错误，而是系统尚未处于可验证状态：

1. **Shadow PnL、paper PnL 与 actual account equity 口径混杂**，无法得出统一的盈亏结论。
2. **交易上下文覆盖率为 0%**、成本覆盖率约 0.21%、MFE/MAE 覆盖率为 1.06%，三者的严重不足意味着任何关于"降成本后扭亏""提高置信度后改善""删除亏损币种后盈利"的判断，都只能视为**待验证假设**，不能作为恢复交易或 promotion 的依据。
3. **系统 alpha 尚未被证明存在**。当前所见的亏损归因（成本太高、止损太紧、流动性不足）只是亏损的解释，不等于修复后就能盈利。
4. 在 context coverage、cost coverage、ledger integrity、route execution quality、WFO/PBO/DSR/FDR 验证全部恢复前，系统只能进入 shadow / paper / replay 模式，**禁止 live trading**。

---

## 一、总体盈亏概况（严格分账本口径）

### 1.1 核心发现：三套账本，三个结论

当前系统存在三套**口径不同、不可直接混用**的账本：

| 账本 | 含义 | 能否作为真实盈利证据 | 当前状态 |
|------|------|---------------------|----------|
| **Shadow / 反事实交易** | 系统假设会做的交易（含所有杠杆倍数叠加复记） | **不能** — 未经过实际执行验证 | 947 笔，-26.81% |
| **Paper execution** | 模拟执行交易（经过门控过滤） | **部分可以** — 但样本量极小 | 24 笔 |
| **Actual account equity** | 实际账户权益变动 | **最接近真实** — 但账户配置为空 | 合计 +0.02%（几乎持平） |

**关键事实**：

- **-26.81% 亏损主要来自 shadow / counterfactual ledger，不应直接等同于真实账户亏损。**
- **真实四账户合计权益 +0.02%**（$400,000 → $400,083.49），说明风控门控确实阻断了大量低质量信号。
- **但这也意味着系统无法形成有效交易闭环** — 门控阻塞了几乎所有执行，系统处于"既不赚钱也不亏钱，但什么也做不了"的状态。

> 当前无法回答一个最基本的问题：**系统到底是在真实执行中亏损，还是在影子信号中亏损？** 如果 -26.81% 主要来自影子交易，而真实账户 +0.02%，那结论应该是"策略候选很差，但风控门控挡住了大部分垃圾信号"，而不是"系统全面亏损"。

### 1.2 四个账户权益曲线（实际口径）

| 账户 | 初始权益 | 当前权益 | 总回报 | 状态 |
|------|----------|----------|--------|------|
| spot_1x | $100,000 | $99,856.26 | **-0.14%** | 已全部平仓 |
| conservative_3x | $100,000 | $99,797.31 | **-0.20%** | 已全部平仓 |
| stress_10x | $100,000 | $100,679.92 | **+0.68%** | 唯一盈利账户 |
| liquidation_probe_100x | $100,000 | $99,750.00 | **-0.25%** | 仍有未平仓 |
| **合计** | **$400,000** | **$400,083.49** | **+0.02%** | 几乎持平 |

### 1.3 宏观指标（shadow 口径，仅供参考）

| 指标 | 数值 | 说明 |
|------|------|------|
| 累计已平仓交易 | 947 笔（含影子） | 包含所有杠杆倍数的反事实记录，不可直接解读 |
| 实际执行交易 | 24 笔 | 经过门控过滤后的真实执行 |
| Shadow 统计盈亏 (PnL%) | **-26.81%** | 非实际账户亏损 |
| Shadow 平均单笔盈亏 | -0.028% | 微亏累积 |
| Shadow 胜率 (Win Rate) | 37.57% | 低于随机（shadow 口径） |
| Shadow 盈亏比 (Profit Factor) | **0.71** | < 1.0，净亏损（shadow 口径） |
| Shadow 最大连续亏损 | **14 笔** | 风控失效（需确认是否跨账本） |
| Shadow 盈利:亏损:持平 | 357 : 461 : 129 | 亏多赢少 |

## 二、PnL 口径混用问题（核心缺陷）

### 2.1 当前无法准确回答的问题

| 问题 | 现状 | 严重程度 |
|------|------|----------|
| 系统在 paper execution 中是否盈利？ | 只有 24 笔，样本不足 | **高** |
| Shadow PnL 有多少来自真实可执行信号？ | 无实际路由验证 | **高** |
| 影子交易中多账户叠加复记了多少 PnL？ | 未分离 | **高** |
| 实际账户 +0.02% 是否可重复？ | 系统无法运行，无法验证 | **高** |
| 风控拦截的"垃圾信号"有多少是真正垃圾？ | 无法判断 | **中** |

### 2.2 必须补充的交易级记录字段

每笔交易必须记录以下字段，否则所有 PnL 分析均为混账：

```
ledger_type: shadow / paper / real
signal_id
decision_time
context_hash
route
expected_gross_edge
expected_cost
expected_net_edge
fill_price
exit_price
fee
slippage
funding
net_pnl
```

**当前覆盖率**:
- 成本记录: 0.21% (2/947)
- 预期毛/净收益: 0% (0/947)
- MFE/MAE 路径: 1.06% (10/947)
- V3 上下文快照: 0% (0/947)

**达标条件**: 上述字段覆盖率均 ≥ 95% 后，PnL 分析才可视为可信。

---

## 三、策略逻辑拆解（含严格证据等级标注）

> ⚠️ 以下分析中的"亏损原因"均为**事后归因**。在没有样本外验证和完整成本证据前，这些解释不能直接作为修复方向的依据。

### 3.1 横截面反转 (cross_sectional) — 最大 shadow 亏损源

**证据等级**: 低级（shadow 口径，上下文 0%，成本证据 0%）

**Shadow 战绩**: 24 笔真实交易，胜率 41.7%，shadow 口径总亏损 -3.76%，盈亏比 0.892

**信号公式**（来自 `src/domain/strategy/cross-sectional-momentum.ts`）:
```
riskAdjustedScore = primaryReturn/σ × (1-mtfWeight) + secondaryReturn/σ × mtfWeight + fundingAdjust
fundingAdjust = -clamp(fundingRate/0.05, -1, 1) × 0.25 × 3
```

**已知缺陷与证据状态**:

| 缺陷 | 详情 | 证据等级 | 是否可验证 |
|------|------|----------|-----------|
| 融资率调整含硬编码魔法数字 | `× 0.25 × 3` 无理论依据、无参数搜索 | **零** — 无法回答为什么除 0.05、乘 0.25、再乘 3 | 否 |
| 最小离散度 5% 门槛过低 | 许多时段离散度不足，强制交易 | **低** — 仅 shadow 回看 | 需样本外验证 |
| 初始版本无流动性过滤 | `minDailyVolumeUsd` 存在但 `dailyVolumeUsd` 字段未填充 | **可验证** — 字段已存在，需要数据填充 | 是 |
| 48 小时固定到期退出 | 93.5% 以 `holding_expired` 结束 | **低** — 仅统计描述，无止盈逻辑 | 需 MFE/MAE |
| 等权排名 | 小币种波动大，主导排名两端 | **中** — 合理性质疑，但无量化证据 | 需量化分析 |

**ORDI-USDT 悖论（shadow 口径）**: ORDI shadow 胜率 72.7%，但总 PnL -11.11%。盈利交易每笔赚极少，亏损交易（-7.60%）一笔抹去 12 笔盈利。这是 shadow 账本中的统计模式，不代表真实执行也会复现。

### 3.2 成交量突破 (volume_breakout) — 成本与时间尺度双重问题

**证据等级**: 低级（shadow 口径，样本量不足）

**Shadow 战绩**: 1x/3x 各 106 笔，胜率 46.2%，各亏损 -2.21%，盈亏比 0.841

**信号公式**（来自 `src/domain/strategy/volume-breakout.ts`）:
```
volumeRatio = currentVolume / medianVolume(24 bars)
rangeBreakout = close > max(high[-12:-1])  (做多)
confidence = volumeRatio × breakQuality × rangeBreakoutPct 的复合函数
```

**已知缺陷**:

| 缺陷 | 详情 | 严重程度 |
|------|------|----------|
| 5 分钟 K 线中位数成交量仅 24 bar（2 小时历史） | 样本量过小 | 高 |
| `breakQuality` 只看单根 K 线收盘位置 | 忽略跳空、影线突破 | 中 |
| 3% 固定止损对 3 倍杠杆太紧 | BTC 日均波动 ~2-3%，正常波动即可触发 | 高 |
| 持仓仅 6 根 bar（30 分钟） | 不足以让突破趋势充分发展 | 高 |
| taker_taker 路由成本 43 bps | 即使信号正确，扣费后净收益为负 | 高 |

**更深层问题 — 时间尺度可能错误**:

5 分钟 breakout 信号的中位数预期毛收益约 30-40 bps，而实际总成本 20-43 bps。**当 median expected move < 3 × total execution cost 时，该策略天然很难赚钱。**

> 建议硬门槛：只有当 median expected move > 3 × total execution cost 时，volume_breakout 才允许交易。否则直接禁止。

**一条典型 shadow 交易路径**（来自影子账本采样 — 注意此为反事实，不保证在真实执行中复现）:
```
BTC-USDT, volume_breakout_1x, 做空 @ $81,088
  预期毛收益: +0.31%
  路由成本:     -0.43% (taker_taker)
  预期净收益:   -0.12%  ← 开仓前就已注定亏损
  置信度:       0.012   ← 远低于 0.2 门槛
  突破幅度:     0.53%   ← 低于 1% 最低要求
  结果: 被门控拦截（但拦截不等于信号有效）
```

### 3.3 微观结构压力 (microstructure) — 100x 通道应永久禁用

**证据等级**: 极低（缺乏 L2 order book、spread、latency、fill model 等基本条件）

**Shadow 战绩**: stress_10x 301 笔（胜率 36.5%, -0.99%），liquidation_probe_100x 378 笔（胜率 34.1%, -2.06%）

**配置对比**:

| 参数 | stress_10x | liquidation_probe_100x |
|------|-----------|----------------------|
| 杠杆 | 10x | 100x |
| 最大持仓 | 120 秒 | 30 秒 |
| 止损 | 0.25% | 0.08% |
| 止盈 | 0.35% | 0.12% |
| 保证金比例 | 1% | 0.5%（估算） |

**100x 通道永久禁用建议**:

microstructure_100x 当前缺少以下**最基本执行条件**:

| 必需条件 | 当前状态 |
|----------|----------|
| L2 order book 深度 | **缺失** |
| bid-ask spread 实测 | **unknown** |
| latency measurement | **缺失** |
| fill simulator | **缺失** |
| queue position model | **缺失** |
| liquidation / margin model | **不完整** |
| funding / fee / slippage 实测 | **不完整** |

> **结论**: 100x 通道永久禁用，不进入 paper promotion，不进入 live，不参与收益统计。除非系统具备真实 L2 order book、延迟测量、成交队列模型、逆向选择分析和强制爆仓模拟，否则该通道只保留为离线研究样本。

---

## 四、交易成本分析（含关键证伪）

### 4.1 四条路由的成本拆解

| 路由 | 手续费 | 价差 | 滑点 | 逆向选择 | 队列损失 | 资金费率 | **总成本** | 预算 | 状态 |
|------|--------|------|------|----------|----------|----------|------------|------|------|
| passive_passive | 4 | 2 | 4 | 5 | 3 | 0 | **18 bps** | 20 | 通过 |
| passive_taker | 7 | 4 | 8 | 3 | 2 | 0 | **24 bps** | 20 | 超支 |
| taker_taker | 10 | 8 | 12 | 6 | 4 | 3 | **43 bps** | 20 | 严重超支 |
| twap | 7 | 6 | 7 | 4 | 3 | 0 | **27 bps** | 20 | 超支 |

### 4.2 "passive_passive 降成本后扭亏" — 该假设需要证伪

原报告提出：taker_taker 成本 43 bps → passive_passive 成本 18 bps，因此大部分信号可能扭亏。

**这个结论很危险。** Maker 成本低，不代表 maker 执行质量好。

**passive_passive 至少有四个隐藏成本**:

| 隐藏问题 | 解释 |
|----------|------|
| **不成交风险** | 信号出现后挂单未成交，错过行情 |
| **逆向选择** | 只有价格反向扫到挂单时才成交，相当于被动接刀 |
| **队列损失** | 排队靠后，理论上挂了单，实际吃不到好成交 |
| **Missed alpha** | 信号窗口很短，等成交时 alpha 已经衰减 |

学术研究指出，maker-taker 费用结构会影响订单类型选择、路由决策、bid-ask spread、fill rate、price impact 和 adverse selection（来源: Battalio et al., "Market Maker Competition and the Cost of Trading", 2016），而不是简单地"maker 更便宜所以更好"。

> **修正结论**: 切换 passive_passive **只能降低显性交易成本**，但必须额外验证以下指标。否则 18 bps 只是账面成本，不是真实执行成本。

**必须补充的验证指标**:
```
fill_rate
time_to_fill
post_fill_30s_return
post_fill_5m_return
missed_opportunity_return
realized_spread
effective_spread
adverse_selection_bps
```

如果 passive 订单只在行情反向时成交，那它不是省钱，而是更优雅地亏钱。

---

## 五、基础设施全面瘫痪分析

### 5.1 故障层级与死亡螺旋

整个系统存在三层阻断：

```
第 1 层 (环境): corepack/tsx 未安装
      ↓
第 2 层 (进程): 8 个 cron/launchd 任务全部失败
      ↓
第 3 层 (业务): 锁文件死锁 → 门控过期 → 证据链断裂 → 全通道封锁
```

### 5.2 所有失败进程清单

（同原报告，此处省略重复——参见附录）

### 5.3 锁文件死锁

`paper_policy_shadow_settle` 锁目录自 2026-05-05 起未更新（>3 天）。`cron_refresh_market_intel_context` 和 `cron_prospective_evidence_tick` 的锁于 2026-05-08 14:09 被触及（可能已恢复或由其他进程清理）。

---

## 六、风控门控全貌

### 6.1 12 项必检清单（6/12 通过）

同原报告（此处省略重复）。

### 6.2 发布门控 (Release Gate) — 五项全败

同原报告。关键纠正：**在 WFO / PBO / DSR / FDR 统计验证恢复前，所有策略不得进入 paper promotion，更不得进入 live。** 当前阶段只能进行 replay、shadow、离线回测和受控 paper simulation。

---

## 七、Alpha 证伪流程（新增核心章节）

### 7.1 当前核心问题：策略 alpha 没有被证明

原报告花大量篇幅解释"为什么亏"，但没有充分证明"哪里有可保留的 alpha"。

当前修复路线默认假设：**策略本身可能有 edge，只是成本、止损、数据、执行出了问题。**

但这没有被证明。真实情况可能是：**策略本身没有 alpha。**

如果策略本身没有 alpha，那么：
1. 降低成本只能减少亏损
2. ATR 止损只能改变亏损路径
3. 提高 confidence 只能减少交易频率
4. 删除亏损币种只是过拟合
5. 修复基础设施只是让系统更稳定地证明自己不赚钱

### 7.2 策略 Alpha 四步证伪流程

每个策略必须通过以下四关，任意一关失败则策略**不通过**：

| 关卡 | 检查项 | 标准 | 结论 |
|------|--------|------|------|
| 1 | Gross edge > 0? | Gross PF > 1.05 | **Gross PF < 1.05 → 直接 kill** |
| 2 | Gross edge - realistic cost > 0? | Net PF > 1.00 | **Net PF < 1.00 → 修执行，否则 kill** |
| 3 | Out-of-sample net edge > 0? | OOS PF > 1.00 | **OOS PF < 1.00 → 判定过拟合** |
| 4 | 不同 market regime 中是否仍然有效？ | 至少 3 个 regime PF > 1.00 | **连续 3 个 regime 无效 → kill** |

### 7.3 当前策略证伪状态表

| 策略 | Gross PF | Net PF | OOS PF | Cost bps | 样本数 | 成本覆盖率 | 上下文覆盖率 | **结论** |
|------|----------|--------|--------|----------|--------|-----------|-----------|----------|
| cross_sectional | 待计算 | 待计算 | 待计算 | 待计算 | 24(real) | 0.21% | 0% | **样本不足，无法判断** |
| volume_breakout | 待计算 | 待计算 | 待计算 | 待计算 | 106(shadow) | 0.21% | 0% | **数据不足，无法判断** |
| microstructure | 待计算 | 待计算 | 待计算 | 待计算 | 679(shadow) | 0.21% | 0% | **研究级别，缺乏执行条件** |

### 7.4 策略 Kill Criteria（新增）

**任何策略满足以下任一条件即自动 kill**:

| # | 条件 | 操作 |
|---|------|------|
| 1 | Gross PF < 1.05 | 直接 kill |
| 2 | Net PF < 1.0 且成本优化后仍无改善 | kill |
| 3 | OOS PF < 1.0 | kill |
| 4 | PBO 高风险 | kill |
| 5 | 连续 3 个市场 regime 无效 | kill |
| 6 | 样本数达到 100 后仍无正期望 | kill |
| 7 | 成本覆盖率 / 上下文覆盖率不足时 | 不允许 promotion |

**防恢复条款**: 任何策略被 kill 后，不允许通过改名、换参数、删亏损样本重新进入 promotion，必须重新走完整研究流程。

---

## 八、修复实施方案（含严格边界条件）

> 以下每个修复项均标注**证据前提**——即在该前提满足前，该修复方案不应被视为"必然有效"。

### P0 — 恢复系统运行能力

**完成标准**: 系统连续 24-48 小时稳定运行，所有关键报告正常刷新，无 stale lock，无 stale data，无 corepack/tsx/agent-sdk 错误。**不以"修完命令"为完成标准。**

| # | 行动 | 方法 | 预估时间 |
|---|------|------|----------|
| 1 | 安装 corepack | `npm install -g corepack && corepack enable` | 10 分钟 |
| 2 | 确保 tsx 可用 | `pnpm add -D tsx` 或 `npm install -g tsx` | 5 分钟 |
| 3 | 清理死锁文件 | `rm -rf data/runtime/locks/*.lock/` | 5 分钟 |
| 4 | 修复 Agent SDK | 检查 `claude --version`，重新认证 OAuth token | 30 分钟 - 2 小时 |
| 5 | 重启所有 launchd 服务 | `launchctl bootout gui/$(id -u)/com.openalice.*` 后重新加载 | 15 分钟 |
| 6 | 持续稳定观察 | 监控 logs/ 中 24-48 小时无关键错误 | **24-48 小时** |

**证据前提**（P0 阶段不适用，无需验证）:

**安全边界**: 在所有 P0/P1 gate 通过前，**禁止配置任何具备真实下单权限的 production API key**。只允许使用 demo trading key 或完全本地 paper executor。production key 必须保持 withdraw disabled、trade permission disabled 或不写入系统。

### P1 — 止血（需通过验证后判断有效性）

**完成标准**:
- P0 稳定运行 ≥48 小时
- context coverage > 30%
- cost coverage > 30%
- 然后每个 P1 修复项才能开始验证

| # | 行动 | 证据前提 | 预期效果（待验证） |
|---|------|----------|-------------------|
| 1 | 切换路由为 passive_passive | 需额外验证 fill_rate、adverse_selection_bps 等非显性成本 | 显性成本 43→18 bps，但真实执行成本可能更高 |
| 2 | 提高信号置信度门槛 0.2→0.35 | **需先做 confidence 分桶回测**（见下方） | 减少交易频率，不一定提升胜率 |
| 3 | 替换为规则过滤而非删除币种 | 需先定义资产准入规则（成交量、spread、深度） | 消除事后归因偏差 |
| 4 | ATR 动态止损 | **必须先做 MFE/MAE 分析**（见下方） | 改变亏损路径，不等于增加盈利 |
| 5 | 100x 杠杆通道禁用 | 无需证据前提 | 消除高风险通道 |
| 6 | 启用 `minDailyVolumeUsd` 过滤 | 需填充 `dailyVolumeUsd` 字段 | 自动过滤低流动性资产 |

#### 置信度分桶验证（P1-2 前提）

在执行 P1-2 之前，必须完成以下回测：

| confidence bucket | trade count | gross pnl | net pnl | win rate | profit factor | max drawdown |
|-------------------|-------------|-----------|---------|----------|---------------|-------------|
| 0.00 - 0.10 | | | | | | |
| 0.10 - 0.20 | | | | | | |
| 0.20 - 0.35 | | | | | | |
| 0.35 - 0.50 | | | | | | |
| 0.50+ | | | | | | |

只有当高 confidence 区间的 net profit factor 明显更高，才允许提高门槛。

#### MFE/MAE 分析（P1-4 前提）

在执行 P1-4 前，必须回答：

| 问题 | 意义 |
|------|------|
| 亏损交易是否曾经浮盈？ | 如果有，说明止盈差 |
| 止损后价格是否继续下跌？ | 如果是，止损有效 |
| 止损后价格是否经常反弹？ | 如果是，止损过紧 |
| 盈利交易最大回撤是多少？ | 用于设置 trailing stop |
| 不同币种 MAE 分布是否不同？ | 用于分币种止损 |

没有 MFE/MAE，就直接把止损改成 ATR×2，本质上还是拍脑袋——只是从"固定百分比拍脑袋"升级成"带数学符号的拍脑袋"。

### P2 — 策略逻辑修复（需通过 P1 验证后实施）

**完成标准**:
- P1 修复已通过至少 7 天观察
- context coverage ≥ 70%
- cost coverage ≥ 70%
- 每项修复有明确的 A/B 验证方案

| # | 行动 | 证据前提 |
|---|------|----------|
| 1 | 重写 cross_sectional 信号公式 | 需证明原信号公式有可测量的系统性错误 |
| 2 | 引入主动止盈逻辑 | 需 MFE 分析支持 |
| 3 | 多时间框架确认 | 需证明单一时间框架假突破率 > 阈值 |
| 4 | `breakQuality` 改进 | 需证明原算法与未来收益负相关 |
| 5 | WFO/FDR/PBO 统计验证 | **前置于任何 promotion 决策** |
| 6 | 回测 universe 扩展 | 需确保扩展后的数据覆盖完整性 |

### P3 — 系统加固

| # | 行动 | 完成标准 |
|---|------|----------|
| 1 | 上下文管道重构 | `contextBuckets.ok` 从 0% → >95% |
| 2 | 锁文件超时强制释放 | 连续 30 天无死锁 |
| 3 | 策略自动淘汰机制 | 5+ 连续亏损自动暂停 |
| 4 | 数据质量实时监控 | mark price/spread/volume 全部实时校验 |
| 5 | 满足纸面门控要求 | 14 天、20 笔、100+ 样本、成本/上下文覆盖率 >95% |

### AI 自优化循环恢复（特殊处理）

**AI 自优化循环不得在 P0 立即恢复为自动写入模式。**

因为系统当前存在：
- 上下文缺失（0%）
- PnL 口径混乱
- 成本证据缺失
- 锁文件死锁
- 策略缺陷未修复
- 数据覆盖不足

如果 AI improvement loop 在坏数据上运行，它只会产出**更自信的坏建议**。

> **方案**: 先恢复为 read-only / suggestion-only 模式，等待数据覆盖率、成本覆盖率、PnL ledger 全部恢复后，再允许进入 controlled patch generation。

---

## 九、最小可行重启版本（新增）

当前全系统大修方案风险过高。建议先定义一个**最小恢复版本**：

### 最小闭环范围

```
资产:   BTC / ETH / SOL only（3 个币种，非 34 个）
杠杆:   1x only
执行:   paper only
AI:     read-only（不自动修改代码）
100x:   excluded
microstructure: excluded（缺 L2 数据）
低流动性币: excluded
策略:   one strategy only（建议 cross_sectional 或 volume_breakout 二选一）
日志:   full context logging
成本:   full cost logging
MFE/MAE: full logging
```

### 最小闭环完成标准

```
连续 14 天稳定运行
0 stale data
0 stale lock
context coverage > 95%
cost coverage > 95%
paper ledger valid
no real money execution
```

---

## 十、Market Regime 分层分析（新增）

### 10.1 当前问题

原报告把全部交易混在一起分析。不同市场状态下策略表现可能完全不同，混合统计会导致结论被污染。

### 10.2 必须区分的 regimes

| regime | 说明 | 预期策略表现 |
|--------|------|-------------|
| trend | 趋势市场 | volume_breakout 可能有效 |
| chop | 震荡市场 | cross_sectional reversal 可能有效 |
| high vol | 高波动市场 | 所有策略止损风险上升 |
| low vol | 低波动市场 | 信号信噪比下降 |
| funding extreme | 资金费率极端 | cross_sectional 信号失真 |
| liquidity stress | 流动性恶化 | 小币种策略应自动暂停 |
| news shock | 突发事件 | 所有策略应暂停 |

### 10.3 要求

所有策略必须按 market regime 分层统计 PF、win rate、avg win/loss、drawdown 和 cost-adjusted return。仅在全市场 regime 下均有效的策略方可 promotion。

---

## 十一、实时数据覆盖与 Universe 约束

### 11.1 当前状态

| 指标 | 数值 |
|------|------|
| 有实时数据的币种 | 5 个（BTC、ETH、SOL、BNB、XRP） |
| 策略 universe | 34 个币种 |
| 实时数据覆盖率 | 14.7% |
| 其余 29 个币种数据状态 | `stale: 41h` |

### 11.2 约束规则

**当实时数据覆盖率 < 95% 时，禁止运行 cross_sectional 排名策略。**

原因：cross_sectional 依赖横截面排序，如果 34 个资产里只有 5 个实时，剩下 29 个 stale，排名没有意义。

如果只覆盖 5 个币种，则 universe 必须临时降级为这 5 个币种，且**禁止与历史 34 币结果混合比较**。

---

## 十二、关键发现总结（修正版）

### 12.1 八条可确认的事实

1. **基础设施全面崩溃**: corepack/tsx 缺失导致 8 个定时任务全部停摆。这是最确定、最可修复的问题。
2. **系统处于"风控防护成功但业务瘫痪"状态**: 门控拦截了大多数低质量信号，但也导致系统无法形成有效交易闭环。
3. **路由成本超支 115%**: taker_taker 43 bps > 预算 20 bps，是执行层最确定的亏损因素。
4. **上下文覆盖率为 0%**: 没有一笔交易拥有完整的决策上下文，所有基于上下文的分析不可信。
5. **策略 alpha 未被证明**: 归因只能解释历史亏损，不能预测修复后的盈利能力。
6. **PV of 证据链几乎全部断裂**: WFO/PBO/DSR/FDR 全部失败或缺失。
7. **实时数据覆盖 5/34**: universe 远大于有效数据覆盖范围。
8. **100x 微观结构通道缺乏基本执行条件**: L2 数据、spread、latency、fill model 全部缺失。

### 12.2 四条待验证的假设（不得视为承诺）

| 假设 | 状态 | 验证条件 |
|------|------|----------|
| 切换 passive_passive 后净收益改善 | 待验证 | 需 fill_rate、adverse_selection、missed_opportunity 数据 |
| 提高 confidence 门槛可提升胜率 | 待验证 | 需 confidence 分桶回测 |
| ATR 动态止损可减少误触 | 待验证 | 需 MFE/MAE 分析 |
| 删除低流动性币种可改善未来收益 | 待验证 | 需规则过滤 + OOS 验证 |

### 12.3 六条应删除的误导性表述

| 原表述 | 问题 | 处理 |
|--------|------|------|
| "大部分信号扭亏" | 未证明 passive_passive 真实成交质量 | **已删除** |
| "过滤 80%+ 低质量信号" | 未证明 confidence 与收益正相关 | **已删除** |
| "消除 91% 的亏损源" | 事后筛选，不能预测未来 | **已删除** |
| "止损误触率预期降低 60%+" | 没有 MFE/MAE 支撑 | **已删除** |
| "P0 预计 2 小时" | 命令修复不等于系统恢复 | **修正为 24-48h** |
| "这 9% 中还因为路由成本超支被进一步拦截" | 暗示拦截的信号本可盈利，无证据 | **已删除** |

---

## 十三、最终判断

### 这份计划可以作为抢救手册，但不能作为盈利承诺。

当前最优先不是赚钱，而是回答一个根本问题：

**OpenAlice 是否有任何策略，在真实成本、真实成交、完整上下文、样本外验证下，仍然具备正期望？**

如果答案是否定的，那就别修策略了，直接杀掉大部分交易逻辑，只保留：

- 数据管道
- 成本模型
- 回测框架
- 风控门控
- paper executor
- 诊断系统

然后从 alpha research 重新开始。

---

## 附录 A：修复时间线与里程碑（修正版）

```
Day 0-2 (P0):  ████████████████ 基础设施恢复（2 天）
                ├─ corepack/tsx 安装
                ├─ 锁文件清理
                ├─ Agent SDK 修复
                ├─ 安全屏障（禁止 production API key）
                └─ 观察 24-48 小时稳定运行

Day 3-7:       ████████████ 系统稳定观察期（5 天）
                ├─ 确认所有 cron 正常运行
                ├─ 确认 shadow 捕获产生信号
                ├─ 确认 PnL 诊断每日更新
                └─ AI 自优化 read-only 模式

Day 8-14:      市场 regime 分类 + MFE/MAE 基线建立（7 天）
                ├─ 完成 confidence 分桶回测
                ├─ 完成 MFE/MAE 分析
                ├─ 完成 fill quality 基线
                └─ 完成资产准入规则定义

Day 15-21      ████████████ P1 止血 + 验证（7 天）
(P1):           ├─ 路由切换 passive_passive
                ├─ 置信度门槛调整（基于分桶证据）
                ├─ 规则过滤上线（非手工删币种）
                ├─ ATR 止损（基于 MFE/MAE 证据）
                ├─ 100x 禁用
                └─ 流动性过滤启用

里程碑 M1:     检查点 — P1 修复是否有效？
                ├─ 已验证: context/cost coverage > 50%
                ├─ 已验证: confidence 校准有效
                ├─ 已验证: MFE/MAE 基线完成
                └─ 未通过 → 重新评估 P1 方案，不得进入 P2

Day 22-35      ████████████████████ P2 策略修复 + 统计验证（2 周）
(P2):           ├─ 信号公式改进（基于证据）
                ├─ 主动止盈（基于 MFE）
                ├─ 多时间框架确认
                ├─ WFO / FDR / PBO / DSR 验证
                └─ Alpha 证伪流程

里程碑 M2:     检查点 — 策略 alpha 是否被证明？
                ├─ 至少一个策略通过 Alpha 四步证伪
                ├─ WFO/PBO/DSR/FDR 全部通过
                └─ 未通过 → 全线降级为 research，不得 promotion

Day 36-60      ████████████████████████████████ P3 系统加固（1 月）
(P3):           ├─ 上下文管道重构 → 95%+ 覆盖
                ├─ 48 缺陷修复
                ├─ 自动淘汰机制
                ├─ 数据质量监控
                └─ 纸面门控全部解除

里程碑 M3:     检查点 — 能否通过发布门控？
                ├─ 是 → 可以考虑最小实盘（BTC/ETH/SOL, 1x, 1 策略）
                └─ 否 → 继续迭代，不得突破 promotion
```

---

## 附录 B：完全修复合计工作量

| 阶段 | 修复项 | 证据前提验证 | 实施 | 观察 | 总计 |
|------|--------|-------------|------|------|------|
| P0 | 6 项 | 0 天 | 0.5-2 天 | 2 天 | **2.5-4 天** |
| P1 | 6 项 | 7 天（基线） | 2-3 天 | 7 天 | **16-17 天** |
| P2 | 6 项 | 14 天（含 P1 观察） | 5-7 天 | 7 天 | **26-28 天** |
| P3 | 6 项 | 30 天（含 P2 观察） | 7-14 天 | 14 天 | **51-58 天** |

**合计**: 最短 8 周（仅 P0），合理 16-20 周（P0-P2），全面 24+ 周（P0-P3+alpha 证伪）。

> 这里的"周"是指从决策日开始的连续日历时间，且假设 P1-P3 每步验证都通过。任何验证失败都会重置对应阶段。

---

## 附录 C：数据来源（保留原清单）

（同原报告，此处省略）

---

## 附录 D：资产准入规则（替代手工删币种）

在执行 P1-3 时，应使用以下规则替代"删除亏损币种"：

**资产进入 universe 的条件**:
1. `dailyVolumeUsd > $50M`（或 $100M，视策略而定）
2. `spreadBps < 20`（需实时 spread 数据）
3. `orderbookDepthWithin10bps > X`（需 L2 数据）
4. `fundingRateAbs < threshold`
5. `volatilityPercentile` 不处于极端区间
6. 最近 N 天数据完整率 > 95%
7. 无异常跳价 / 缺 K / stale data

**禁止**: 把"删除历史亏损币种后的回测改善"作为策略通过证据。

---

*本报告基于 OpenAlice 项目实际运行数据和源代码分析生成。所有数据截至 2026-05-08。修正版增加了 PnL 口径分离、alpha 证伪流程、kill criteria、passive_passive 证伪分析、confidence 校准要求、MFE/MAE 前提条件和市场 regime 分层要求。*

---

## 历史版本 v1a: 盈利诊断报告（原始深度版）

> 以下为 2026-05-08 原始盈利诊断报告。该报告将 shadow PnL -26.81% 直接等同于系统亏损（已被 v1b 纠正），将 taker_taker 成本标注为 43 bps（已被 v4 artifact 纠正为 26 bps），并提出 passive_passive 可让超过一半注定亏损的交易扭亏（已被 v1b 证伪分析否定）。保留此文仅为追溯诊断过程，所有结论以 v4 正文为准。

# OpenAlice 盈利诊断报告（深度版）

**日期**: 2026-05-08
**项目**: OpenAlice v0.9.0-beta.8
**结论**: 系统全面亏损 -26.81%，多层风控锁定，基础设施瘫痪。这不是单一问题，而是从策略逻辑 → 信号质量 → 执行成本 → 基础设施 → 风控治理的**全链路系统性崩溃**。

---

## 一、总体盈亏概况

### 1.1 宏观指标

| 指标 | 数值 | 评判 |
|------|------|------|
| 累计已平仓交易 | 947 笔（含影子） | — |
| 实际执行交易 | 24 笔 | 其余均为影子/反事实记录 |
| **总盈亏 (PnL%)** | **-26.81%** | 严重亏损 |
| 平均单笔盈亏 | -0.028% | 微亏累积 |
| 胜率 (Win Rate) | 37.57% | 低于随机 |
| **盈亏比 (Profit Factor)** | **0.71** | < 1.0，净亏损 |
| 最大连续亏损 | **14 笔** | 风控失效 |
| 盈利:亏损:持平 | 357 : 461 : 129 | 亏多赢少 |

> Profit Factor = 0.71 意味着每赚 1 美元同时亏损 1.41 美元。即使胜率提升到 50%，当前盈亏比仍然无法盈利。

### 1.2 四个账户权益曲线

| 账户 | 初始权益 | 当前权益 | 总回报 | 状态 |
|------|----------|----------|--------|------|
| spot_1x | $100,000 | $99,856.26 | **-0.14%** | 已全部平仓 |
| conservative_3x | $100,000 | $99,797.31 | **-0.20%** | 已全部平仓 |
| stress_10x | $100,000 | $100,679.92 | **+0.68%** | 唯一盈利账户 |
| liquidation_probe_100x | $100,000 | $99,750.00 | **-0.25%** | 仍有未平仓 |
| **合计** | **$400,000** | **$400,083.49** | **+0.02%** | 几乎持平 |

> **关键反常现象**: 四个账户合计几乎不赚不赔（+0.02%），但诊断报告显示 -26.81%。差异来自：诊断统计了 **影子/反事实交易**（含所有杠杆倍数的叠加复记），而实际账户净值只反映了已被执行门控过滤后进入纸面执行的极少交易（仅 24 笔）。换句话说，**风控门控确实挡住了大部分垃圾信号，但代价是系统完全无法运行**。

---

## 二、策略逻辑深度拆解 —— 每个策略为何亏损

### 2.1 横截面反转 (cross_sectional) — 最大亏损源

**实现位置**: `src/domain/strategy/cross-sectional-momentum.ts:1-249`
**纸面执行**: `scripts/paper_trade_cross_sectional.ts:1-2918`

**信号公式**:
```
riskAdjustedScore = primaryReturn/σ × (1-mtfWeight) + secondaryReturn/σ × mtfWeight + fundingAdjust
fundingAdjust = -clamp(fundingRate/0.05, -1, 1) × 0.25 × 3
```

按 score 升序排列 → 底部 N 名做多，顶部 N 名做空。要求回报率离散度 ≥ 5%。

**战绩**: 24 笔交易，胜率 41.7%，总亏损 -3.76%，盈亏比 0.892

**致命缺陷**:

| 缺陷 | 详情 | 影响 |
|------|------|------|
| 融资率调整是硬编码魔法数字 | `× 0.25 × 3` 无理论依据，无参数搜索优化 | 信号在高融资率期间严重失真 |
| 最小离散度 5% 门槛过低 | 许多时段达不到有效离散度，强制信号在无效分布上运行 | 在不该交易的时候交易 |
| 初始版本无流动性过滤 | `minDailyVolumeUsd` 字段存在但未启用 | APT/ORDI/WIF/PEPE 等小币种长驱直入 |
| 48 小时固定到期退出 | 93.5% 的交易以 `holding_expired` 结束 | 盈利头寸坐等反转，亏损头寸无保护 |
| 等权排名 | 所有资产在排名中权重相同，不考虑市值/波动率差异 | 小币种波动大，排名两端被它们主导 |

**ORDI-USDT 悖论**: ORDI 胜率高达 72.7%，但总 PnL 为 -11.11%。因为胜的交易每笔赚得极少（微利即平），而亏损交易（-7.60%）一笔就抹去 12 笔盈利。**这是典型的"捡硬币、让火车撞"策略**。

### 2.2 成交量突破 (volume_breakout) — 成本吞噬收益

**实现位置**: `src/domain/strategy/volume-breakout.ts:1-237`
**纸面执行**: `scripts/paper_trade_volume_breakout.ts:1-1044`

**信号公式**:
```
volumeRatio = currentVolume / medianVolume(24 bars)
rangeBreakout = close > max(high[-12:-1])  (做多)
confidence = volumeRatio × breakQuality × rangeBreakoutPct 的复合函数
```

**战绩**: 1x/3x 各 106 笔，胜率 46.2%，各亏损 -2.21%，盈亏比 0.841

**致命缺陷**:

| 缺陷 | 详情 |
|------|------|
| 5 分钟 K 线的中位数成交量统计不稳定 | 24 根 bar = 仅 2 小时历史，样本量太小 |
| `breakQuality` 只看单根 K 线收盘位置 | 跳空开盘、影线突破等形态完全被忽略 |
| 3% 固定止损对 3 倍杠杆太紧 | 正常波动（BTC 日均波动 ~2-3%）即可触发 |
| 持仓仅 6 根 bar（30 分钟） | 不足以让突破趋势充分发展 |
| taker_taker 路由成本 43 bps | 即使信号正确，扣费后净收益为负 |

**一条典型亏损交易的完整路径**（来自影子账本）:
```
BTC-USDT, volume_breakout_1x, 做空 @ $81,088
  预期毛收益: +0.31%
  路由成本:     -0.43% (taker_taker)
  预期净收益:   -0.12%  ← 开仓前就已注定亏损
  置信度:       0.012   ← 远低于 0.2 门槛
  突破幅度:     0.53%   ← 低于 1% 最低要求
  结果: 被门控拦截（幸好）
```

### 2.3 微观结构压力 (microstructure) — 止损绞肉机

**实现位置**: `scripts/paper_trade_microstructure_stress.ts:1-1457`

**信号公式**:
```
impulsePct = max(abs(return30s), abs(return60s)) × direction
volumeRatio = currentVolume(10 bars) / baselineVolume(110 bars)
confidence = min(1, strength/0.2 × min(2, volumeRatio) / 2)
```

**战绩**: stress_10x 301 笔（胜率 36.5%, -0.99%），liquidation_probe_100x 378 笔（胜率 34.1%, -2.06%）

**配置对比**:

| 参数 | stress_10x | liquidation_probe_100x |
|------|-----------|----------------------|
| 杠杆 | 10x | 100x |
| 最大持仓 | 120 秒 | 30 秒 |
| 止损 | 0.25% | 0.08% |
| 止盈 | 0.35% | 0.12% |
| 保证金比例 | 1% | 0.5%（估算） |

**致命缺陷**:

| 缺陷 | 详情 |
|------|------|
| 1 秒 K 线成交量基线仅 110 秒 | 统计学上完全不显著 |
| 止损占该通道亏损的 72.1% | 100x 杠杆下 0.08% 止损等于 8% 本金亏损 |
| `spreadStatusAtOpen: "unknown"` | 从未使用实际买卖价差过滤，滑点完全未知 |
| DOGE-USDT 平均持仓 34 秒即止损 | meme 币的 bid-ask spread 可达 5-10 bps，入场即亏损 |
| BNB-USDT 止损占比 100% | 该币种在 100x 通道中每笔交易都是止损退出 |

### 2.4 投资组合分配层 — 理论正确但被信号拖累

**实现位置**: `src/portfolio/allocator.ts:1-598`

采用**逆波动率 + Black-Litterman + 层级风险聚类(HCA)** 三层分配：
```
weight = HCA_base × (1 + clamp(BL_return, -0.5, 0.5))
BL_return = f(factor_ensemble_signals)
```

八个因子以等权 1.0 全部启用（资金费率、基差、成交量激增、动量复合、均值回归、波动率机制、清算压力、跨时间框架背离）。但问题在于：**因子信号本身就是噪音**，BL 优化器是"garbage in, garbage out"。

---

## 三、交易成本深度分析

### 3.1 四条路由的成本拆解

| 路由 | 手续费 | 价差 | 滑点 | 逆向选择 | 队列损失 | 资金费率 | **总成本** | 预算 | 状态 |
|------|--------|------|------|----------|----------|----------|------------|------|------|
| passive_passive | 4 | 2 | 4 | 5 | 3 | 0 | **18 bps** | 20 | 通过 |
| passive_taker | 7 | 4 | 8 | 3 | 2 | 0 | **24 bps** | 20 | 超支 |
| taker_taker | 10 | 8 | 12 | 6 | 4 | 3 | **43 bps** | 20 | 严重超支 |
| twap | 7 | 6 | 7 | 4 | 3 | 0 | **27 bps** | 20 | 超支 |

**实际使用的 OKX 费率**（从 API 获取）:
- Maker: 2 bps, Taker: 5 bps
- 账户等级: `runtime_api_max_fee`

### 3.2 成本对策略的致命影响

以 volume_breakout 通道为例，分析信号收益与成本的关系：

```
信号预期毛收益分布（来自影子账本采样）:
  中位数: +0.30%
  均值:   +0.42%
  标准差: 0.61%

taker_taker 成本: 0.43%

扣除成本后的净收益:
  中位数: -0.13%  ← 超过一半的交易注定亏损
  正收益占比: 38%  ← 只有 38% 的信号强到能覆盖成本
```

这意味着即使信号 100% 正确，使用 taker_taker 路由也只有不到 40% 的交易能盈利。**路由选择本身就是一个盈亏决定因素**。

### 3.3 成本证据覆盖率为 0

| 证据维度 | 覆盖率 | 影响 |
|----------|--------|------|
| V3 上下文快照 | 0% (0/947) | 无法追溯每笔交易的决策环境 |
| 开仓成本记录 | 0.21% (2/947) | PnL 归因没有成本因素 |
| 预期毛/净收益 | 0% (0/947) | 无法判断信号质量 vs 成本谁在亏损 |
| MFE/MAE 路径 | 1.06% (10/947) | 无法分析持仓期间的最大有利/不利偏移 |

---

## 四、基础设施全面瘫痪分析

### 4.1 故障层级

整个系统存在三层阻断，形成"死亡螺旋"：

```
第 1 层 (环境): corepack/tsx 未安装
      ↓
第 2 层 (进程): 8 个 cron/launchd 任务全部失败
      ↓
第 3 层 (业务): 锁文件死锁 → 门控过期 → 证据链断裂 → 全通道封锁
```

### 4.2 所有失败进程清单

| 进程 | 失败次数（估算） | 错误 | 影响 |
|------|-----------------|------|------|
| realtime_shadow_monitor | 334+ 周期 | `spawn corepack ENOENT` | 影子交易信号完全停摆 |
| cron_continuous_improvement | 500+ | `tsx: command not found` | AI 自我优化循环停摆 |
| cron_cp_intake | 300+ | `tsx: command not found` | 策略候选摄取停摆 |
| cron_market_intel_context | 650+ | `tsx: command not found` + 锁死锁 | 市场情报上下文不再更新 |
| cron_paper_pnl_diagnostics | 部分 | `tsx: command not found` | PnL 数据停在 5 月 5 日 |
| cron_paper_trade_volume_breakout | 50+ | `not promotion-v2 gated` | 成交量突破通道被门控跳过 |
| paper_policy_shadow_settle | 300+ | 锁死锁 | 影子结算永久跳过 |
| microstructure_stress | 持续 | `accumulate-1s failed` + 环境变量阻止 | 1 秒数据收集和微结构策略双停 |
| agent-sdk | 20+ | `exited with code 1` | AI 推理后端反复崩溃 |

### 4.3 锁文件死锁

两个关键定时任务已被死锁数日：

```
cron_openalice_task_refresh_market_intel_context:
  锁年龄: > 3 天
  staleAfterSeconds: 3600 (1 小时)
  状态: lock exists, skipping overlap (×650+)

paper_policy_shadow_settle:
  锁年龄: > 3.5 天 (304,027 秒)
  staleAfterSeconds: 3600
  状态: lock exists, skipping overlap (×300+)
```

**根因**: 拥有锁的进程早已崩溃/被杀，但锁清理机制未生效。系统没有锁超时后的强制释放逻辑。

### 4.4 Agent SDK 崩溃链

```
[agent-sdk] Claude Code process exited with code 1
    at getProcessExitError (sdk.mjs:19:6947)
    at ChildProcess (sdk.mjs:19:9498)
```

崩溃发生在 `@anthropic-ai/claude-agent-sdk@0.2.72` 的子进程管理层。每次 AI 调用都触发新子进程，子进程立即退出 code 1。可能的根因：
- Claude Code CLI 未安装或版本不兼容
- OAuth token 过期
- 子进程环境变量缺失

---

## 五、风控门控全貌 —— 五层阻断体系

### 5.1 12 项必检清单（6/12 通过）

| # | 检查项 | 完成度 | 状态 |
|---|--------|--------|------|
| 1 | OKX 公共数据/私有认证/费率 | 100% | 通过 |
| 2 | 外部数据仓库挂载 | 100% | 通过 |
| 3 | AI-Scientist 候选来源 | 100% | 通过 |
| 4 | ETH 持仓 PIT/基差数据 | 100% | 通过 |
| 5 | 调度器安全审计 | 100% | 通过 |
| 6 | 安全不变性检查 | 100% | 通过 |
| 7 | 多源数据目录 | 68% | **阻断** (99 个数据集中 67 个完整) |
| 8 | AI-Scientist 第二次验证 | 18% | **阻断** (88 门控中缺失 72 个) |
| 9 | 量化框架基准 | 0% | **阻断** (10 项能力全部缺失) |
| 10 | 策略缺陷登记/监控 | 29% | **阻断** (48 缺陷中 34 个开放) |
| 11 | ETH 持仓前瞻证据 | 样本不足 | **阻断** (28/100 样本，平均毛收益 -0.19%) |
| 12 | 模拟/实盘发布门控盈利性 | 0% | **阻断** (11 项阻断条件) |

### 5.2 发布门控 (Release Gate) — 五项全败

| 门控 | 状态 | 详情 |
|------|------|------|
| WFO（向前走验证） | **失败** | 窗口比率 0.6 > 0.3 阈值，5 窗口中 3 失败 |
| 统计显著性 | **失败** | PBO 不确定, DSR 缺失, FDR 缺失, 试验账本缺失 |
| 风险模拟 | **失败** | 完全缺失 |
| 经济性 | **失败** | 3/4 路由超出预算，费率非运行时验证 |
| 策略计划一致性 | **失败** | lookbackHours/mtfWeight 在配置与候选间不匹配 |

### 5.3 纸面门控 (Paper Gate) — 40+ 项阻断

核心阻断项：
```
- paper_research_not_approved
- paper_executor_disabled
- insufficient_paper_days: 7 < 14
- insufficient_closed_paper_trades: 12 < 20
- insufficient_live_universe: 5 < 20  ← 只有 5 个币种有实时数据
- stale_paper_evidence_report
- paper_evidence_decision_hash_mismatch
- paper:p1_evidence_trust_not_pass (6 个维度)
- paper:p1_trial_ledger_not_valid (5 个维度)
- paper:p1_gate_not_cost_adjusted
- paper:p1_stop_loss_cluster: 42
- paper:p1_stoploss_risk_policy_blocked (7 个 symbol×side 组合)
- stoploss_lane: microstructure_100x: block
```

### 5.4 被封锁的策略通道

```
- volume_breakout_1x
- volume_breakout_3x
- microstructure_100x
- cross_sectional_100x
- volume_breakout_100x
```

仅有 `cross_sectional` (1x) 未被列入上述名单，但它在风控配置中被标记为 `not promotion-v2 gated`，同样被跳过。

---

## 六、信号质量与数据完整性

### 6.1 上下文覆盖黑洞

| 上下文状态 | 交易数 | 占比 |
|-----------|--------|------|
| ok（正常） | **0** | **0%** |
| stale（过期） | 8 | 0.85% |
| legacy_missing（缺失） | 935 | 98.9% |
| new_missing（新缺失） | 2 | 0.21% |

> **没有一笔交易拥有完整的决策上下文。** AI 交易代理在完全"盲飞"状态下做出了所有 947 笔交易决策。

### 6.2 信号置信度系统性偏低

对影子账本中 1,495 条被拦截信号的抽样统计：

| 置信度区间 | 占比 | 状态 |
|-----------|------|------|
| 0.00 - 0.05 | 32% | 严重低于门槛 |
| 0.05 - 0.15 | 41% | 低于门槛 |
| 0.15 - 0.20 | 18% | 接近但不够 |
| 0.20+ | 9% | **符合门槛** |

**只有 9% 的信号置信度达到 0.2 的最低执行门槛**。而这 9% 中还因为路由成本超支、上下文缺失等原因被进一步拦截。

### 6.3 实时数据覆盖不足

系统仅对 5 个币种有实时数据（BTC、ETH、SOL、BNB、XRP），而策略 universe 要求 34 个币种。其余 29 个币种的数据标记为 `stale: 41h`。

---

## 七、策略缺陷登记册 — 48 个已知但未修复的问题

系统自身的缺陷追踪器已记录了 48 个策略缺陷：

| 严重级别 | 数量 | 状态 |
|----------|------|------|
| P0（阻塞） | 10 | 全部开放 |
| P1（高优） | 18 | 9 开放 + 9 部分完成 |
| P2/P3（中低） | 20 | 部分完成或观察中 |

**P0 级别缺陷包括**:
- 固定参数（止损、止盈、持仓期）未针对不同波动率环境做自适应
- 止损未使用 ATR 或波动率缩放
- 滑点遥测完全缺失
- 订单簿深度检查未实现
- 小币种流动性过滤未生效
- 回测过拟合保护 (PBO=1.0) 未解决

---

## 八、每日 PnL 时间序列与时间聚集效应

### 8.1 spot_1x 账户每日 PnL

| 日期 | PnL ($) | PnL (%) | 累计 (%) |
|------|---------|---------|----------|
| 04-29 | +52.57 | +0.053% | +0.053% |
| 04-30 | +311.40 | +0.311% | +0.364% |
| 05-01 | +195.84 | +0.196% | +0.560% |
| **05-02** | **-138.69** | **-0.139%** | +0.421% |
| **05-03** | **-235.90** | **-0.236%** | +0.185% |
| 05-04 | +289.07 | +0.289% | +0.474% |
| 05-06 | +528.02 | +0.528% | +1.002% |

**关键时间模式**:
- **5 月 2-3 日是集中亏损期**: 两天亏损 $374，占全部回撤的 79%
- **5 月 5 日数据完全缺失**: 所有账户该日均无 PnL 记录，怀疑系统当天完全离线
- **TRX/ORDI/SEI 做空在 5 月 2-3 日集体平仓**: 这些是横截面策略的同步平仓，一个信号错误导致多币种同时亏损
- **DOGE 是唯一持续盈利的币种**: 多日做多累计贡献了绝大部分正收益

### 8.2 收益率不对称性

| 维度 | 盈利交易 | 亏损交易 |
|------|----------|----------|
| 平均 PnL% | +0.86% | -1.47% |
| 中位数 PnL% | +0.43% | -0.62% |
| 最大单笔 | +7.07% (DOGE) | -7.60% (ORDI) |
| 平均持仓 | 6,310 秒 | 4,200 秒 |

亏损交易的平均亏损幅度是盈利交易平均盈利的 **1.7 倍**。盈亏比的天生不对称是 Profit Factor < 1 的数学根源。

---

## 九、根因全链路梳理

```
                    策略设计缺陷
                         │
     ┌──────────────────┼──────────────────┐
     │                  │                  │
  信号公式有         止损/止盈         流动性过滤
  魔法数字           不对称            缺失
     │                  │                  │
     └──────────────────┼──────────────────┘
                         │
                    信号质量差
                    (置信度 < 0.2, 上下文 0%)
                         │
     ┌──────────────────┼──────────────────┐
     │                  │                  │
  交易成本吞噬       门控全部触发       基础设施瘫痪
  (43 > 20 bps)      (5 层阻断)        (corepack/tsx)
     │                  │                  │
     └──────────────────┼──────────────────┘
                         │
                    系统完全锁死
              无法执行任何交易/验证/迭代
```

### 按严重程度的根因排序

| # | 根因 | 影响面 | 修复难度 |
|---|------|--------|----------|
| 1 | **基础设施崩溃** (corepack/tsx 缺失) | 所有定时任务、监控、诊断 | 低（安装即可） |
| 2 | **锁文件死锁** (2 个关键任务锁死 >3 天) | 市场情报、影子结算 | 低（删除锁文件） |
| 3 | **信号公式存在硬编码魔法数字** | 所有策略信号质量 | 中（需参数搜索） |
| 4 | **无止盈逻辑**（100% holding_expired 退出） | 盈利头寸全部反转 | 中（需改策略代码） |
| 5 | **路由成本 43 bps > 信号期望收益** | 即使信号正确也亏钱 | 中（切换路由+优化执行） |
| 6 | **止损未按波动率自适应**（固定百分比） | 高波动币种被频繁扫损 | 中（改止损公式） |
| 7 | **流动性过滤缺失** | APT/ORDI 造成 91% 亏损 | 中（启用已有字段） |
| 8 | **上下文数据 98.9% 缺失** | 所有决策基于不完整信息 | 高（需重构上下文管道） |
| 9 | **统计验证全部失败**（WFO/PBO/FDR/DSR） | 策略缺乏统计学证据 | 高（需重新做回测验证） |
| 10 | **48 个已知缺陷未修复** | 系统整体可靠性 | 高（需逐项修复） |

---

## 十、可执行的恢复路线图

### P0 — 恢复系统运行能力（预计 2 小时）

| # | 行动 | 命令/方法 |
|---|------|----------|
| 1 | 安装 corepack | `npm install -g corepack && corepack enable` |
| 2 | 确保 tsx 可用 | `pnpm add -D tsx` 或 `npm install -g tsx` |
| 3 | 清理死锁文件 | `rm data/runtime/locks/*.lock` |
| 4 | 修复 Agent SDK | 检查 `claude --version`，重新认证 OAuth token |
| 5 | 重启所有 launchd 服务 | `launchctl bootout gui/$(id -u)/com.openalice.*` 后重新加载 |
| 6 | 验证恢复 | 检查 `realtime_shadow_monitor.latest.json` 状态变为 running |

### P1 — 止血（预计 1 周）

| # | 行动 | 预期效果 |
|---|------|----------|
| 1 | 切换所有通道路由为 `passive_passive` (18 bps) | 成本降低 58%，大部分信号扭亏 |
| 2 | 提高信号置信度门槛从 0.2 → 0.35 | 过滤 80%+ 的低质量信号 |
| 3 | 紧急移除 APT-USDT, ORDI-USDT, WIF-USDT, PEPE-USDT | 消除 91% 的亏损源 |
| 4 | 将所有止损改为 ATR(14)×2 动态止损 | 止损误触率预期降低 60%+ |
| 5 | 对 100x 杠杆通道添加硬性禁止 (`production-leverage-guard.ts` 已存在) | 消除最大杠杆的毁灭性亏损 |
| 6 | 启用 `minDailyVolumeUsd` 流动性过滤 (阈值建议 $50M+) | 自动过滤低流动性陷阱币种 |

### P2 — 修复策略逻辑（预计 2-4 周）

| # | 行动 |
|---|------|
| 1 | 重写 cross_sectional 信号公式：移除融资率魔法数字，引入市值加权排名 |
| 2 | 引入主动止盈：trailing stop (ATR×3) + 分批止盈 (50% @ 1R, 50% trailing) |
| 3 | 为 volume_breakout 增加多时间框架确认（15m + 1h 双确认） |
| 4 | 将 `breakQuality` 从单 K 线收盘位置改为考量 K 线实体比例 + 上下影线 |
| 5 | 完成 WFO / FDR / PBO 统计验证：至少需要 100+ 样本量 |
| 6 | 将回测 universe 从 6 资产扩展到与生产一致的 34 资产 |

### P3 — 系统加固（预计 1-2 月）

| # | 行动 |
|---|------|
| 1 | 重构上下文管道：确保 100% 交易有完整 V3 上下文快照 |
| 2 | 修复 48 个已登记策略缺陷 |
| 3 | 建立策略自动淘汰机制：连续亏损 >5 笔或 7 日 Sharpe < 0 → 自动暂停 |
| 4 | 添加锁文件超时强制释放机制（staleAfterSeconds 应有清理守护进程） |
| 5 | 建立完整的数据质量监控：mark price, spread, 成交量均需实时校验 |
| 6 | 满足所有纸面门控要求：14 天、20 笔交易、100+ 前瞻样本 |

---

## 十一、详细修复实施方案

> 以下每个修复项均包含：目标文件、具体改动内容、预期效果验证方法。按 P0→P3 优先级排列。

---

### P0-1: 修复 corepack 环境

**根因**: `launch_realtime_shadow_monitor.sh:10` 的 `exec corepack pnpm ...` 在 launchd 的 PATH 中找不到 `corepack`。

**受影响进程** (8 个):
- `realtime_shadow_monitor` — 影子信号完全停摆
- `microstructure_stress_monitor` — 微结构策略停摆
- `cron_continuous_improvement_loop` — AI 自优化停摆
- `cron_cp_intake` — 策略候选摄取停摆
- `cron_market_intel_context` — 市场情报停摆
- `cron_paper_pnl_diagnostics` — PnL 诊断停摆
- `cron_paper_trade_volume_breakout` — 突破策略停摆
- `cron_paper_trade_cross_sectional` — 横截面策略停摆

**修复步骤**:

```bash
# 1. 安装 corepack
npm install -g corepack
corepack enable

# 2. 验证
which corepack          # 应返回 /opt/homebrew/bin/corepack 或类似
corepack pnpm --version # 应输出版本号

# 3. 安装 tsx（cron 脚本需要）
cd /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice
pnpm add -D tsx

# 4. 验证 tsx
npx tsx --version
```

**脚本改进** (`scripts/launch_realtime_shadow_monitor.sh:35`):

当前第 35 行 `exec "${PNPM_CMD[@]}"` 在 PNPM_CMD 为空且 fallback 失败时已正确 exit 127。但脚本的 fallback 逻辑 (第 15-27 行) 依赖 Homebrew 路径探测，而 launchd 环境中这些路径不在 PATH 中。改进方案：

```bash
# 在第 28 行后、第 30 行前插入 npx 回退:
if [[ "${#PNPM_CMD[@]}" -eq 0 ]] && command -v npx >/dev/null 2>&1; then
  PNPM_CMD=(npx pnpm)
fi
```

**验证标准**: 所有 8 个进程在 `logs/` 中不再出现 `corepack: not found` 或 `tsx: command not found`。

---

### P0-2: 清理死锁文件

**根因**: `cron_market_intel_context` 和 `paper_policy_shadow_settle` 两个定时任务的锁文件已被持有超过 3 天（锁年龄 304,027 秒，超时阈值仅 3,600 秒）。持有锁的进程已崩溃，但无强制释放逻辑。

**修复步骤**:

```bash
# 1. 立即清理所有死锁
rm -f /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice/data/runtime/locks/*.lock

# 2. 验证锁已清理
ls /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice/data/runtime/locks/
# 应为空或仅有最近几分钟内创建的锁
```

**代码改进** — 在锁获取逻辑中添加超时强制释放。定位锁管理代码（位于 `src/core/` 或 `scripts/` 中的锁工具函数），添加：

```typescript
// 锁超时强制释放逻辑 (伪代码，需根据实际锁实现调整)
const STALE_LOCK_SECONDS = 3600 // 1 小时，与 staleAfterSeconds 一致

function acquireLock(lockPath: string): boolean {
  if (fs.existsSync(lockPath)) {
    const stat = fs.statSync(lockPath)
    const ageSeconds = (Date.now() - stat.mtimeMs) / 1000
    if (ageSeconds > STALE_LOCK_SECONDS) {
      console.warn(`Force-releasing stale lock: ${lockPath} (age: ${ageSeconds}s)`)
      fs.unlinkSync(lockPath)
    } else {
      return false // 锁仍有效，跳过
    }
  }
  fs.writeFileSync(lockPath, String(process.pid), 'utf-8')
  return true
}
```

**验证标准**: 
- `cron_market_intel_context` 日志不再出现 `lock exists, skipping overlap`
- `paper_policy_shadow_settle` 日志不再出现 `lock exists, skipping overlap`
- 市场情报上下文开始正常刷新

---

### P0-3: 修复 Agent SDK 崩溃

**根因**: `@anthropic-ai/claude-agent-sdk@0.2.72` 的子进程每次调用都退出 code 1。

**排查步骤**:

```bash
# 1. 检查 Claude Code CLI 是否存在且版本兼容
claude --version

# 2. 检查 OAuth 认证状态
claude auth status

# 3. 如果未登录，重新认证
claude auth login

# 4. 测试 SDK 是否能正常启动子进程
cd /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice
node -e "
  const { default: SDK } = require('@anthropic-ai/claude-agent-sdk');
  console.log('SDK loaded:', typeof SDK);
"
```

**可能的修复**:
- 如果 Claude Code CLI 未安装: `npm install -g @anthropic-ai/claude-code`
- 如果 OAuth token 过期: `claude auth login`
- 如果版本不兼容: 升级 SDK `pnpm update @anthropic-ai/claude-agent-sdk`

**验证标准**: `logs/agent-sdk.log` 不再出现 `exited with code 1`，转为正常的 tool_use/tool_result/text 事件流。

---

### P0-4: 创建账户配置

**根因**: `data/config/accounts.json` 为空数组 `[]`，即使所有风控解除系统也无法执行任何交易。

**修复** — 参考 `data/config/accounts.demo.template.json` 创建 OKX 纸面账户:

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice

# 直接复制模板并启用
cp data/config/accounts.demo.template.json data/config/accounts.json
```

然后编辑 `data/config/accounts.json`，将 `"enabled": false` 改为 `"enabled": true`，将 exchange 从 `"bybit"` 改为 `"okx"`:

```json
[
  {
    "id": "okx-paper",
    "label": "OKX Paper Trading",
    "type": "ccxt",
    "enabled": true,
    "guards": ["symbol-whitelist", "cooldown", "max-position-size"],
    "brokerConfig": {
      "exchange": "okx",
      "sandbox": false,
      "demoTrading": true,
      "apiKey": "<OKX_DEMO_API_KEY>",
      "apiSecret": "<OKX_DEMO_API_SECRET>",
      "password": "<OKX_API_PASSWORD>",
      "options": {
        "options": {
          "defaultType": "swap"
        }
      }
    },
    "cryptoExecution": {
      "mode": "paper_only",
      "enableCryptoDispatcher": true,
      "requireDecisionTicket": false,
      "ticketTtlMs": 600000,
      "idempotencyTtlMs": 1800000,
      "killSwitchDefaultPolicy": "block_new_only",
      "killSwitchStatePath": "data/runtime/kill-switch.sqlite",
      "operationTimeoutMs": 30000
    }
  }
]
```

**注意**: OKX demo trading API key 需从 OKX 官网获取。当前 `.env` 文件中已有 production API key，demo key 需要单独申请。或者使用 production API key 但将 `demoTrading` 设为 `false`（风险自负，仅纸面模式下安全）。

**验证标准**: `data/config/accounts.json` 包含至少 1 个 `enabled: true` 的账户配置。

---

### P1-1: 切换所有策略路由为 passive_passive

**目标文件**: 各策略的纸面执行脚本中的路由选择逻辑。

**当前状态**: 所有影子交易使用 taker_taker (26 bps)，超出 20 bps 预算。passive_passive 仅 18 bps，在预算内。

**修复** — 在 `scripts/paper_trade_volume_breakout.ts` 和 `scripts/paper_trade_microstructure_stress.ts` 中，将默认路由从 taker_taker 改为 passive_passive：

`scripts/paper_trade_volume_breakout.ts` 中查找路由选择逻辑（约在 shadow 开仓函数中），将:
```typescript
// 当前: 默认使用 taker_taker
route: 'taker_taker'
```
改为:
```typescript
// 修复: 强制使用 passive_passive
route: 'passive_passive'
```

**注意**: passive_passive 要求使用限价单（maker 挂单），可能导致成交率下降（部分订单无法成交）。需要监控：
- 挂单成交率（fill rate）— 如果低于 60%，考虑加滑点容忍度
- 实际成交价 vs 信号价偏差

**预期效果**: 
- 路由成本 43 → 18 bps（降低 58%）
- 信号净收益中位数从 -0.13% → +0.12%（扭亏）
- 信号正收益占比从 38% → ~55%

**验证标准**: `route_cost_budget.latest.json` 中默认路由变为 passive_passive，且影子账本不再出现 `route_cost_budget_exceeded`。

---

### P1-2: 信号置信度门槛从 0.2 提升至 0.35

**目标文件**: `scripts/paper_trade_volume_breakout.ts:155-162`

**当前状态**:
```typescript
const DEFAULT_VB_EXECUTION_GATE: VBExecutionGate = {
  minConfidence: 0.2,    // ← 当前门槛
  minRangeBreakoutPct: 1,
  ...
}
```

**修复**:
```typescript
const DEFAULT_VB_EXECUTION_GATE: VBExecutionGate = {
  minConfidence: 0.35,   // ← 提升至 0.35，过滤 80%+ 低质量信号
  minRangeBreakoutPct: 2, // ← 突破幅度从 1% 提升至 2%
  ...
}
```

同样，`scripts/paper_trade_microstructure_stress.ts:392` 的置信度计算逻辑保持不变，但在 `signalPassesProfile` 函数中将门槛从 0.15 提升至 0.25：

```typescript
// 当前 (line ~517-522):
confidence >= 0.15
// 修复:
confidence >= 0.25
```

**预期效果**: 信号数量减少约 60-70%，但剩余信号质量显著提升，胜率预期从 37% → 45%+。

**验证标准**: 影子捕获报告中 `candidatesSeen > 0` 且 `blockReasons` 中 `confidence X < 0.35` 占比下降。

---

### P1-3: 紧急移除有毒币种

**目标文件**: `scripts/paper_trade_volume_breakout.ts:150` 的 `SYMBOLS` 列表, `scripts/paper_trade_cross_sectional.ts` 的 universe 定义

**当前状态**: 系统 universe 包含 34 个币种，包括 APT、ORDI、WIF、PEPE、TRX 等低流动性代币。这 5 个币种贡献了 91% 的总亏损。

**修复** — 在 universe 定义中移除或黑名单以下币种：

```typescript
// 紧急移除列表（基于 PnL 诊断数据）:
const BLOCKED_SYMBOLS = new Set([
  'APT-USDT',   // 17 笔交易, -13.41%, 胜率 23.5%
  'ORDI-USDT',  // 22 笔交易, -11.11%, 盈亏比极度不对称
  'WIF-USDT',   // 9 笔交易, -3.81%
  'TRX-USDT',   // 5 笔交易, -4.63%
  'PEPE-USDT',  // 多笔亏损
  'SHIB-USDT',  // meme 币，流动性差
])
```

**更优雅的方案** — 启用已有的 `minDailyVolumeUsd` 过滤（见 P1-6）。

**预期效果**: 消除约 91% 的历史亏损来源。

**验证标准**: 影子账本中不再出现上述币种的开仓记录。

---

### P1-4: 止损从固定百分比改为 ATR 动态止损

**问题**: 所有策略使用固定百分比止损，在高波动币种（DOGE、BNB）上平均 34 秒即触发。

**目标文件**:
- `scripts/paper_trade_microstructure_stress.ts:246-279` (MICRO_PROFILES)
- `scripts/paper_trade_volume_breakout.ts:47-56` (DEFAULT_VB_CONFIG)
- `src/domain/strategy/volume-breakout.ts:47-56` (DEFAULT_VB_CONFIG)

**当前 volume_breakout 止损** (`volume-breakout.ts:52`):
```typescript
stopLossPct: 0.03, // 3.0% — 固定百分比
```

**修复** — 改为 ATR 动态计算:

```typescript
// volume-breakout.ts 新增 ATR 计算函数
function computeAtr(candles: Bar[], period: number = 14): number {
  if (candles.length < period + 1) return 0
  let trSum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high
    const low = candles[i].low
    const prevClose = candles[i - 1].close
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
    trSum += tr
  }
  return trSum / period
}

// 修改 DEFAULT_VB_CONFIG:
export const DEFAULT_VB_CONFIG: VolumeBreakoutConfig = {
  ...
  stopLossPct: 0.03,        // 保留为回退默认值
  atrStopMultiplier: 2.0,   // 新增: ATR 止损倍数
  atrPeriod: 14,            // 新增: ATR 计算周期
  ...
}
```

在信号评估中:
```typescript
// 原逻辑:
const stopLoss = latest.close * (1 - cfg.stopLossPct)

// 修复为:
const atr = computeAtr(candles, cfg.atrPeriod)
const dynamicStopPct = atr > 0
  ? (atr / latest.close) * cfg.atrStopMultiplier
  : cfg.stopLossPct  // ATR 不可用时回退到固定百分比
const stopLoss = latest.close * (1 - Math.max(dynamicStopPct, cfg.stopLossPct * 0.5))
// Math.max 确保止损不会比固定止损的 50% 更紧
```

**microstructure 止损修复** (`paper_trade_microstructure_stress.ts:246-279`):

```typescript
// 当前:
{ id: 'stress_10x', ..., stopLossPct: 0.25, takeProfitPct: 0.35 }
{ id: 'liquidation_probe_100x', ..., stopLossPct: 0.08, takeProfitPct: 0.12 }

// 修复 — 100x 杠杆的止损在 1 秒 K 线级别极难用 ATR，建议直接禁用:
// 将 liquidation_probe_100x 的 mode 从 'stress_only' 改为 'disabled'
{ id: 'liquidation_probe_100x', ..., mode: 'disabled' }

// 10x 杠杆改用 ATR(14)×1.5:
{ id: 'stress_10x', ..., stopLossPct: 0.25, atrStopMultiplier: 1.5 }
```

**预期效果**: 止损误触率降低 60%+，microstructure_100x 通道的 72.1% 止损亏损消除（因为该通道被禁用）。

**验证标准**: 止损触发占比从 18.5% → <8%；止损聚类不再触发。

---

### P1-5: 100x 杠杆通道硬性禁止

**目标文件**: `scripts/paper_trade_microstructure_stress.ts:263-278`

**根因**: 100x 杠杆下 0.08% 的止损等于 8% 本金亏损，且 100x 通道每笔交易都在亏钱（胜率 34.1%，盈亏比 0.783）。

**修复** — 将 `liquidation_probe_100x` profile 禁用:

```typescript
{
  id: 'liquidation_probe_100x',
  label: 'Liquidation probe 100x',
  mode: 'disabled',  // 原为 'stress_only' — 永久禁用
  ...
}
```

同时确认已有的生产杠杆守护 (`src/domain/trading/production-leverage-guard.ts:1-25`) 仍然生效。

**预期效果**: 消除约 2.06% 的总亏损（microstructure_100x 通道）。

**验证标准**: 影子账本不再出现 `lane: microstructure_100x` 的记录。

---

### P1-6: 启用流动性过滤

**目标文件**: `src/domain/strategy/cross-sectional-momentum.ts:76-90` (DEFAULT_CONFIG)

**当前状态**: `minDailyVolumeUsd` 字段已定义（默认 $10M），`spreadBps` 过滤逻辑已存在。但问题在于 **调用方传入的数据中 `dailyVolumeUsd` 字段为空**，导致过滤被跳过。

**根因**: `scripts/paper_trade_cross_sectional.ts` 在构建 `CrossSectionalAsset` 时未填充 `dailyVolumeUsd` 字段。

**修复** — 在纸面执行脚本中，确保从市场数据中提取 24h 成交量并填充到 `dailyVolumeUsd`:

```typescript
// paper_trade_cross_sectional.ts 中构建 asset 对象时:
const asset: CrossSectionalAsset = {
  symbol: symbol,
  currentPrice: price,
  returns: { '168h': ret7d, '720h': ret30d },
  realizedVolPct: volPct,
  avgVolume24h: volume24h,
  dailyVolumeUsd: price * volume24h,  // ← 确保填充此字段
  spreadBps: spreadBps ?? undefined,
  fundingRatePct: fundingRate ?? undefined,
}
```

同时将 `minDailyVolumeUsd` 默认值从 $10M 提升至 $50M:

```typescript
// cross-sectional-momentum.ts:88
minDailyVolumeUsd: 50_000_000, // $50M — 过滤掉 APT/ORDI/WIF/PEPE 等
```

**预期效果**: 自动过滤掉日均成交量 < $50M 的低流动性币种，无需手动维护黑名单。

**验证标准**: 纸面交易 universe 中不再出现 APT-USDT、ORDI-USDT 等小币种。

---

### P2-1: cross_sectional 信号公式修复

**目标文件**: `src/domain/strategy/cross-sectional-momentum.ts:150-155`

**当前问题**: 融资率调整为硬编码魔法数字 `× 0.25 × 3`:

```typescript
// 第 154 行 — 魔法数字
fundingAdjust = fundingNorm * fundingWeight * 3
```

`fundingWeight` 默认 0.25，所以实际缩放是 `0.25 × 3 = 0.75`。这个值没有任何理论或实证依据。

**修复** — 移除硬编码的 3 倍缩放，改为可配置参数:

```typescript
// 1. 在 CrossSectionalConfig 接口中新增:
fundingScaleFactor?: number  // 融资率调整的缩放因子

// 2. 在 DEFAULT_CONFIG 中新增:
fundingScaleFactor: 1.0,  // 默认 1.0，保守

// 3. 修改第 154 行:
// 旧: fundingAdjust = fundingNorm * fundingWeight * 3
// 新:
const scale = cfg.fundingScaleFactor ?? 1.0
fundingAdjust = fundingNorm * fundingWeight * scale
```

**参数优化方法**: 通过回测搜索最优 `fundingScaleFactor` (范围 0.5 ~ 5.0, 步长 0.5)，以 Sharpe ratio 或 Profit Factor 为目标函数。

**同样需要修复的魔法数字**:
- `cross-sectional-momentum.ts:216`: `Math.abs(fundingZ) * 0.3 * fundingWeight` → 改为 `fundingConfirmWeight` 可配置参数
- `microstructure_stress.ts:392`: `(strength / 0.2) * Math.min(2, volumeRatio) / 2` → 其中的 0.2 和 2 改为可配置

---

### P2-2: 引入主动止盈逻辑

**好消息**: cross_sectional 策略已经实现了 ATR trailing stop（`paper_trade_cross_sectional.ts:1734-1753`）。问题在于它只用于止损方向，没有在盈利方向被有效触发。

**目标文件**: `scripts/paper_trade_volume_breakout.ts:480-606` (closePositions)

**当前状态**: volume_breakout 的退出逻辑只有 `holding_expired` 和固定止损。

**修复** — 在 volume_breakout 的 `closePositions` 函数中添加 trailing stop 止盈:

```typescript
// 在 closePositions 中添加 (参考 paper_trade_cross_sectional.ts 的实现):
const atr = computeAtr(pathCandles, 14)
const trailingStopPrice = position.direction === 'long'
  ? highestPriceSinceEntry * (1 - atr / currentPrice * 3)  // ATR×3 trailing
  : lowestPriceSinceEntry * (1 + atr / currentPrice * 3)

const hitTrailingStop = position.direction === 'long'
  ? currentPrice <= trailingStopPrice
  : currentPrice >= trailingStopPrice

// 添加到平仓条件:
const shouldClose = bannedSymbol || expired || hitStop || hitTrailingStop || liquidated
```

**分批止盈逻辑**:
```typescript
// 首次止盈: 50% 仓位在 1.5R 处平仓
const hitFirstTarget = pnlPct >= (atr / entryPrice) * 1.5 * 100
if (hitFirstTarget && !position.firstTargetClosed) {
  // 平掉 50% 仓位
  closePartialPosition(position, 0.5, 'first_target')
  position.firstTargetClosed = true
}
// 剩余 50% 使用 trailing stop
```

**预期效果**: 盈利交易的平均 PnL% 从 +0.86% 提升至 +1.5%+，盈亏比从 0.71 改善至 >0.85。

---

### P2-3: volume_breakout 多时间框架确认

**目标文件**: `src/domain/strategy/volume-breakout.ts:86-174` (evaluateVolumeBreakout)

**当前问题**: 仅在 5 分钟 K 线上判断突破，没有更高时间框架的趋势确认。

**修复** — 在 signal 评估中添加 1h K 线趋势过滤:

```typescript
export interface VolumeBreakoutConfig {
  ...
  /** 新增: 1h 趋势确认 — 要求 1h 趋势方向与突破方向一致 */
  requireH1TrendConfirm: boolean
  /** 新增: 1h SMA 快线周期 */
  h1TrendFastPeriod: number
  /** 新增: 1h SMA 慢线周期 */
  h1TrendSlowPeriod: number
}

// 在 evaluateVolumeBreakout 的信号生成前添加:
if (cfg.requireH1TrendConfirm && h1Candles && h1Candles.length >= cfg.h1TrendSlowPeriod) {
  const h1FastSma = sma(h1Candles.slice(-cfg.h1TrendFastPeriod).map(c => c.close))
  const h1SlowSma = sma(h1Candles.slice(-cfg.h1TrendSlowPeriod).map(c => c.close))
  const h1Trend = h1FastSma > h1SlowSma ? 'up' : 'down'
  if (breakoutUp && h1Trend !== 'up') return noSignal('H1 trend not confirming long breakout')
  if (breakoutDown && h1Trend !== 'down') return noSignal('H1 trend not confirming short breakout')
}
```

**预期效果**: 减少逆势假突破信号约 30-40%。

---

### P2-4: breakQuality 改进

**目标文件**: `src/domain/strategy/volume-breakout.ts:176-188` (computeBreakQuality)

**当前问题**: `computeBreakQuality` 只考虑单根 K 线的收盘位置（`closeLocation * 0.7 + bodyScore * 0.3`），无法识别跳空开盘和影线突破。

**修复**:

```typescript
function computeBreakQuality(bar: Bar, prevBar: Bar, side: 'long' | 'short'): number {
  const range = bar.high - bar.low
  if (!Number.isFinite(range) || range <= 0) return 0

  // 1. 收盘位置得分 (保留原逻辑)
  const closeLocation = side === 'long'
    ? (bar.close - bar.low) / range
    : (bar.high - bar.close) / range

  // 2. K 线实体得分 (保留原逻辑)
  const body = Math.abs(bar.close - bar.open) / range
  const directionalBody = side === 'long'
    ? bar.close > bar.open
    : bar.close < bar.open
  const bodyScore = directionalBody ? Math.min(1, body) : 0

  // 3. 新增: 跳空确认得分 — 开盘价已突破前 bar 范围
  const gapScore = side === 'long'
    ? bar.open > prevBar.high ? 1 : bar.open > prevBar.close ? 0.5 : 0
    : bar.open < prevBar.low ? 1 : bar.open < prevBar.close ? 0.5 : 0

  // 4. 新增: 影线惩罚 — 长影线表示突破受阻
  const upperWick = (bar.high - Math.max(bar.open, bar.close)) / range
  const lowerWick = (Math.min(bar.open, bar.close) - bar.low) / range
  const wickPenalty = side === 'long'
    ? Math.max(0, 1 - upperWick * 2)  // 长上影线 = 多头受阻
    : Math.max(0, 1 - lowerWick * 2)  // 长下影线 = 空头受阻

  return Math.max(0, Math.min(1,
    closeLocation * 0.35 + bodyScore * 0.25 + gapScore * 0.25 + wickPenalty * 0.15
  ))
}
```

---

### P2-5: 统计验证修复

**目标**: 通过 WFO、FDR、PBO 三项统计验证，满足发布门控要求。

**WFO (Walk-Forward Optimization)**:
- 当前失败原因: 窗口比率 0.6 > 0.3 阈值（5 窗口中 3 个失败）
- 修复方法: 在回测中增加 WFO 窗口数量（从 5 → 10），使用更短的训练/测试分割，确保每个窗口有足够样本

**FDR (False Discovery Rate)**:
- 当前状态: 完全缺失
- 修复方法: 实现 Benjamini-Hochberg 程序对多个策略/参数组合的 p-value 进行多重检验校正

**PBO (Probability of Backtest Overfitting)**:
- 当前状态: PBO = 1.0（100% 过拟合）
- 修复方法: 使用 Combinatorial Purged Cross-Validation (CPCV) 替代简单的 train/test split

**具体实现** — 在 `src/backtest/statistical_significance.ts` 中:

```typescript
// 1. Benjamini-Hochberg FDR 控制
export function benjaminiHochberg(pValues: number[], q: number = 0.1): boolean[] {
  const n = pValues.length
  const indexed = pValues.map((p, i) => ({ p, i }))
  indexed.sort((a, b) => a.p - b.p)
  
  let maxK = 0
  for (let k = 0; k < n; k++) {
    if (indexed[k].p <= (k + 1) * q / n) maxK = k + 1
  }
  
  const rejected = new Array(n).fill(false)
  for (let k = 0; k < maxK; k++) rejected[indexed[k].i] = true
  return rejected
}

// 2. CPCV-based PBO
export function computePBO(
  inSampleSharpes: number[],
  outOfSampleSharpes: number[],
): number {
  const n = inSampleSharpes.length
  // PBO = probability that the best IS strategy underperforms median OOS
  const combined = inSampleSharpes.map((is, i) => ({ is, oos: outOfSampleSharpes[i] }))
  combined.sort((a, b) => b.is - a.is) // sort by IS performance
  
  const medianOos = median(outOfSampleSharpes)
  const bestIsOos = combined[0].oos
  return bestIsOos < medianOos ? 1 : combined.filter(c => c.oos < medianOos).length / n
}
```

**验证标准**: WFO 5/5 窗口通过, FDR < 0.1, PBO < 0.5。

---

### P2-6: 回测 universe 从 6 资产扩展到 34 资产

**目标文件**: `src/backtest/strategy-validation/backtest.ts`

**当前问题**: 回测仅在 6 个资产上运行，而生产 universe 有 34 个资产。这导致严重的样本偏差。

**修复** — 将回测 universe 对齐到生产 universe:
```typescript
// backtest.ts 中:
const BACKTEST_UNIVERSE = [
  'BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'BNB-USDT', 'XRP-USDT',
  'DOGE-USDT', 'ADA-USDT', 'AVAX-USDT', 'LINK-USDT', 'DOT-USDT',
  'LTC-USDT', 'BCH-USDT', 'UNI-USDT', 'AAVE-USDT', 'ARB-USDT',
  'OP-USDT', 'SUI-USDT', 'TON-USDT', 'NEAR-USDT', 'ATOM-USDT',
  'FIL-USDT', 'INJ-USDT', 'ETC-USDT',
  // 排除已验证有毒的: APT-USDT, ORDI-USDT, WIF-USDT, PEPE-USDT, TRX-USDT, SHIB-USDT, POL-USDT, WLD-USDT, TIA-USDT, SEI-USDT, JUP-USDT
]
```

---

### P3-1: 上下文管道重构 (98.9% → 100%)

**问题**: 没有一笔交易拥有完整的 V3 决策上下文。需要从决策点开始完整记录市场环境。

**修复架构**:
```
决策触发 → [记录快照] → 信号评估 → [记录信号] → 门控检查 → [记录门控结果] → 执行
                │                           │                    │
           market_intel_context       signal_quality_context    gate_context
           (当前: 0% 覆盖)           (当前: 0% 覆盖)          (当前: 0% 覆盖)
```

**关键字段** (每笔交易决策必须记录):
```typescript
interface TradeDecisionContext {
  // 市场环境
  marketDataWatermark: string      // 数据时间水印
  featuresAvailable: boolean       // 特征可用性
  featureSchemaVersion: string     // 特征版本
  
  // 信号质量
  confidence: number               // 信号置信度
  ruleScore: number               // 规则评分
  flashConfidenceLow: number      // 快速置信度下界
  
  // 成本估算
  estimatedCostPct: number        // 预估交易成本
  expectedGrossEdgePct: number    // 预估毛收益
  expectedNetEdgePct: number      // 预估净收益
  selectedRoute: string           // 选择的路由
  
  // 风控状态
  gateResults: GateResult[]       // 各项门控结果
  fuseState: SystemFuseState      // 系统熔断状态
}
```

**验证标准**: `contextBuckets.ok` 占比从 0% → >95%。

---

### P3-2: 锁文件超时强制释放机制

**目标**: 防止锁文件死锁再次发生。

**实现位置**: 锁管理工具函数（`src/core/` 或 `scripts/` 中的 lock 工具）

```typescript
// 锁守护进程 — 在 cron 调度器中添加:
function startLockCleanupDaemon(lockDir: string, intervalMs: number = 300_000) {
  setInterval(() => {
    const files = fs.readdirSync(lockDir)
    for (const file of files) {
      if (!file.endsWith('.lock')) continue
      const lockPath = path.join(lockDir, file)
      try {
        const stat = fs.statSync(lockPath)
        const ageMs = Date.now() - stat.mtimeMs
        if (ageMs > 3_600_000) { // 1 小时
          console.warn(`[LockCleanup] Force-releasing stale lock: ${file} (age: ${(ageMs/3600000).toFixed(1)}h)`)
          fs.unlinkSync(lockPath)
        }
      } catch (err) {
        // 文件可能已被删除
      }
    }
  }, intervalMs)
}
```

---

### P3-3: 策略自动淘汰机制

**目标**: 当策略连续亏损时自动暂停，防止持续失血。

**实现**:
```typescript
interface StrategyHealthMonitor {
  lane: string
  consecutiveLosses: number
  maxConsecutiveLosses: number       // 默认 5
  rollingSharpe7d: number
  minRollingSharpe: number           // 默认 0
  rollingPnLPct7d: number
  maxDrawdown7d: number              // 默认 -10%
}

function evaluateStrategyHealth(monitor: StrategyHealthMonitor): 'active' | 'paused' | 'retired' {
  if (monitor.consecutiveLosses >= monitor.maxConsecutiveLosses) return 'paused'
  if (monitor.rollingSharpe7d < monitor.minRollingSharpe) return 'paused'
  if (monitor.rollingPnLPct7d < monitor.maxDrawdown7d) return 'paused'
  return 'active'
}
```

---

### P3-4: 数据质量实时监控

**目标**: 确保 mark price、spread、volume 在交易决策时可用。

**实现**:
```typescript
interface DataQualityCheck {
  symbol: string
  markPriceFreshness: 'ok' | 'stale' | 'missing'
  spreadQuality: 'ok' | 'wide' | 'unknown'
  volumeQuality: 'ok' | 'low' | 'unknown'
}

// 在 paper_trade 门控检查中添加:
function checkDataQuality(symbol: string): DataQualityCheck {
  const markPrice = getLatestMarkPrice(symbol)
  const spread = getLatestSpread(symbol)
  
  return {
    markPriceFreshness: markPrice && (Date.now() - markPrice.ts) < 60_000 ? 'ok' : 'stale',
    spreadQuality: spread ? (spread.bps <= 40 ? 'ok' : 'wide') : 'unknown',
    volumeQuality: /* 类似检查 */,
  }
}

// 如果 markPriceFreshness != 'ok' 或 spreadQuality == 'unknown'，阻止交易:
if (quality.markPriceFreshness !== 'ok' || quality.spreadQuality === 'unknown') {
  blockReasons.push(`data_quality_${quality.markPriceFreshness}_${quality.spreadQuality}`)
}
```

---

### P3-5: 满足纸面门控所有要求

目标：解除 paper_gate_status 的 NO_GO 裁决。

| 门控要求 | 当前值 | 目标值 | 达成方法 |
|----------|--------|--------|----------|
| paper_days | 7 | ≥14 | 系统修复后运行 7+ 天 |
| closed_paper_trades | 12 | ≥20 | 信号质量修复后自然积累 |
| live_data_quality_good | 5 | ≥20 | 扩展数据管道覆盖 |
| paper_evidence_trust | 6项全失败 | 6项全通过 | P1/P2 修复后重新验证 |
| trial_ledger_valid | 5项失败 | 全部通过 | 补充 FDR/DSR/PBO 验证 |
| stop_loss_cluster | 42 笔 | <10 笔 | P1-4 动态止损修复 |
| cost_evidence_ok | missing | present | P1-1 路由修复 + 成本记录 |

---

## 十二、修复时间线与里程碑

```
Day 0 (P0):  ████ 基础设施恢复 (4 小时)
             ├─ corepack/tsx 安装
             ├─ 锁文件清理  
             ├─ Agent SDK 修复
             └─ 账户配置创建

Day 1-3:     系统稳定观察期
             ├─ 确认所有 cron 正常运行
             ├─ 确认影子捕获产生信号
             └─ 确认 PnL 诊断每日更新

Day 4-10     ████████ P1 止血修复 (1 周)
(P1):        ├─ 路由切换 passive_passive
             ├─ 置信度门槛 0.2→0.35
             ├─ 有毒币种移除
             ├─ ATR 动态止损
             ├─ 100x 杠杆禁用
             └─ 流动性过滤启用

Day 11-14:   纸面观察期
             ├─ 观察 PnL 曲线是否止跌
             ├─ 验证止损聚类是否解除
             └─ 检查信号质量改善幅度

Day 15-30    ████████████████████ P2 策略修复 (2 周)
(P2):        ├─ cross_sectional 信号公式修复
             ├─ 主动止盈实现
             ├─ 多时间框架确认
             ├─ breakQuality 改进
             ├─ 统计验证补全
             └─ 回测 universe 扩展

里程碑 M1    检查点：PnL 是否回正？
             ├─ 是 → 继续 P2
             └─ 否 → 重新评估策略 alpha 是否存在

Day 31-60    ████████████████████████████████ P3 系统加固 (1 月)
(P3):        ├─ 上下文管道重构
             ├─ 48 缺陷修复
             ├─ 自动淘汰机制
             ├─ 数据质量监控
             └─ 纸面门控全部解除

里程碑 M2    检查点：能否通过发布门控？
             ├─ 是 → 可以考虑小资金实盘
             └─ 否 → 继续迭代
```

---

## 十三、关键发现总结

1. **这不是"策略不好"的问题，而是全链路系统性崩溃**——从代码质量（魔法数字）到信号质量（上下文缺失）到执行质量（成本超支）到运维质量（进程全部崩溃），每一层都有独立且严重的问题。

2. **风控系统在设计上是成功的**——它正确地识别并拦截了几乎所有质量不合格的信号。问题不在于风控太严，而在于信号太差。

3. **唯一盈利的账户是 10x 杠杆的压力测试账户 (+0.68%)**，而 1x/3x/100x 全部亏损。说明适度的杠杆在信号有微弱优势时可以放大收益，但极端的 100x 杠杆只会放大噪音。

4. **ORDI-USDT 的高胜率低盈利悖论**证明：胜率是一个危险的虚荣指标。策略需要优化的是盈亏比（Profit Factor），而非胜率。

5. **成本优化是最容易见效的改进**：从 taker_taker (43 bps) 切换到 passive_passive (18 bps)，仅此一项就可以让超过一半的"注定亏损"交易扭亏为盈。

---

## 附录 A：数据来源

| 数据 | 路径 | 最新时间戳 |
|------|------|-----------|
| PnL 诊断报告 | `logs/cron_paper_pnl_diagnostics.log` | 2026-05-05 |
| 影子账本 | `data/paper_trading/paper_policy_shadow_ledger.jsonl` | 2026-05-07 (2956 行) |
| 实际交易结果 | `data/paper_trading/paper_trade_result.jsonl` | 2026-05-07 (24 笔) |
| 系统状态 | `data/runtime/system_status_reason_chain.latest.json` | 2026-05-08 04:41 |
| 影子监控 | `data/runtime/realtime_shadow_monitor.latest.json` | 2026-05-08 04:41 |
| 路由成本 | `data/runtime/route_cost_budget.latest.json` | 2026-05-08 04:12 |
| 目标审计 | `data/runtime/openalice_goal_completion_audit.latest.json` | 2026-05-08 04:41 |
| 数据新鲜度 | `data/runtime/live_data_freshness.latest.json` | 2026-05-08 04:41 |
| 影子捕获 | `data/runtime/paper_policy_shadow_capture.latest.json` | 2026-05-08 04:41 |
| 错误日志 | `logs/openalice_main.launchd.err.log` | 2026-05-08 12:37 |
| Agent SDK 日志 | `logs/agent-sdk.log` | 2026-05-08 12:33 |
| 策略缺陷登记册 | `data/research/` 及诊断文档 | 2026-05-04 |

## 附录 B：关键配置文件

| 文件 | 路径 | 关键内容 |
|------|------|----------|
| kill-switch | `data/config/kill-switch.json` | 默认 block_new_only |
| risk | `data/config/risk.json` | 5 阶段资金规模阶梯，max 5x leverage |
| strategy | `data/config/strategy.json` | 8 因子启用，volTarget=10%，凯利分数 0.15 |
| crypto | `data/config/crypto.json` | OKX demo, BTC/ETH only, 30min cooldown |
| accounts | `data/config/accounts.json` | **空数组** — 无账户配置 |
| governance | `data/config/governance.json` | release/live/stats 三层门控全部启用 |
| review-gate | `data/config/review-gate.json` | 已启用，阻断 critical/high |

---

*本报告基于 OpenAlice 项目实际运行数据和源代码分析生成。所有数据截至 2026-05-08。*
