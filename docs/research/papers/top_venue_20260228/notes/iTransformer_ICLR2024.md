# iTransformer_ICLR2024

- Venue: `ICLR 2024`
- Source: https://openreview.net/forum?id=JePfAI8fah
- OpenAlice gate targets: `gate_pass_robust_uplift, gate_pass_robust_ci`

## 1) 核心问题
Published as a conference paper at ICLR 2024 I T RANSFORMER : I NVERTED T RANSFORMERS A RE E FFECTIVE FOR T IME S ERIES F ORECASTING Yong Liu∗, Tengge Hu∗, Haoran Zhang∗, Haixu Wu, Shiyu Wang§ , Lintao Ma§ , Mingsheng LongB School of Software, BNRist, Tsinghua University, Beijing 100084, China § Ant Group, Hangzhou, China {liuyong21,htg21,z-hr20,whx20}@mails.tsinghua.edu.cn {weiming.wsy,lintao.mlt}@antgroup.com, mingsheng@tsinghua.edu.cn A BSTRACT The recent boom of linear forecasting models questions the ongoing passion for architectural modifications of Transformer-based forecasters. These forecasters leverage Transformers to model the global dependencies over temporal tokens of time series, with each token formed by multiple variates of the same timestamp. However, Transformers are challenged in forecasting series with larger lookback windows due to performance degradation and computa

## 2) 方法机制（抓主干）
- In this work, we reflect on the competent duties of Transformer components and repurpose the Transformer architecture without any modification to the basic components.
- We propose iTransformer that simply applies the attention and feed-forward network on the inverted dimensions.
- Transformer embeds the temporal token, which contains the multivariate representation of each time step. iTransformer embeds each series independently to the variate token, such that the attention mod- ule depicts the multivariate correlations and the feed-forward network encodes series representations. information is ever more highlighted by recent research that explicitly models multivariate correla- tions to achie
- Our contributions lie in three aspects: • We reflect on the architecture of Transformer and refine that the competent capability of native Transformer components on multivariate time series is underexplored. • We propose iTransformer that regards independent time series as tokens to capture multivari- ate correlations by self-attention and utilize layer normalization and feed-forward network modules to learn better s
- We extensively analyze the inverted modules and architecture choices, indicating a promising direction for the future improvement of Transformer-based forecasters. 2 Published as a conference paper at ICLR 2024 2 R ELATED W ORK With the progressive breakthrough made in natural language processing and computer vision areas, elaboratively designed Transformer variants are proposed to tackle ubiquitous time series forec
- Through a systematical review of Transformer-based forecasters, we conclude that existing modifi- cations can be divided into four categories by whether to modify the component and architecture.

## 3) 证据与结果（正文摘录）
- The iTransformer model achieves state-of-the-art on challenging real-world datasets, which further empowers the Transformer family with promoted performance, generalization ability across differ- ent variates, and better utilization of arbitrary lookback windows, making it a nice alternative as the fundamental backbone of time series forecasting.
- Experimentally, the proposed iTransformer achieves state-of-the-art performance on real-world forecasting benchmarks shown in Figure 1 and surprisingly tackles the pain points of Transformer-based forecasters.
- Our contributions lie in three aspects: • We reflect on the architecture of Transformer and refine that the competent capability of native Transformer components on multivariate time series is underexplored. • We propose iTransformer that regards independent time series as tokens to capture multivari- ate correlations by self-attention and utilize layer normalization and feed-forward network modules to learn better s
- We extensively analyze the inverted modules and architecture choices, indicating a promising direction for the future improvement of Transformer-based forecasters. 2 Published as a conference paper at ICLR 2024 2 R ELATED W ORK With the progressive breakthrough made in natural language processing and computer vision areas, elaboratively designed Transformer variants are proposed to tackle ubiquitous time series forec
- It pays more attention to the inherent processing of time series, such as Stationarization (Liu et al., 2022b), Channel Independence, and Patching (Nie et al., 2023), which bring about consistently improved performance.
- It records the minute- sampled server load of Alipay online transaction application with hundreds of variates, where we consistently outperform other baselines.
- Besides, PatchTST as the previous state-of-the-art, fails in many cases of PEMS, which can stem from the extremely fluctuating series of the dataset, and the patching mechanism of PatchTST may lose focus on specific locality to handle rapid fluctuation.

## 4) 定量线索（含数字句）
- Published as a conference paper at ICLR 2024 I T RANSFORMER : I NVERTED T RANSFORMERS A RE E FFECTIVE FOR T IME S ERIES F ORECASTING Yong Liu∗, Tengge Hu∗, Haoran Zhang∗, Haixu Wu, Shiyu Wang§ , Lintao Ma§ , Mingsheng LongB School of Software, BNRist, Tsinghua University, Beijing 100084, China § Ant Group, Hangzhou, China {liuyong21,htg21,z-hr20,whx20}@mails.tsinghua.edu.cn {weiming.wsy,lintao.mlt}@antgroup.com, ming
- Average results (MSE) are layers, which can be traced back to statistical forecasters (Box & reported following TimesNet (2023).
- Full results are listed in Appendix F.4. iTransformer RLinear PatchTST Crossformer TiDE TimesNet DLinear SCINet FEDformer Stationary Autoformer Models (Ours) (2023) (2023) (2023) (2023) (2023) (2023) (2022a) (2022) (2022b) (2021) Metric MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE ECL 0.178 0.270 0.219 0.298 0.205 0.290 0.244 0.334 0.251 0.344 0.192 0.295 0.212 0.300 0.268 0
- Overall, it achieves averaged 38.9% promotion on Transformer, 36.1% on Reformer, 28.5% on Informer, 16.8% on Flowformer and 32.2% on Flashformer, revealing the previous improper usage of the Transformer architecture on time series forecasting.
- Transformer Reformer Informer Flowformer Flashformer Models (2017) (2020) (2021) (2022) (2022) Metric MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE Original 0.277 0.372 0.338 0.422 0.311 0.397 0.267 0.359 0.285 0.377 ECL +Inverted 0.178 0.270 0.208 0.301 0.216 0.311 0.210 0.293 0.206 0.291 Promotion 35.6% 27.4% 38.4% 28.7% 30.5% 21.6% 21.3% 18.6% 27.8% 22.9% Original 0.665 0.363 0.741 0.422 0.764 0.416 0.750 0.421 0.658 0.
- We partition the variates of each dataset into five folders, train models with only 20% of variates of one folder, and directly forecast all variates without fine-tuning.

## 5) 风险与局限
- However, Transformers are challenged in forecasting series with larger lookback windows due to performance degradation and computation explosion.
- Besides, the embedding for each temporal token fuses multiple variates that represent potential delayed events and distinct physical measurements, which may fail in learning variate-centric representations and result in meaningless attention maps.
- Code is avail- able at this repository: https://github.com/thuml/iTransformer. 1 I NTRODUCTION Transformer (Vaswani et al., 2017) has achieved tremendous suc- 0.38 ETT 0.12 M PE cess in natural language processing (Brown et al., 2020) and S computer vision (Dosovitskiy et al., 2021), growing into the foun- 0.91 0.22 dation model that follows the scaling law (Kaplan et al., 2020). 1.42 0.32 Inspired by the immense suc
- Nevertheless, with the rapid emergence of linear forecasters (Oreshkin et al., 2019; Zeng et al., 2023; Das et al., 2023; Liu et al., 2023), the impressive performance and efficiency continuously challenge this direction.
- However, we find the approach on the numerical modality can be less instructive for 3 Published as a conference paper at ICLR 2024 Output (d) (c) Fe Features 𝑥−µ at 𝑥! = Projection ur es σ TrmBlock Variate LayerNorm + µ σ Variate Temporal LayerNorm Feed-forward Dense Act & Drop Dense L× LayerNorm (a) (b) + Query Multivariate Multivariate Attention MatMul Scale Correlations θ Variate Map Q K V Key Raw Embedding Embedd

## 6) 对 OpenAlice 的直接改造
- 新增 iTransformer 蒸馏特征头，和当前模型做 stacking + 温度缩放。
