# DeepLOB_2018

- Venue: `IEEE/2018`
- Source: https://arxiv.org/abs/1808.03668
- OpenAlice gate targets: `cost_execution, net_trim10`

## 1) 核心问题
JOURNAL OF LATEX CLASS FILES, VOL. XX, NO. XX, XXX 1 DeepLOB: Deep Convolutional Neural Networks for Limit Order Books Zihao Zhang, Stefan Zohren, and Stephen Roberts Abstract—We develop a large-scale deep learning model to everyday, it is natural to employ more modern data-driven predict price movements from limit order book (LOB) data machine learning techniques to extract such features. of cash equities. The architecture utilises convolutional filters In addition, limit order data, like any other financial time- to capture the spatial structure of the limit order books as arXiv:1808.03668v6 [q-fin.CP] 23 Jan 2020 well as LSTM modules to capture longer time dependencies. series data is notoriously non-stationary and dominated by The proposed network outperforms all existing state-of-the-art stochastics. In particular, orders at deeper levels of the LOB algorithms on the benchmark LOB d

## 2) 方法机制（抓主干）
- The architecture utilises convolutional filters In addition, limit order data, like any other financial time- to capture the spatial structure of the limit order books as arXiv:1808.03668v6 [q-fin.CP] 23 Jan 2020 well as LSTM modules to capture longer time dependencies. series data is notoriously non-stationary and dominated by The proposed network outperforms all existing state-of-the-art stochastics.
- In order to these issues are reviewed. better understand these features and to go beyond a “black In this paper we design a novel deep neural network box” model, we perform a sensitivity analysis to understand the architecture that incorporates both convolutional layers as well rationale behind the model predictions and reveal the components of LOBs that are most relevant.
- Because limit orders are arranged into different our method remarkably outperforms all existing state-of-the- levels based on their submitted prices, the evolution in time of art algorithms.
- However, there have been but unusual) patterns of activity in both price and volume within a few published works that adopt CNNs to analyse finan- the order book. cial microstructure data [34, 35, 26] and the existing CNN Outline: The remainder of the paper is as follows. architectures are rather unsophisticated and lack of thorough Section II introduces background and related work.
- We present our network architecture in Section IV archiecture can lead to better results compared with all existing and give justifications behind each component of the model.
- Overview We here detail our network architecture, which comprises k 1X three main building blocks: standard convolutional layers, an m− (t) = pt−i k i=0 Inception Module and a LSTM layer, as shown in Figure 3. k (2) The main idea of using CNNs and Inception Modules is to 1X automate the process of feature extraction as it is often difficult m+ (t) = pt+i k i=1 in financial applications since financial data is notorio

## 3) 证据与结果（正文摘录）
- The architecture utilises convolutional filters In addition, limit order data, like any other financial time- to capture the spatial structure of the limit order books as arXiv:1808.03668v6 [q-fin.CP] 23 Jan 2020 well as LSTM modules to capture longer time dependencies. series data is notoriously non-stationary and dominated by The proposed network outperforms all existing state-of-the-art stochastics.
- Other problems, quotes from the London Stock Exchange and the model delivers such as auction and dark pools [6], also add additional difficul- a remarkably stable out-of-sample prediction accuracy for a variety of instruments.
- The ability to extract robust as Long Short-Term Memory (LSTM) units to predict future features which translate well to other instruments is an important stock price movements in large-scale high-frequency LOB property of our model which has many other applications. data.
- Because limit orders are arranged into different our method remarkably outperforms all existing state-of-the- levels based on their submitted prices, the evolution in time of art algorithms.
- While it is a valuable benchmark set, multiple levels of the LOB on both the buy and sell sides. it is arguable not sufficient to fully verify the robustness of an A LOB is a complex dynamic environment with high di- algorithm.
- This the problem of overfitting to backtest data, we carefully opti- leads to a range of Markov-like models with stochastic driving mise any hyper-parameter on a separate validation set before terms, such as the vector autoregressive model (VAR) [4] or moving to the out-of-sample test set.
- Our model delivers robust the autoregressive integrated moving average model (ARIMA) out-of-sample prediction accuracy across stocks over a test [5].

## 4) 定量线索（含数字句）
- These actions often take place deep The FI-2010 dataset [1] adopts the method in Equation 3 in a LOB and it is seen [7] that more than 90% of orders end and we directly used their labels for fair comparison to other in cancellation rather than matching, therefore practitioners methods.
- In addition, the work of [53] to real prices as smoothing is only applied to future prices. suggests that the best ask and best bid (L1-Ask and L1-Bid) This is essentially detrimental for designing trading algorithms contribute most to the price discovery and the contribution as signals are not consistent here leading to many redundant of all other levels is considerably less, estimated at as little trading actions t
- XX, XXX 7 Table I Table II S ETUP 1: E XPERIMENT R ESULTS FOR THE FI-2010 DATASET S ETUP 2: E XPERIMENT R ESULTS FOR THE FI-2010 DATASET Model Accuracy % Precision % Recall % F1 % Model Accuracy % Precision % Recall % F1 % Prediction Horizon k = 10 Prediction Horizon k = 10 RR [1] 48.00 41.80 43.50 41.00 SVM [28] - 39.62 44.92 35.88 SLFN [1] 64.30 51.20 36.60 32.70 MLP [28] - 47.81 60.78 48.27 LDA [22] 63.83 37.93 45
- XX, XXX 8 Table IV 0.80 E XPERIMENT R ESULTS FOR THE LSE DATASET 0.75 0.70 Accuracy Prediction Horizon Accuracy % Precision % Recall % F1 % Results on LLOY, BARC, TSCO, BT and VOD 0.65 0.60 k=20 70.17 70.17 70.17 70.15 k=20 k=50 63.93 63.43 63.93 63.49 0.55 k=50 k=100 61.52 60.73 61.52 60.65 0.50 k=100 Results on Transfer Learning (GLEN, HSBC, CNA, BP, ITV) LLOY BARC TSCO BT VOD Stock k=20 68.62 68.64 68.63 68.48 k=5

## 5) 风险与局限
- The architecture utilises convolutional filters In addition, limit order data, like any other financial time- to capture the spatial structure of the limit order books as arXiv:1808.03668v6 [q-fin.CP] 23 Jan 2020 well as LSTM modules to capture longer time dependencies. series data is notoriously non-stationary and dominated by The proposed network outperforms all existing state-of-the-art stochastics.
- I NTRODUCTION In order to avoid the limitations of handcrafted features, we use a so-called Inception Module [9] to wrap convolutional and I N today’s competitive financial world more than half of the markets use electronic Limit Order Books (LOBs) [2] to record trades [3].
- However, the FI-2010 dataset is only made up a LOB represents a multi-dimensional problem with elements of 10 consecutive days of down-sampled pre-normalised data representing the numerous prices and order volumes/sizes at from a less liquid market.
- However, given As well as presenting results on out-of-sample data (in a the billions of electronic market quotes that are generated timing sense) from stocks used to form the training set, we also test our model on out-of-sample (in both timing and The authors are with the Oxford-Man Institute of Quantitative Finance, data stream sense) stocks that are not part of the training set.
- XX, XXX 2 number of possibilities that we consider for future work.

## 6) 对 OpenAlice 的直接改造
- 执行层引入 LOB proxy 分数，作为滑点高风险时 veto 信号。
