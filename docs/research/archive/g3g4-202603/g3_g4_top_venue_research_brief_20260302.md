# OpenAlice G3/G4 研究简报（顶会顶刊）— 2026-03-02

## 1) 决策问题（Research-to-Decision）

当前问题不是“回测 Sharpe 低”，而是：

- 在保持 `G3/G4` 阈值不放松的前提下，如何让策略在**统计显著性 + 数据挖掘偏差控制 + WFO 稳定性**上同时过线。

当前最新运行（`iter-r7-fdr-feasibility`）关键事实：

- `meanPbo = 0.157143`（已达标，<= 0.2）
- `meanDsrProbability = 0.660012`（已达标，>= 0.5）
- `fdrQ = 0.369772`（未达标，> 0.1）
- `releaseGateFailedChecks = {wfo: 3}`
- `G3/G4 = fail/fail`

新增 FDR 可达性诊断给出的硬事实：

- 在 `alpha=0.1`、`candidateCount=3` 下，rank-1 要过 `q<=0.1`，需 `p<=0.033333`，即 `DSR probability >= 0.966667`。
- 当前冠军 `T43`：`dsrProbability=0.679985`，差距 `0.286682`。

结论：当前失败的主瓶颈是 **FDR + WFO**，不是单纯均值指标（PBO/DSR）不足。

## 2) 顶会顶刊证据（按“方法本质”分组）

### A. 数据挖掘偏差 / 多重检验（本质：防止“选出来的赢家”是偶然）

1. White (2000), *Econometrica*：Reality Check，明确处理数据重用与策略筛选后的虚假优越性问题。  
   https://www.econometricsociety.org/publications/econometrica/2000/09/01/reality-check-data-snooping

2. Benjamini & Hochberg (1995), *JRSS-B*：提出 FDR 控制（BH），把“多重检验后的假阳性比例”作为核心约束。  
   https://academic.oup.com/jrsssb/article-abstract/57/1/289/7035855

3. Hansen, Lunde, Nason (2011), *Econometrica*：Model Confidence Set，强调应输出“可置信模型集合”，而非单一赢家。  
   https://pure.au.dk/portal/en/publications/the-model-confidence-set

4. Bailey & López de Prado (2014), *Journal of Portfolio Management*：Deflated Sharpe Ratio，修正试验次数与分布偏态对 Sharpe 的夸大。  
   https://www.pm-research.com/content/iijpormgmt/40/5/94

5. Bailey et al. (2016/2017), *Journal of Computational Finance*：PBO/CSCV 框架，量化“回测过拟合概率”。  
   https://www.risk.net/journal-of-computational-finance/volume-20-number-4-april-2017

### B. 资产定价与预测实证（本质：可预测性弱信号 + 非线性交互 + 严格 OOS）

6. Harvey, Liu, Zhu (2016), *Review of Financial Studies*：因子挖掘中多重检验严重，显著性门槛应显著提高。  
   https://academic.oup.com/rfs/article-abstract/29/1/5/1843824

7. Gu, Kelly, Xiu (2020), *Review of Financial Studies*：ML 能提升预测，但收益主要来自非线性交互与正则化，且需严格 OOS 稳定性。  
   https://academic.oup.com/rfs/article-abstract/33/5/2223/5758276

8. Jensen, Kelly, Pedersen (2023, published in *Journal of Finance*; NBER WP 2021)：因子可复制性要在更广泛样本与跨市场验证。  
   https://www.nber.org/papers/w28432

9. Neuhierl & Schlusche (2011), *Journal of Financial Econometrics*：市场择时规则经 RC/SPA 等数据挖掘修正后，多数“优势”会消失。  
   https://academic.oup.com/jfec/article-abstract/9/3/550/841819

### C. 顶会时间序列建模（本质：结构改进可提升长序列预测，但不自动转化为可交易 alpha）

10. Informer (AAAI 2021)：长序列预测效率提升（ProbSparse + distilling + generative decoder）。  
    https://aaai.org/papers/11106-informer-beyond-efficient-transformer-for-long-sequence-time-series-forecasting/

11. Autoformer (NeurIPS 2021)：分解 + 自相关机制，针对长期依赖。  
    https://papers.nips.cc/paper/2021/hash/bcc0d400288793e8bdcd7c19a8ac0c2b-Abstract.html

12. FEDformer (ICML 2022)：频域增强 + 分解，强调全局趋势与效率。  
    https://proceedings.mlr.press/v162/zhou22g

13. iTransformer (ICLR 2024)：反转 token 维度以改善多变量时序表示。  
    https://proceedings.iclr.cc/paper_files/paper/2024/hash/2ea18fdc667e0ef2ad82b2b4d65147ad-Abstract-Conference.html

## 3) 本质细节（Essentials）

结合文献与当前运行证据，当前“预测能力差”的本质不是单点，而是三层耦合：

1. **检验层（Statistical Layer）**  
   你现在的主瓶颈是 `fdrQ`，而不是 PBO/均值 DSR。  
   当 `m=3`、`alpha=0.1` 时，冠军必须达到近乎苛刻的 `DSR>=0.9667` 才能过 q 门槛，这在高噪声金融序列中非常难。

2. **稳定性层（Validation Layer）**  
   最新 `releaseGateFailedChecks` 只剩 `wfo`，说明“统计层”已改善，但**跨窗口稳定性**仍不足。  
   这与文献对“样本外退化”的结论一致。

3. **建模层（Model Layer）**  
   顶会模型提供的是“拟合长期依赖能力”的工具，不是直接的交易显著性保证。  
   若没有交易成本、执行延迟、检验协议联动，模型精度提升不一定转化为 G3/G4 通过。

## 4) 继续路线（不放松 G3/G4 阈值）

### 路线判断

- 当前可行路线应是：**先修协议与样本外稳定，再扩模型家族**。  
- 仅做 `trend fast/slow` 微调，边际收益已明显衰减（你的 recent search 已验证）。

### 推荐执行顺序

Phase A（先做，协议层）：

- 固化“FDR 可达性”检查为每轮必看项（已在 breakdown 落地）。
- 增加 WFO 诊断颗粒度（按窗口输出退化分解，找出特定 regime 的系统性失败）。
- 将当前搜索从“Sharpe 优先”改为“先过滤 WFO fail，再排序 Sharpe/DSR”。

Phase B（并行，模型层）：

- 引入至少一组**非 trend 家族**但保持同等治理协议（例如轻量树模型/线性+非线性交互）。
- 明确“模型增益是否可过 FDR/WFO”，而不是只看回测收益。

Phase C（门控层）：

- 保持最终 `G3/G4` 阈值不变。
- 在研究阶段使用“候选池 -> MCS/稳定性筛选 -> 最终 hard gate”的两段式流程，避免把研究探索与发布门槛混为一步。

## 5) 当前决策结论

- **结论不是 no-decision**：方向已足够清晰。  
- 下一步不应继续盲目参数扫；应转为“WFO 稳定性优先 + 非 trend 家族最小扩展 + 维持 hard gate 不放松”。

