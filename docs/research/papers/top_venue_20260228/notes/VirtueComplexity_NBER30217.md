# VirtueComplexity_NBER30217

- Venue: `NBER w30217`
- Source: https://www.nber.org/papers/w30217
- OpenAlice gate targets: `model_capacity, out_of_sample_sharpe`

## 1) 核心问题
Much of the extant literature predicts market returns with “simple” models that use only a few parameters. Contrary to conventional wisdom, we theoretically prove that simple models severely understate return predictability compared to “complex” models in which the number of parameters exceeds the number of observations. We empirically document the virtue of complexity in US equity market return prediction. Our findings establish the rationale for modeling expected returns through machine learning. Bryan T. Kelly Kangying Zhou Yale School of Management Yale University 165 Whitney Ave. 165 Whitney Ave Ph.D. Suite New Haven, CT 06511 New Haven, CT 06511 and NBER kangying.zhou@yale.edu bryan.kelly@yale.edu Semyon Malamud Swiss Finance Institute @ EPFL Quartier UNIL-Dorigny, Extranef 213 CH - 1015 Lausanne Switzerland semyon.malamud@epfl.ch

## 2) 方法机制（抓主干）
- We use it to construct expanding neural network architectures that take the Goyal and Welch (2008) predictors as inputs and maintain the core ridge regression structure of our theory.
- An emerging literature uses machine learning methods to forecast large panels of individual stock returns or portfolios, including Rapach and Zhou (2020), Kozak et al.
- We present our main empirical results in Section 6, and Section 7 concludes.
- The expected return/leverage tradeoff in (8) is a financial decomposition of M SE analogous to its statistical decomposition into a bias/variance tradeoff.
- We present the theoretical characteri- zations of machine learning models in terms of prediction accuracy and portfolio performance.
- In this calibration, the infeasible maximum predictive R2 (that uses the true parameter values) is the dotted red line and provides a reference point.

## 3) 证据与结果（正文摘录）
- Contrary to conventional wisdom, we theoretically prove that simple models severely understate return predictability compared to “complex” models in which the number of parameters exceeds the number of observations.
- Does the approximation improvement from large P justify the statistical costs (higher variance and/or higher bias)?
- Answer: We prove that, in the high-complexity regime (P > T ), expected out-of-sample forecast accuracy and portfolio performance are strictly increasing in model complexity.
- Applying optimal shrinkage to this large P model enhances performance further (indeed, we derive the choice of shrinkage that maximizes expected out-of-sample model performance).
- As the number of regressors, P , approaches the number of data points, T , the expected out-of-sample R2 tends to negative infinity.
- In turn, its expected out-of-sample Sharpe ratio collapses to zero.
- This is commonly interpreted as overfitting: With P = T , the regression exactly fits the training data and performs poorly out-of-sample.

## 4) 定量线索（含数字句）
- As the number of regressors, P , approaches the number of data points, T , the expected out-of-sample R2 tends to negative infinity.
- When an empirical model has the same specification as the true model, we would prefer to call it correctly parameterized as opposed to over-parameterized. 4 This seemingly counterintuitive phenomenon is sometimes called “benign overfit” (Bartlett et al., 2020; Tsigler and Bartlett, 2020). 3 ridgeless least squares predictions generate positive Sharpe ratio improvements for arbitrarily high levels of model complexity.
- First, it shows that the out-of-sample R2 from a prediction model is an incomplete measure of its economic value.
- A market timer can generate significant economic profits even when the predictive R2 is negative.
- The reason is that the R2 is heavily influenced by the variance of forecasts.5 A very low out-of-sample R2 indicates a highly volatile timing strategy.
- So, as long as the timing variance is not too high (the R2 not too negative), the timing Sharpe ratio can be substantial.

## 5) 风险与局限
- However, the pseudo-inverse is defined, and it corresponds to a limiting ridge regression with infinitesimal shrinkage, or the “ridgeless” limit.
- However, the tools of random matrix theory characterize one aspect of Ψ̂—the distribution of its eigenvalues.
- However, while machine learning portfolios underperform the infeasible strategy, they can continue to generate substantial trading gains.
- However, random matrix 25 corrections make the true relationship nonlinear. 19 4.1 Expected Out-of-sample R2 To understand a model’s prediction accuracy in the high-complexity regime, we study its limiting M SE, defined as  2  M SE(z; c) = lim E Rt+1 − St0 β̂(z) |β̂(z) .
- The fundamental difference in this section is that while raising cq brings the usual statistical challenges of heavy parameterization without much data, the added complexity also brings the benefit of improving the empirical model’s approximation of the true DGP.

## 6) 对 OpenAlice 的直接改造
- 高维模型纳入 shrinkage/regularization；以 OOS Sharpe 和稳健性为准入标准。
