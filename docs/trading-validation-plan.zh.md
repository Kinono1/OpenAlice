# OpenAlice 交易策略验证与迭代路线图（2026-02-22）

## 1. 目标与原则

本路线图的目标不是“快速上实盘”，而是把当前可用的 AI 交易框架升级为可验证、可复现、可控风险的系统。

核心原则：

1. 先验证流程稳定，再追求收益提升。
2. 先做样本外可迁移，再做复杂创新。
3. 所有交易必须经过硬风控门禁，策略不能绕过。

## 2. 当前仓库能力盘点（基于现有代码）

已具备能力：

1. 实盘接口和工具链
   - `src/extension/crypto-trading/providers/ccxt/CcxtTradingEngine.ts`
   - `src/extension/crypto-trading/adapter.ts`
2. 交易决策审计与可回放（git-like wallet）
   - `src/extension/crypto-trading/wallet/Wallet.ts`
   - `src/extension/crypto-trading/wallet/adapter.ts`
3. 市场与新闻读取工具
   - `src/extension/analysis-tools/adapter.ts`
   - `src/extension/analysis-kit/kline/KlineStore.ts`
4. 指标计算器（RSI/EMA/MACD 等）
   - `src/extension/analysis-tools/tools/calculate-indicator.tool.ts`

关键缺口：

1. 缺少“可复现策略模块”（固定参数、固定信号定义、固定下单规则）。
2. 缺少“严格回测执行器”（手续费/滑点/延迟/资金费率统一建模）。
3. 缺少 Walk-forward + OOS 自动化评估流程。
4. 缺少纸交易运行器与回测偏差监控。
5. 缺少统一硬风控门禁（单笔风险、日亏损上限、熔断、kill switch）。

## 3. 分阶段执行计划（可直接落地）

## Phase 0（1-2 天）：建立“可复现研究底座”

交付物：

1. 策略配置文件（新增本地配置）：
   - `data/config/strategy.json`（gitignored，存策略参数）
2. 结果目录规范（新增）：
   - `logs/research/{runId}/config.snapshot.json`
   - `logs/research/{runId}/metrics.json`
   - `logs/research/{runId}/trades.csv`

验收标准：

1. 相同数据+相同配置重复运行，产出哈希一致（允许时间戳字段不同）。
2. 每次运行都会固化配置快照，支持审计复盘。

## Phase 1（3-5 天）：先做 3 个基线策略

策略族（先做简单、可解释）：

1. 趋势跟随（Dual MA / Donchian Breakout 二选一）
2. 均值回归（RSI + 布林带回归）
3. 资金费率/Carry（仅在数据可得时启用）

代码结构建议（新增）：

1. `src/strategy/types.ts`（信号、仓位、风控上下文）
2. `src/strategy/baseline/trend.ts`
3. `src/strategy/baseline/mean-reversion.ts`
4. `src/strategy/baseline/carry.ts`

验收标准：

1. 每个策略都有明确的 `entry/exit/position sizing/stop` 规则。
2. 相同输入 candle 流产生一致信号序列。

## Phase 2（4-7 天）：严格回测引擎（成本与执行现实化）

新增模块建议：

1. `src/backtest/engine.ts`
2. `src/backtest/models/fee.ts`
3. `src/backtest/models/slippage.ts`
4. `src/backtest/models/latency.ts`
5. `src/backtest/models/funding.ts`
6. `src/backtest/reporting.ts`

必须纳入：

1. 手续费（maker/taker）
2. 滑点（按波动率或价差模型）
3. 延迟（信号 -> 下单 -> 成交的 bar 偏移）
4. 资金费率（永续合约）

验收标准：

1. 输出净值曲线 + 回撤曲线 + 成本拆解（gross/net/cost）。
2. 输出敏感性矩阵：费用上浮、滑点上浮、延迟上浮后的收益退化。

## Phase 3（3-5 天）：Walk-forward 与样本外验证

新增模块建议：

1. `src/backtest/walk-forward.ts`
2. `src/backtest/splits.ts`

流程要求：

1. 固定滚动窗口（train/validate/test）
2. 每个窗口单独调参与评估
3. 汇总 OOS 指标和退化率

验收标准：

1. OOS 相对 IS 退化率可量化（例如 Sharpe 退化 <= 40%）。
2. 不满足阈值的策略禁止进入纸交易阶段。

## Phase 4（2-4 周）：纸交易与实盘迁移评估

执行方式：

1. 不开真实下单权限，仅做 paper 模式（或本地模拟成交）。
2. 跟踪“回测预测 vs 纸交易真实”偏差。

新增指标：

1. 订单成交偏差（预期价 vs 实际价）
2. 滑点偏差
3. 信号延迟偏差
4. 盈亏分布漂移

验收标准：

1. 连续若干周偏差可控后，才允许小资金实盘试运行。

## Phase 5（3-5 天）：硬风控门禁 + 熔断 + Kill Switch

新增配置建议：

1. `data/config/risk.json`
   - `maxRiskPerTrade`
   - `maxDailyLoss`
   - `maxOpenPositions`
   - `maxLeverage`
   - `consecutiveLossLimit`
   - `killSwitch`

执行点建议：

1. 下单前门禁：`src/extension/crypto-trading/operation-dispatcher.ts`
2. 运行时监控：`src/task/heartbeat/heartbeat.ts` 或独立 risk watcher
3. 触发熔断后拒绝新单，并写事件日志（`event-log`）

验收标准：

1. 任一硬限制触发后，新开仓订单被统一拒绝。
2. kill switch 可一键切换，只保留平仓操作。

## Phase 6（持续迭代）：市场状态识别 + 策略切换创新

目标：

1. 不赌单一策略常胜，改为“状态 -> 策略权重”。
2. 在趋势、震荡、高波动、低流动性状态间切换。

最小实现：

1. 状态分类器（波动率、趋势强度、成交活跃度）
2. 策略权重表（不同状态下不同策略权重）
3. 状态切换冷却期，避免频繁抖动

验收标准：

1. 相对单策略基线，回撤显著降低且收益不劣化过多。

## 4. 稳定 vs 不稳定：你关心的“哪些值得长期做”

相对稳定（流程层）：

1. 时间序列防泄漏
2. WFO + OOS
3. 成本/滑点/延迟现实建模
4. 硬风控门禁与熔断

说明：这些是“方法学稳定”，不是“收益保证”。

相对稳定（风格层，跨周期更常见）：

1. 趋势跟随（但会阶段性深回撤）

相对不稳定（高失效风险）：

1. 单市场单参数“神策略”
2. 忽略成本后的高频换手策略
3. 未做 OOS 的复杂多因子拼接

## 5. 第一阶段执行清单（本周）

1. 固定 3 个基线策略规则与参数范围。
2. 新增回测结果目录规范与 run 配置快照。
3. 先跑一版“含手续费 + 滑点 + 延迟”的最小回测。
4. 产出首版策略对比表（收益、回撤、夏普、换手、成本占比）。

## 6. 参考资料（专家实现 / 官方文档）

执行框架与流程：

1. QuantConnect LEAN 文档（算法、现实建模、WFO、风险管理、纸交易）
   - https://www.quantconnect.com/docs/v2/writing-algorithms
   - https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/trade-fills/key-concepts
   - https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/slippage/key-concepts
   - https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/transaction-fees/key-concepts
   - https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization
   - https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/risk-management/key-concepts
   - https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/brokerages/quantconnect-paper-trading
2. Freqtrade 文档（回测、防未来函数、杠杆/资金费率、保护机制）
   - https://www.freqtrade.io/en/stable/backtesting/
   - https://www.freqtrade.io/en/stable/lookahead-analysis/
   - https://www.freqtrade.io/en/stable/leverage/
   - https://www.freqtrade.io/en/stable/plugins/
3. HftBacktest（延迟/成交仿真）
   - https://hftbacktest.readthedocs.io/
   - https://hft.readthedocs.io/en/latest/reference/order_latency_models.html
   - https://hft.readthedocs.io/en/latest/order_fill.html
4. CCXT funding 接口与交易所统一抽象
   - https://github.com/ccxt/ccxt/wiki/manual

研究与稳定性讨论：

1. AQR 趋势跟随长期证据
   - https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing
2. Time-series momentum 经典文献
   - https://www.sciencedirect.com/science/article/abs/pii/S0304405X11002613
3. Time-series momentum 稳健性争议
   - https://www.sciencedirect.com/science/article/abs/pii/S1386418116301379
4. 回测过拟合（PBO）方法
   - https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253
