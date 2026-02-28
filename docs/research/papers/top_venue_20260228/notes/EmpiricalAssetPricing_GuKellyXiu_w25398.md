# EmpiricalAssetPricing_GuKellyXiu_w25398

- Venue: `NBER w25398 (RFS对应工作稿)`
- Source: https://www.nber.org/papers/w25398
- OpenAlice gate targets: `protocol_validity, out_of_sample_stability`

## 1) 核心问题
We perform a comparative analysis of machine learning methods for the canonical problem of empirical asset pricing: measuring asset risk premia. We demonstrate large economic gains to investors using machine learning forecasts, in some cases doubling the performance of leading regression-based strategies from the literature. We identify the best performing methods (trees and neural networks) and trace their predictive gains to allowance of nonlinear predictor interactions that are missed by other methods. All methods agree on the same set of dominant predictive signals which includes variations on momentum, liquidity, and volatility. Improved risk premium measurement through machine learning simplifies the investigation into economic mechanisms of asset pricing and highlights the value of machine learning in financial innovation. Shihao Gu Dacheng Xiu University of Chicago Booth School o

## 2) 方法机制（抓主干）
- C45,C55,C58,G11,G12 ABSTRACT We perform a comparative analysis of machine learning methods for the canonical problem of empirical asset pricing: measuring asset risk premia.
- New Haven, CT 06511 and NBER bryan.kelly@yale.edu 1 Introduction In this article, we conduct a comparative analysis of machine learning methods for finance.
- First, we provide a new set of benchmarks for the predictive accuracy of machine learning methods in measuring risk premia of the aggregate market and indi- vidual stocks.
- Interest in machine learning methods for finance has grown tremendously in both academia and industry.
- This article provides a comparative overview of machine learning methods applied to the two canonical problems of empirical asset pricing: predicting returns in the cross section and time series.
- The high-dimensional nature of machine learning methods (element (i) of this definition) enhances their flexibility relative to more traditional econometric prediction techniques.

## 3) 证据与结果（正文摘录）
- Improved risk premium measurement through machine learning simplifies the investigation into economic mechanisms of asset pricing and highlights the value of machine learning in financial innovation.
- The first is a high out-of-sample predictive R2 relative to preceding literature that is robust across a variety of machine learning specifications.
- A portfolio strategy that times the S&P 500 with neural network forecasts enjoys an annualized out-of-sample Sharpe ratio of 0.77, versus the 0.51 Sharpe ratio of a buy-and-hold investor.
- And a value-weighted long-short decile spread strategy that takes positions based on stock- level neural network forecasts earns an annualized out-of-sample Sharpe ratio of 1.35, more than doubling the performance of a leading regression-based strategy from the literature.
- Element (ii) of our machine learning definition describes refinements in implementation that emphasize stable out-of-sample performance to explicitly guard against overfit.
- At the broadest level, our main empirical finding is that machine learning as a whole has the potential to improve our empirical understanding of expected asset returns.
- It is parsimonious and simple, and comparing against this benchmark is conservative because it is highly selected (the characteristics it includes are routinely demonstrated to be among the most robust return predictors).

## 4) 定量线索（含数字句）
- NBER WORKING PAPER SERIES EMPIRICAL ASSET PRICING VIA MACHINE LEARNING Shihao Gu Bryan Kelly Dacheng Xiu Working Paper 25398 http://www.nber.org/papers/w25398 NATIONAL BUREAU OF ECONOMIC RESEARCH 1050 Massachusetts Avenue Cambridge, MA 02134 December 2018, Revised September 2019 We benefitted from discussions with Joseph Babcock, Si Chen (Discussant), Rob Engle, Andrea Frazzini, Amit Goyal (Discussant), Lasse Pederse
- The first is a high out-of-sample predictive R2 relative to preceding literature that is robust across a variety of machine learning specifications.
- A portfolio strategy that times the S&P 500 with neural network forecasts enjoys an annualized out-of-sample Sharpe ratio of 0.77, versus the 0.51 Sharpe ratio of a buy-and-hold investor.
- And a value-weighted long-short decile spread strategy that takes positions based on stock- level neural network forecasts earns an annualized out-of-sample Sharpe ratio of 1.35, more than doubling the performance of a leading regression-based strategy from the literature.
- In our sample, which is longer and wider (more observations in terms of both dates and stocks) than that studied in Lewellen (2015), the out-of-sample R2 from the benchmark model is 0.16% per month for the panel of individual stock returns.
- When we expand the OLS panel model to include our set of 900+ predictors, predictability vanishes immediately—the R2 drops deeply into negative territory.

## 5) 风险与局限
- With enhanced flexibility, however, comes a higher propensity of overfitting the data.
- We select a set of candidate models that are potentially well suited to address the three empirical challenges outlined above.
- These traditional methods have potentially severe limitations that more advanced statistical tools in machine learning can help overcome.
- The challenge is how to assess the incremental predictive content of a newly proposed predictor while jointly controlling for the gamut of extant signals (or, relatedly, handling the multiple comparisons and false discovery problem).
- In this and the following subsections, we introduce nonparametric models of g(·) with increasing degrees of flexibility, 13 See White (1980) for a discussion of limitations of linear models as first-order approximations. 14 each complemented by regularization methods to mitigate overfit.

## 6) 对 OpenAlice 的直接改造
- 统一 nested walk-forward + purged split，禁止窗口内反复调参。
