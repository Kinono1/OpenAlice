# Autoformer_NeurIPS2021

- Venue: `NeurIPS 2021`
- Source: https://arxiv.org/abs/2106.13008
- OpenAlice gate targets: `gate_pass_robust_uplift`

## 1) 核心问题
Extending the forecasting time is a critical demand for real applications, such as extreme weather early warning and long-term energy consumption planning. This paper studies the long-term forecasting problem of time series. Prior Transformer- based models adopt various self-attention mechanisms to discover the long-range dependencies. However, intricate temporal patterns of the long-term future prohibit the model from finding reliable dependencies. Also, Transformers have to adopt the sparse versions of point-wise self-attentions for long series efficiency, resulting in the information utilization bottleneck. Going beyond Transformers, we design Auto- former as a novel decomposition architecture with an Auto-Correlation mechanism. We break with the pre-processing convention of series decomposition and renovate it as a basic inner block of deep models. This design empowers Autoformer wit

## 2) 方法机制（抓主干）
- Autoformer: Decomposition Transformers with Auto-Correlation for Long-Term Series Forecasting Haixu Wu, Jiehui Xu, Jianmin Wang, Mingsheng Long (B) School of Software, BNRist, Tsinghua University, China {whx20,xjh20}@mails.tsinghua.edu.cn, {jimwang,mingsheng}@tsinghua.edu.cn arXiv:2106.13008v5 [cs.LG] 7 Jan 2022 Abstract Extending the forecasting time is a critical demand for real applications, such as extreme weathe
- Going beyond Transformers, we design Auto- former as a novel decomposition architecture with an Auto-Correlation mechanism.
- We break with the pre-processing convention of series decomposition and renovate it as a basic inner block of deep models.
- This design empowers Autoformer with progressive decomposition capacities for complex time series.
- To reason about the intricate temporal patterns, we try to take the idea of decomposition, which is a standard method in time series analysis [1, 33].
- This common usage limits the capabilities of decomposition and overlooks the potential future interactions among decomposed components.

## 3) 证据与结果（正文摘录）
- Auto-Correlation outperforms self-attention in both efficiency and accuracy.
- In long-term forecasting, Autoformer yields state- of-the-art accuracy, with a 38% relative improvement on six benchmarks, covering five practical applications: energy, traffic, economics, weather and disease.
- While performance is significantly improved, these models still utilize the point-wise representation aggregation.
- Thus, in the process of efficiency improvement, they will sacrifice the information utilization because of the sparse point-wise connections, resulting in a bottleneck for long-term forecasting of time series. 35th Conference on Neural Information Processing Systems (NeurIPS 2021).
- Autoformer achieves the state-of-the-art accuracy on six benchmarks.
- Our mechanism is beyond previous self-attention family and can simultaneously benefit the computation efficiency and information utilization. • Autoformer achieves a 38% relative improvement under the long-term setting on six bench- marks, covering five real-world applications: energy, traffic, economics, weather and disease. 2 Related Work 2.1 Models for Time Series Forecasting Due to the immense importance of time 
- Note that these methods are based on the vanilla Transformer and try to improve the self-attention mechanism to a sparse version, which still follows the point-wise dependency and aggregation.

## 4) 定量线索（含数字句）
- In long-term forecasting, Autoformer yields state- of-the-art accuracy, with a 38% relative improvement on six benchmarks, covering five practical applications: energy, traffic, economics, weather and disease.
- Our mechanism is beyond previous self-attention family and can simultaneously benefit the computation efficiency and information utilization. • Autoformer achieves a 38% relative improvement under the long-term setting on six bench- marks, covering five real-world applications: energy, traffic, economics, weather and disease. 2 Related Work 2.1 Models for Time Series Forecasting Due to the immense importance of time 
- Models Autoformer Informer[48] LogTrans[26] Reformer[23] LSTNet[25] LSTM[17] TCN[4] Metric MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE 96 0.255 0.339 0.365 0.453 0.768 0.642 0.658 0.619 3.142 1.365 2.041 1.073 3.041 1.330 ETT∗ 192 0.281 0.340 0.533 0.563 0.989 0.757 1.078 0.827 3.154 1.369 2.249 1.112 3.072 1.339 336 0.339 0.372 1.363 0.887 1.334 0.872 1.549 0.972 3.160 1.369 2.568 1.238 3.105 1.348 720 0
- Models Autoformer N-BEATS[29] Informer[48] LogTrans[26] Reformer[23] DeepAR[34] Prophet[39] ARIMA[1] Metric MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE MSE MAE 96 0.065 0.189 0.082 0.219 0.088 0.225 0.082 0.217 0.131 0.288 0.099 0.237 0.287 0.456 0.211 0.362 ETT 192 0.118 0.256 0.120 0.268 0.132 0.283 0.133 0.284 0.186 0.354 0.154 0.310 0.312 0.483 0.261 0.406 336 0.154 0.305 0.226 0.370 0.180 0.336 0.201
- Especially, under the input-96-predict-336 setting, compared to previous state-of-the-art results, Autoformer gives 74% (1.334→0.339) MSE reduction in ETT, 18% (0.280→0.231) in Electricity, 61% (1.357→0.509) in Exchange, 15% (0.733→0.622) in Traffic and 21% (0.455→0.359) in Weather.
- For the input- 36-predict-60 setting of ILI, Autoformer makes 43% (4.882→2.770) MSE reduction.

## 5) 风险与局限
- However, intricate temporal patterns of the long-term future prohibit the model from finding reliable dependencies.
- However, the forecasting task is extremely challenging under the long-term setting.
- However, under the forecasting context, it can only be used as the pre-processing of past series because the future is unknown [20].
- ARIMA [7, 6] tackles the forecasting problem by transforming the non-stationary process to stationary through differencing.
- However, applying self-attention to long-term time series forecasting is computationally prohibitive because of the quadratic complexity of sequence length L in both memory and time.

## 6) 对 OpenAlice 的直接改造
- 引入 trend/seasonal 分解特征用于策略分层决策。
