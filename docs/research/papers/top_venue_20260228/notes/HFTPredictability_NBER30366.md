# HFTPredictability_NBER30366

- Venue: `NBER w30366`
- Source: https://www.nber.org/papers/w30366
- OpenAlice gate targets: `regime_detection, cost_execution`

## 1) 核心问题
NBER WORKING PAPER SERIES HOW AND WHEN ARE HIGH-FREQUENCY STOCK RETURNS PREDICTABLE? Yacine Aït-Sahalia Jianqing Fan Lirong Xue Yifeng Zhou Working Paper 30366 http://www.nber.org/papers/w30366 NATIONAL BUREAU OF ECONOMIC RESEARCH 1050 Massachusetts Avenue Cambridge, MA 02138 August 2022 We are grateful to seminar and conference participants at Columbia University, SoFiE 2021 Summer School, the Econometric Society, and the 2021 ICSA Applied Statistics Symposium, for comments and suggestions. The views expressed herein are those of the authors and do not necessarily reflect the views of the National Bureau of Economic Research. NBER working papers are circulated for discussion and comment purposes. They have not been peer-reviewed or been subject to the review by the NBER Board of Directors that accompanies official NBER publications. © 2022 by Yacine Aït-Sahalia, Jianqing Fan, Lirong Xue

## 2) 方法机制（抓主干）
- C45,C53,C58,G12,G14,G17 ABSTRACT This paper studies the predictability of ultra high-frequency stock returns and durations to relevant price, volume and transactions events, using machine learning methods.
- On the other hand, machine learning methods are not designed to estimate a model in an econometric setting, but are well suited to generating predictions (see, e.g., Mullainathan and Spiess (2017)).
- Among the machine learning methods we consider, such as neural networks and random forests, the specific method employed generally makes little difference to the outcome provided the methods are trained to the same data and fine-tuned to a comparable degree.
- Each problem is tested with different machine learning methods over different time horizons and clocks, including calendar, trade, and volume clocks.
- Finally, we check the robustness of the results to using different machine learning methods and tuning algorithms, determine how predictability varies at different times of day, the relative value of the two subtypes of data (trades and quotes), as well as the incremental value of supplementing the data on a given stock with data from other (correlated) stocks for the different prediction objectives.
- Benchmark dataset for mid-price forecasting of limit order book data with machine learning methods.

## 3) 证据与结果（正文摘录）
- C45,C53,C58,G12,G14,G17 ABSTRACT This paper studies the predictability of ultra high-frequency stock returns and durations to relevant price, volume and transactions events, using machine learning methods.
- We find that, contrary to low frequency and long horizon returns, where predictability is rare and inconsistent, predictability in high frequency returns and durations is large, systematic and pervasive over short horizons.
- We identify the relevant predictors constructed from trades and quotes data and examine what determines the variation in predictability across different stock's own characteristics and market environments.
- Next, we compute how the predictability improves with the timeliness of the data on a scale of milliseconds, providing a valuation of each millisecond gained.
- Finally, we simulate the impact of getting an (imperfect) peek at the incoming order flow, a look ahead ability that is often attributed to the fastest high frequency traders, in terms of improving the predictability of the following returns and durations.
- Introduction Low frequency predictability of asset returns over medium to long horizons has been extensively studied and hotly debated in the literature: classical examples of the two sides of the debate are Fama (1970) and Malkiel (1973) vs.
- To the extent that such predictability is present in the data, the empirical evidence suggests that it is overall relatively small and diffi- cult to pin down, and depends heavily upon the stocks or sectors studied, the predictor variables included, the horizon and time periods considered as well as the methodology employed.

## 4) 定量线索（含数字句）
- With minimal algorithm tuning, for the median stock in the sample, a 10.5% out-of-sample R2 for predicting 5-second returns can be achieved using merely past trade and quote data and an accuracy of 64% for predicting the direction of the next trade.
- When predicting the duration till the next 10 trades, the median out-of-sample R2 is 9.8%.
- These aspects, together with fixed effects for dates and stocks, explain nearly three quarters of the variability of 5-second return R2 s.
- We show that approximately 80% of the overall predictability is achieved by relying on the most recent 10 milliseconds, 10 trans- actions or 10 lots transacted.
- Such ability to “look ahead” at the incoming flow, even limited to an imperfect sign prediction, is able to boost 5-second return R2 from 14.0% up to 27.1% and the price direction accuracy from 68.3% up to 79.0%.
- The daily beta of the stock is estimating by regressing the stock’s 15 second returns on the 15 second returns of SPY (an ETF tracking the S&P500 index) and R2 is the coefficient of determination in this regression.4 The turnover rate is the ratio of traded volume multiplied by the daily closing price over market capitalization.

## 5) 风险与局限
- However, the normalizing number R̄(∆, M ) is very close to zero since the time horizon is very short. 2.2.4 Transaction duration At time T ∈ D, with span ∆ and clock M ∈ {transaction, volume}, we define the duration variable as: n o Duration(T, ∆, M ) = argmaxt∈D t ∈ Intforward (T, ∆, M) − T.
- However, compared to Figure 2, there are some differences shown in the figure.
- The predictor variables identified by LASSO as important for duration prediction are however very different than those identified for predicting returns.
- Third, is there additional predictability to be obtained from being able to look ahead, however briefly and imperfectly, at the incoming order flow? 6.1 The Predictability Lifespan We have quantified in previous sections the predictability of returns, trade direction and durations.
- This is possibly due to a bias variance trade-off, since the average return in the benchmark becomes less noisy as more transactions are included, while additional returns included in the averaging become less and less predictable.

## 6) 对 OpenAlice 的直接改造
- 将可预测性状态（高频事件驱动）映射到 execution/risk gating。
