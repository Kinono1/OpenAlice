# PatchTST_ICLR2023

- Venue: `ICLR 2023`
- Source: https://arxiv.org/abs/2211.14730
- OpenAlice gate targets: `gate_pass_robust_uplift`

## 1) 核心问题
Published as a conference paper at ICLR 2023 A T IME S ERIES IS W ORTH 64 W ORDS : L ONG - TERM F ORECASTING WITH T RANSFORMERS Yuqi Nie1∗, Nam H. Nguyen2 ∗, Phanwadee Sinthong2 , Jayant Kalagnanam2 1 Princeton University 2 IBM Research ynie@princeton.edu, nnguyen@us.ibm.com, Gift.Sinthong@ibm.com, jayant@us.ibm.com arXiv:2211.14730v2 [cs.LG] 5 Mar 2023 A BSTRACT We propose an efficient design of Transformer-based models for multivariate time series forecasting and self-supervised representation learning. It is based on two key components: (i) segmentation of time series into subseries-level patches which are served as input tokens to Transformer; (ii) channel-independence where each channel contains a single univariate time series that shares the same embed- ding and Transformer weights across all the series. Patching design naturally has three-fold benefit: local semantic information i

## 2) 方法机制（抓主干）
- Nguyen2 ∗, Phanwadee Sinthong2 , Jayant Kalagnanam2 1 Princeton University 2 IBM Research ynie@princeton.edu, nnguyen@us.ibm.com, Gift.Sinthong@ibm.com, jayant@us.ibm.com arXiv:2211.14730v2 [cs.LG] 5 Mar 2023 A BSTRACT We propose an efficient design of Transformer-based models for multivariate time series forecasting and self-supervised representation learning.
- Depending on the design of input tokens, different variants of the Transformer architecture have been proposed.
- Autoformer (Wu et al., 2021) borrows the ideas of decomposition and auto-correlation from traditional time series analysis methods.
- Our PatchTST is illustrated in Figure 1 where the model makes use of the vanilla Transformer encoder as its core architecture.
- The input (x1 , ..., xL ) is split to M univariate series x(i) ∈ R1×L , where each of them is fed independently into the Transformer backbone according to 3 Published as a conference paper at ICLR 2023 Transformer Backbone Channel- independence Concatenate 𝑥 ∈ ℝ!×# 𝑥+ ∈ ℝ!×( 𝑥 (%) ∈ ℝ'×# , 𝑖 = 1, … , 𝑀 𝑥+ (%) ∈ ℝ'×( , 𝑖 = 1, … , 𝑀 (a) PatchTST Model Overview Reconstructed Masked Patches 𝑥$ (") ∈ ℝ$×' Output Univariat
- We propose two versions of PatchTST in Table 3.

## 3) 证据与结果（正文摘录）
- Our channel-independent patch time series Transformer (PatchTST) can improve the long-term forecasting accuracy significantly when compared with that of SOTA Transformer-based models.
- We also apply our model to self-supervised pre- training tasks and attain excellent fine-tuning performance, which outperforms supervised training on large datasets.
- Deep models have shown excellent performance not only on forecasting tasks, but also on representation learning where abstract rep- resentation can be extracted and transferred to various downstream tasks such as classification and anomaly detection to attain state-of-the-art performance.
- Unfortunately, regardless of the complicated design of Transformer-based models, it is shown in the recent paper (Zeng et al., 2022) that a very simple linear model can outperform all of the previous models on a variety of common benchmarks and it challenges the usefulness of Transformer for time series forecasting.
- Thus constrained on the training time and GPU memory, patch design can allow the model to see the longer historical sequence, which can significantly improve the forecasting performance, as demonstrated in Table 1.
- (2021) has shown that BatchNorm outperforms LayerNorm in time series Transformer. 5 Published as a conference paper at ICLR 2023 4 E XPERIMENTS 4.1 L ONG - TERM T IME SERIES FORECASTING Datasets.
- Compared with the DLinear model, PatchTST can still outperform it in general, especially on large datasets (Weather, Traffic, Electricity) and ILI dataset.

## 4) 定量线索（含数字句）
- Most of the previous works only use point-wise input tokens, or just a handcrafted information ∗ Equal contribution. 1 Published as a conference paper at ICLR 2023 Models L N patch method MSE 96 96 0.518 Running time (s) with L = 336 Channel-independent 380 96 down-sampled 0.447 Dataset w. patch w.o. patch Gain 336 336 0.397 PatchTST Traffic 464 10040 x 22 336 42 X 0.367 336 42 X self-supervised 0.349 Electricity 300
- Capability of learning from longer look-back window: Table 1 shows that by increasing look- back window L from 96 to 336, MSE can be reduced from 0.518 to 0.397.
- The model achieves better MSE score (0.447) than using the data sequence containing the most recent 96 time steps (0.518), indicating that longer look-back window conveys more important information even with the same number of input tokens.
- As evident in Table 1, MSE score is further reduced from 0.397 to 0.367 with patching when L = 336. 3.
- Our PatchTST has achieved the best MSE (0.349) in Table 1. 2 Published as a conference paper at ICLR 2023 We introduce our approach in more detail and conduct extensive experiments in the following sec- tions to conclusively prove our claims.
- The input (x1 , ..., xL ) is split to M univariate series x(i) ∈ R1×L , where each of them is fed independently into the Transformer backbone according to 3 Published as a conference paper at ICLR 2023 Transformer Backbone Channel- independence Concatenate 𝑥 ∈ ℝ!×# 𝑥+ ∈ ℝ!×( 𝑥 (%) ∈ ℝ'×# , 𝑖 = 1, … , 𝑀 𝑥+ (%) ∈ ℝ'×( , 𝑖 = 1, … , 𝑀 (a) PatchTST Model Overview Reconstructed Masked Patches 𝑥$ (") ∈ ℝ$×' Output Univariat

## 5) 风险与局限
- Unfortunately, regardless of the complicated design of Transformer-based models, it is shown in the recent paper (Zeng et al., 2022) that a very simple linear model can outperform all of the previous models on a variety of common benchmarks and it challenges the usefulness of Transformer for time series forecasting.
- However, a single time step does not have semantic meaning like a word in a sentence, thus extracting local semantic information is essential in analyzing their connections.
- However, simply extending L comes at the cost of larger memory and computational usage.
- However, most of the models use point-wise attention, which ignores the importance of patches.
- However, although people have made attempts on Transformer-based models like time series Transformer (TST) (Zerveas et al., 2021) and TS-TCC (Eldele et al., 2021), the potential is still not fully realized yet. 3 P ROPOSED M ETHOD 3.1 M ODEL S TRUCTURE We consider the following problem: given a collection of multivariate time series samples with look- back window L : (x1 , ..., xL ) where each xt at time step t is a 

## 6) 对 OpenAlice 的直接改造
- patch-level 时序特征并入现有训练特征集合，减少噪声敏感。
