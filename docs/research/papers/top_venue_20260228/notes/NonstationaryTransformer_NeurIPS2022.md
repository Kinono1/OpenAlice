# NonstationaryTransformer_NeurIPS2022

- Venue: `NeurIPS 2022`
- Source: https://arxiv.org/abs/2205.14415
- OpenAlice gate targets: `gate_pass_robust_uplift, transfer_false_ratio`

## 1) 核心问题
Transformers have shown great power in time series forecasting due to their global-range modeling ability. However, their performance can degenerate ter- ribly on non-stationary real-world data in which the joint distribution changes over time. Previous studies primarily adopt stationarization to attenuate the non- stationarity of original series for better predictability. But the stationarized series deprived of inherent non-stationarity can be less instructive for real-world bursty events forecasting. This problem, termed over-stationarization in this paper, leads Transformers to generate indistinguishable temporal attentions for different series and impedes the predictive capability of deep models. To tackle the dilemma between series predictability and model capability, we propose Non-stationary Transformers as a generic framework with two interdependent modules: Series Stationarizat

## 2) 方法机制（抓主干）
- To tackle the dilemma between series predictability and model capability, we propose Non-stationary Transformers as a generic framework with two interdependent modules: Series Stationarization and De-stationary Attention.
- Our Non-stationary Transformers framework consistently boosts mainstream Transformers by a large margin, which reduces MSE by 49.43% on Transformer, 47.34% on Informer, and 46.89% on Reformer, making them the state-of-the-art in time series forecasting.
- In this paper, we explore the effect of stationarization in time series forecasting and propose Non- stationary Transformers as a general framework, which empowers Transformer [34] and its efficient variants [19, 39, 37] with great predictive ability for real-world time series.
- The proposed framework involves two interdependent modules: Series Stationarization to increase the predictability of non- stationary series and De-stationary Attention to alleviate over-stationarization.
- Our method achieves state-of-the-art performance on six real-world benchmarks and can generalize to various Transformers for further improvement.
- By detailed analysis, we find out that current stationarization approaches will lead to the over-stationarization problem, limiting the predictive capability of Transformers. • We propose Non-stationary Transformers as a generic framework, including Series Sta- tionarization to make the series more predictable and De-stationary Attention to avoid the over-stationarization problem by re-incorporating the non-stationar

## 3) 证据与结果（正文摘录）
- Previous studies primarily adopt stationarization to attenuate the non- stationarity of original series for better predictability.
- To tackle the dilemma between series predictability and model capability, we propose Non-stationary Transformers as a generic framework with two interdependent modules: Series Stationarization and De-stationary Attention.
- Concretely, Series Stationarization unifies the statistics of each input and converts the output with restored statis- tics for better predictability.
- Our Non-stationary Transformers framework consistently boosts mainstream Transformers by a large margin, which reduces MSE by 49.43% on Transformer, 47.34% on Informer, and 46.89% on Reformer, making them the state-of-the-art in time series forecasting.
- In previous work, it is generally acknowledged to pre-process the time series by stationarization [26, 29, 17], which can attenuate the non-stationarity of raw time series for better predictability and provide more stable data distribution for deep models. ∗ Equal Contribution 36th Conference on Neural Information Processing Systems (NeurIPS 2022). Ⅰ !$ , #$ Learned Ⅱ Zoom in Attention !% , #% Ⅰ Ⅱ Ⅲ Ⅲ Non-stationary 
- Thus, how to attenuate time series non-stationarity towards better predictability and mitigate the over-stationarization problem for model capability simultaneously is the key problem to further improve the performance of forecasting.
- The proposed framework involves two interdependent modules: Series Stationarization to increase the predictability of non- stationary series and De-stationary Attention to alleviate over-stationarization.

## 4) 定量线索（含数字句）
- Our Non-stationary Transformers framework consistently boosts mainstream Transformers by a large margin, which reduces MSE by 49.43% on Transformer, 47.34% on Informer, and 46.89% on Reformer, making them the state-of-the-art in time series forecasting.
- In previous work, it is generally acknowledged to pre-process the time series by stationarization [26, 29, 17], which can attenuate the non-stationarity of raw time series for better predictability and provide more stable data distribution for deep models. ∗ Equal Contribution 36th Conference on Neural Information Processing Systems (NeurIPS 2022). Ⅰ !$ , #$ Learned Ⅱ Zoom in Attention !% , #% Ⅰ Ⅱ Ⅲ Ⅲ Non-stationary 
- Here are the details. 3 y <latexit sha1_base64="XBHSmy9y1Sv+zS5bJC+9jHwtIz0=">AAACzXicjVHLSsNAFD2Nr1pfVZdugkVwVRIRdVl0484K9oFtkSSdtkPzYjIRSq1bf8Ct/pb4B/oX3hlTUIvohCRnzr3nzNx73djnibSs15wxN7+wuJRfLqysrq1vFDe36kmUCo/VvMiPRNN1EubzkNUklz5rxoI5geuzhjs8U/HGLRMJj8IrOYpZJ3D6Ie9xz5FEXbcDRw7c3ng0uSmWrLKllzkL7AyUkK1qVHxBG11E8JAiAEMISdiHg4SeFmxYiInrYEycIMR1nGGCAmlTymKU4RA7pG+fdq2MDWmvPBOt9ugUn15BShN7pIkoTxBWp5k6nmpnxf7mPdae6m4j+r
- We repeat each experiment three times with different random seeds and report the test MSE/MAE under different prediction lengths, and the standard deviations are also provided in the Appendix C.2.
- A lower MSE/MAE indicates better performance. 4.1 Main Results Forecasting results As for multivariate forecasting results, the vanilla Transformer equipped with our framework consistently achieves state-of-the-art performance in all benchmarks and prediction lengths (Table 2).
- Notably, Non-stationary Transformer outperforms other deep models impressively on datasets characterized by high non-stationarity: under the prediction length of 336, we achieve 17% MSE reduction (0.509 → 0.421) on Exchange and 25% (2.669 → 2.010) on ILI compared to previous state-of-the-art results, which indicates that the potential of deep model is still constrained on non-stationary data.

## 5) 风险与局限
- Non-stationary Transformers: Exploring the Stationarity in Time Series Forecasting Yong Liu∗, Haixu Wu∗, Jianmin Wang, Mingsheng LongB School of Software, BNRist, Tsinghua University, China {liuyong21,whx20}@mails.tsinghua.edu.cn, {jimwang,mingsheng}@tsinghua.edu.cn arXiv:2205.14415v4 [cs.LG] 24 Nov 2023 Abstract Transformers have shown great power in time series forecasting due to their global-range modeling ability
- However, their performance can degenerate ter- ribly on non-stationary real-world data in which the joint distribution changes over time.
- To tackle the dilemma between series predictability and model capability, we propose Non-stationary Transformers as a generic framework with two interdependent modules: Series Stationarization and De-stationary Attention.
- To address the over-stationarization problem, De- stationary Attention is devised to recover the intrinsic non-stationary information into temporal dependencies by approximating distinguishable attentions learned from raw series.
- Our Non-stationary Transformers framework consistently boosts mainstream Transformers by a large margin, which reduces MSE by 49.43% on Transformer, 47.34% on Informer, and 46.89% on Reformer, making them the state-of-the-art in time series forecasting.

## 6) 对 OpenAlice 的直接改造
- 加入 non-stationary 统计特征并在高 shift 时抬高置信阈值。
