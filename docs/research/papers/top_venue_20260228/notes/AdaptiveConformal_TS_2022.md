# AdaptiveConformal_TS_2022

- Venue: `2022`
- Source: https://arxiv.org/abs/2202.07282
- OpenAlice gate targets: `transfer_false_ratio, gate_pass_robust_delta`

## 1) 核心问题
padopoulos et al., 2002) is a promising framework to over- come both issues. It is a general procedure to build predictive Uncertainty quantification of predictive models is crucial intervals for any (black box) predictive model, such as neu- in decision-making problems. Conformal prediction is a ral networks, which are valid (i.e. achieve nominal marginal general and theoretically sound answer. However, it requires coverage) in finite sample and without any distributional exchangeable data, excluding time series. While recent assumptions except that the data are exchangeable. works tackled this issue, we argue that Adaptive Conformal Inference (ACI, Gibbs and Candès, 2021), developed for Thereby, CP has received increasing attention lately, favored distribution-shift time series, is a good procedure for time by the development of split conformal prediction (SCP, Lei series with general

## 2) 方法机制（抓主干）
- Adaptive Conformal Predictions for Time Series Margaux Zaffran* ,1,2,3 , Aymeric Dieuleveut3 , Olivier Féron1,4 , Yannig Goude1 , and Julie Josse2,5 1 Eletrcicité De France R&D, Palaiseau, France 2 INRIA Sophia-Antipolis, Montpellier, France 3 CMAP, Ecole Polytechnique, IP Paris, Palaiseau, France 4 FiME, Palaiseau, France 5 IDESP, Montpellier, France arXiv:2202.07282v1 [stat.ML] 15 Feb 2022 February 16, 2022 Abstr
- We propose a parameter-free samples (xi , yi ) ∈ Rd × R, i ∈ J1, nK, realizations of method, AgACI, that adaptively builds upon ACI based on random variables (X1 , Y1 ) . . . , (Xn , Yn ), and that we aim online expert aggregation.
- Therefore, set in two sets Tr, Cal ⊂ J1, nK, to create a proper training an accurate electricity price forecasting is required to stabi- set, Tr, and a calibration set, Cal.
- On the proper training lize energy production planning, gathering loads of research set a regression model µ̂ (chosen by the user) is fitted, and works as evidenced by recent substantial reviews (Weron, then used to predict on the calibration set.
- We propose to analyse ACI (Gibbs and shevskiy and Luo (2008, 2011) apply original (inductive) CP Candès, 2021) in the context of time series with general (Papadopoulos et al., 2002) to both simulated (using Auto- dependency and make the following contributions: Regressive Moving Average (ARMA) processes) and real • Relying on an asymptotic analysis of ACI’s behaviour for network traffic data and obtain valid interva
- In both studies, the validity varied greatly de- performances in terms of validity and efficiency (Section 4). pending on the markets and the underlying regression model, • We compare ACI to EnbPI and online SCP on extensive suggesting that further developments of CP and theoretical synthetic experiments and we propose an easy-to-interpret guarantees for time series are needed. visualisation combining validity and ef

## 3) 证据与结果（正文摘录）
- However, it requires coverage) in finite sample and without any distributional exchangeable data, excluding time series.
- Given a tions against competing methods that advocate for ACI’s miscoverage rate α ∈ [0, 1] fixed by the user (typically 0.1 use in time series.
- Xu tricity prices, an area where accurate predictions, but also and Xie (2021b) improve on that theory and propose a new controlled predictive intervals, are required (Section 6). algorithm, Ensemble Prediction Interval (EnbPI), adapted to To allow for better benchmarking of existing and new meth- time series by adding a sequential aspect. ods, we provide (re-)implementations in Python of all the Another case that br
- Second, 0 to improve adaptation when the data is highly shifted, an εt −1 effective miscoverage level αt , updated recursively, is used 0 200 t 400 500 520 540 t 560 580 600 600 620 640 t 660 680 700 instead of the target level α.
- Three versions of ACI are compared: scores are actually exchangeable, ACI’s validity would not γ = 0, the quantile level is not updated but the calibration improve upon SCP (known to be quasi-exactly valid), thus set Calt is; γ = 0.01 and γ = 0.05.
- Here and in the sequel, we use α = 0.1. length of the interval predicted by the non-adaptive algo- In this toy example, the coverage rate among many observa- rithm (or equivalently, γ = 0). tions is valid for γ ∈ {0.01, 0.05} (90% and 92% of points Theorem 3.1.
- For high ϕ, ACI indeed improves for a strictly posi- tive γ upon γ = 0.

## 4) 定量线索（含数字句）
- Given a tions against competing methods that advocate for ACI’s miscoverage rate α ∈ [0, 1] fixed by the user (typically 0.1 use in time series.
- Second, 0 to improve adaptation when the data is highly shifted, an εt −1 effective miscoverage level αt , updated recursively, is used 0 200 t 400 500 520 540 t 560 580 600 600 620 640 t 660 680 700 instead of the target level α.
- Here and in the sequel, we use α = 0.1. length of the interval predicted by the non-adaptive algo- In this toy example, the coverage rate among many observa- rithm (or equivalently, γ = 0). tions is valid for γ ∈ {0.01, 0.05} (90% and 92% of points Theorem 3.1.
- Assume that: (i) α ∈ Q; (ii) the scores are ex- included) but not for γ = 0 (72.6%).
- Right: γ ∗ minimizing the average length for the length by 1.59% (resp. by 3.38%) with respect to γ = 0. each ϕ (each cross has a size proportional to the number of runs for which γ ∗ was the minimizer). 3.2 AR(1) case We now consider the case of (highly) correlated residuals, that the expected length is minimal for γ = 0 and grows which happens in many practical time series applications. linearly with γ around 0.
- Then (αt , εt−1 ) is a homogeneous Markov to the optimal learning rate for a given signal, is non- Chain in R2 that admits a unique stationary distribution monotonic, (Figure 2, right).

## 5) 风险与局限
- However, it requires coverage) in finite sample and without any distributional exchangeable data, excluding time series.
- However, this assumption is not met in time adapt better to the data than classical online SCP (γ = 0). series forecasting problems.
- In both studies, a single shift in consider T0 observations (x1 , y1 ) , . . . , (xT0 , yT0 ) in Rd ×R. the distribution is considered, a major limitation for apply- The aim is to predict the response values and give predictive ing these methods to time series.
- However, the optimal learning 1X T rate then diminishes as ϕ increases.
- Increasing γ enables ACI to increase the interval’s size faster 5.3 Description of baseline methods when we do not cover, and thus to improve validity, which is achieved for high values of γ; however this also increases the We consider as baseline online sequential split conformal frequency of uninformative (infinite) intervals, as deduced prediction (OSSCP), a generalisation of SCP.

## 6) 对 OpenAlice 的直接改造
- 按 regime 维护自适应 conformal 半径，在线更新覆盖率偏差。
