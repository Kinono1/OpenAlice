# CQR_NeurIPS2019

- Venue: `NeurIPS 2019`
- Source: https://arxiv.org/abs/1905.03222
- OpenAlice gate targets: `gate_pass_robust_ci, error_ratio`

## 1) 核心问题
Conformal prediction is a technique for constructing prediction intervals that at- tain valid coverage in finite samples, without making distributional assumptions. Despite this appeal, existing conformal methods can be unnecessarily conserva- tive because they form intervals of constant or weakly varying length across the input space. In this paper we propose a new method that is fully adaptive to het- eroscedasticity. It combines conformal prediction with classical quantile regression, inheriting the advantages of both. We establish a theoretical guarantee of valid coverage, supplemented by extensive experiments on popular regression datasets. We compare the efficiency of conformalized quantile regression to other conformal methods, showing that our method tends to produce shorter intervals.

## 2) 方法机制（抓主干）
- In this paper we propose a new method that is fully adaptive to het- eroscedasticity.
- We compare the efficiency of conformalized quantile regression to other conformal methods, showing that our method tends to produce shorter intervals. 1 Introduction In many applications of regression modeling, it is important not only to predict accurately but also to quantify the accuracy of the predictions.
- We first split the training data into two disjoint subsets, a proper training set and a calibration set.2 We fit two quantile regressors on the proper training set to obtain initial estimates of the lower and upper bounds of the prediction interval, as explained in Section 2.
- Then, using the calibration set, we conformalize and, if necessary, correct this prediction interval.
- Our method differs from the standard method of conformal prediction [3, 15], recalled in Section 3, in that we calibrate the prediction interval using conditional quantile regression, while the standard method uses only classical, conditional mean regression.
- We evaluate the statistical efficiency of our framework by comparing its miscoverage rate and average interval length with those of other methods.

## 3) 证据与结果（正文摘录）
- Candès Departments of Mathematics and of Statistics Stanford University Abstract Conformal prediction is a technique for constructing prediction intervals that at- tain valid coverage in finite samples, without making distributional assumptions.
- We establish a theoretical guarantee of valid coverage, supplemented by extensive experiments on popular regression datasets.
- First, it should provide valid coverage in finite samples, without making strong distributional assumptions, such as Gaussianity.
- Conformal prediction has the virtue of providing a nonasymptotic, distribution-free coverage guarantee.
- To ob- tain prediction intervals with, say, nominal 90% coverage, simply fit the conditional quantile function Preprint.
- On the other hand, a key strength of CQR is its rigorous control of the miscoverage rate, independent of the underlying regression algorithm.
- That is, given a desired miscoverage rate α, we ask that P{Yn+1 ∈ C(Xn+1 )} ≥ 1 − α (1) for any joint distribution PXY and any sample size n.

## 4) 定量线索（含数字句）
- To ob- tain prediction intervals with, say, nominal 90% coverage, simply fit the conditional quantile function Preprint.
- Work in progress. at the 5% and 95% levels and form the corresponding intervals.
- That is, given a desired miscoverage rate α, we ask that P{Yn+1 ∈ C(Xn+1 )} ≥ 1 − α (1) for any joint distribution PXY and any sample size n.
- Unlike the original interval, the conformalized prediction interval is guaranteed to satisfy the coverage requirement (1) regardless of the choice or accuracy of the quantile regression estimator.
- (2) 1 Source code implementing CQR is available online at https://github.com/yromano/cqr. 2 Like conformal regression, CQR has a variant that does not require data splitting. 2 𝜌% 𝑧 1−𝛼 𝛼 𝑧 Figure 1: Visualization of the pinball loss function in (6), where z = y − ŷ.
- However, it is not guaranteed to satisfy the coverage statement (3) when C(X) is replaced by the estimated interval Ĉ(Xn+1 ).

## 5) 风险与局限
- However, the validity of the estimated intervals is guaranteed only for specific models, under certain regularity and asymptotic conditions [22–24].
- However, it is not guaranteed to satisfy the coverage statement (3) when C(X) is replaced by the estimated interval Ĉ(Xn+1 ).
- A closer look at the prediction interval (8) reveals a major limitation of this procedure: the length of C(Xn+1 ) is fixed and equal to 2Q1−α (R, I2 ), independent of Xn+1 .
- (17) σ̂(Xi ) + γ Limitations of locally adaptive conformal prediction Locally adaptive conformal prediction is limited in several ways, some more important than others.
- A first limitation, already noted in [15], appears when the data is actually homoskedastic.

## 6) 对 OpenAlice 的直接改造
- 在现有概率输出后加入 CQR 区间，入场条件改为 lower_quantile > threshold。
