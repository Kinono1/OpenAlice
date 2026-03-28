# OpenAlice G3/G4 顶会顶刊增量研究（2026-03-03）

## 一句话结论
当前不是“模型不够复杂”，而是“统计门槛 + WFO 稳定性”没有一起过线；应继续按 **检验优先** 路线推进。

## 增量证据（Codex 检索）
> 只保留和当前问题直接相关的高质量来源，并映射到可执行动作。

1. **iTransformer (ICLR 2024)**
   - 链接：`https://proceedings.iclr.cc/paper_files/paper/2024/hash/2ea18fdc667e0ef2ad82b2b4d65147ad-Abstract-Conference.html`
   - 启示：结构改进可提升时序泛化，但不等于交易显著性自动过线。
   - 动作：不直接替换主策略；先做特征/信号层对照试验，保持同一检验协议。

2. **Time-LLM (ICLR 2024)**
   - 链接：`https://proceedings.iclr.cc/paper_files/paper/2024/file/680b2a8135b9c71278a09cafb605869e-Paper-Conference.pdf`
   - 启示：跨模态重编程可扩展信息表示，但风险在于过拟合和不可解释漂移。
   - 动作：仅作为候选生成器，不进入发布门控主链。

3. **ForecastPFN (NeurIPS 2023)**
   - 链接：`https://proceedings.neurips.cc/paper_files/paper/2023/file/0731f0e65559059eb9cd9d6f44ce2dd8-Paper-Conference.pdf`
   - 启示：零样本/合成预训练强于小样本基线，但交易场景需额外稳健性验证。
   - 动作：仅做离线对照，不用于当前 G3/G4 通关路径。

4. **Time Series as Images (NeurIPS 2023)**
   - 链接：`https://proceedings.neurips.cc/paper_files/paper/2023/file/9a17c1eb808cf012065e9db47b7ca80d-Paper-Conference.pdf`
   - 启示：不规则采样建模可改善表示，但对执行噪声敏感。
   - 动作：先用于失败窗口再编码分析，不直接上交易候选。

5. **Statistical Predictions of Trading Strategies (JFEC 2025)**
   - 链接：`https://academic.oup.com/jfec/article/23/2/nbae025/7826742`
   - 启示：交易预测必须强调统计验证与可复现协议。
   - 动作：强化当前 `FDR + WFO` 的门控优先级，不以 Sharpe 单指标驱动。

6. **Asset Pricing and ML: Critical Review (Journal of Economic Surveys, 2024)**
   - 链接：`https://onlinelibrary.wiley.com/doi/10.1111/joes.12532`
   - 启示：因子/模型扩展易触发检验偏差，协议质量决定可用性。
   - 动作：限制每轮候选规模，先做可达性判断再搜索。

7. **AI Asset Pricing Models (NBER Working Paper 33351, 2025)**
   - 链接：`https://www.nber.org/system/files/working_papers/w33351/w33351.pdf`
   - 启示：AI 模型收益来自复杂表示，但交易成本与稳健性约束不可跳过。
   - 动作：保留 release-gate 硬阻断，不因模型升级而放松阈值。

8. **Technical Analysis, Spread Trading, and Data Snooping Control (IJF, 2023)**
   - 链接：`https://www.sciencedirect.com/science/article/abs/pii/S0169207021001655`
   - 启示：控制假发现后，许多规则优势明显收缩。
   - 动作：继续把 `fdrQ` 作为主瓶颈指标（当前仍远高于阈值）。

9. **Empirical Asset Pricing via ML (RFS, 2020, 基线经典)**
   - 链接：`https://academic.oup.com/rfs/article/33/5/2223/5758276`
   - 启示：ML 有价值，但需严谨 OOS 与协议治理。
   - 动作：维持“协议先于模型”的决策顺序。

## 针对当前运行的落地判断
- 最新全链路运行（`run_id=20260302T181754Z`）流程全绿，但决策仍 `NO_GO`。
- 核心硬事实：
  - `fdrQ=0.369772`（阈值 `<=0.1`，未过线）
  - `wfoFailureDensity(shift)=0.680556`（较 stable 的 `0.733333` 有改善）
- 结论：**优先继续压低 WFO 失败密度，同时攻 FDR gap；不建议立刻扩大家族复杂度。**

## 下一步（可执行）
1. 固定 `shift` 作为短期主 profile，连续 3 轮观察 `wfoFailureDensity` 趋势。
2. 每轮先跑可达性检查（`fdrQ gap`、`required DSR`），再决定是否扩候选。
3. 若连续 2 轮 `fdrQ` 无改善，暂停扩搜，转协议/样本分层修复。
