# Conformal_CovariateShift_ICML2020

- Venue: `ICML 2020`
- Source: https://arxiv.org/abs/1904.06019
- OpenAlice gate targets: `gate_pass_robust_delta`

## 1) 核心问题
We extend conformal prediction methodology beyond the case of exchangeable data. In particular, we show that a weighted version of conformal prediction can be used to compute distribution-free prediction intervals for problems in arXiv:1904.06019v3 [stat.ME] 6 Jul 2020 which the test and training covariate distributions differ, but the likelihood ratio between these two distributions is known—or, in practice, can be estimated accurately with access to a large set of unlabeled data (test covariate points). Our weighted extension of conformal prediction also applies more generally, to settings in which the data satisfies a certain weighted notion of exchangeability. We discuss other potential applications of our new conformal methodology, including latent variable and missing data problems.

## 2) 方法机制（抓主干）
- Conformal prediction, a framework pioneered by Vladimir Vovk and colleagues in the 1990s, provides a means for achieving this goal, relying only on exchangeablility of the training and test data.
- Corollary 1 is a special case of a more general result that we present later in Theorem 2, which extends conformal inference to a setting in which the data are what we call weighted exchangeable.
- As explained in Section 2.2, the split conformal method is simply a special case of the conformal prediction framework, where we take the score function to be S((x, y), Z) = |y − µ0 (x)|, with µ0 precomputed on a preliminary data set (X10 , Y10 ), . . . , (Xn00 , Yn00 ).

## 3) 证据与结果（正文摘录）
- Given a desired coverage rate 1 − α ∈ (0, 1), consider the problem of constructing a band C bn : Rd → {subsets of R}, based on the training data such that, for a new i.i.d. point (Xn+1 , Yn+1 ), n o P Yn+1 ∈ C bn (Xn+1 ) ≥ 1 − α, (1) where this probability is taken over the n + 1 points (Xi , Yi ), i = 1, . . . , n + 1 (the n training points and the test point).
- Importantly, the symmetry in the construction of the nonconformity scores (4) guarantees exact coverage in finite samples.
- The next theorem summarizes this coverage result.
- It gives us a recipe for distribution-free prediction intervals, with nearly exact coverage, starting from an arbitrary score function S; e.g., absolute residuals with respect to a fitted regression function from any base algorithm A, as in (3).
- The conformal prediction interval (5), defined at a point x ∈ Rd , reduces to   bn (x) = µ0 (x) ± Quantile 1 − α; |Yi − µ0 (Xi )| n ∪ {∞} ,  C i=1 (9) and by Theorem 1 it has coverage at least 1 − α, conditional on (X10 , Y10 ), . . . , (Xn00 , Yn00 ).
- This coverage result holds (x,y) (x,y) because, when we treat µ0 as fixed (meaning, condition on (X10 , Y10 ), . . . , (Xn00 , Yn00 )), the scores V1 , . . . , Vn+1 scores are exchangeable for (x, y) = (Xn+1 , Yn+1 ), as (X1 , Y1 ), . . . , (Xn+1 , Yn+1 ) are.
- As split conformal prediction can be seen as a special case of conformal prediction, in which the regression function µ0 is treated as fixed, Corollary 1 also applies to the split scenario, and guarantees that the band defined for x ∈ Rd by  Xn  w w Cn (x) = µ0 (x) ± Quantile 1 − α; b pi (x)δ|Yi −µ0 (Xi )| + pn+1 (x)δ∞ , (10) i=1 where the probabilities are as in (7), has coverage at least 1 − α, conditional on (X1

## 4) 定量线索（含数字句）
- Given a desired coverage rate 1 − α ∈ (0, 1), consider the problem of constructing a band C bn : Rd → {subsets of R}, based on the training data such that, for a new i.i.d. point (Xn+1 , Yn+1 ), n o P Yn+1 ∈ C bn (Xn+1 ) ≥ 1 − α, (1) where this probability is taken over the n + 1 points (Xi , Yi ), i = 1, . . . , n + 1 (the n training points and the test point).
- Importantly, the symmetry in the construction of the nonconformity scores (4) guarantees exact coverage in finite samples.
- It gives us a recipe for distribution-free prediction intervals, with nearly exact coverage, starting from an arbitrary score function S; e.g., absolute residuals with respect to a fitted regression function from any base algorithm A, as in (3).
- The conformal prediction interval (5), defined at a point x ∈ Rd , reduces to   bn (x) = µ0 (x) ± Quantile 1 − α; |Yi − µ0 (Xi )| n ∪ {∞} ,  C i=1 (9) and by Theorem 1 it has coverage at least 1 − α, conditional on (X10 , Y10 ), . . . , (Xn00 , Yn00 ).
- This coverage result holds (x,y) (x,y) because, when we treat µ0 as fixed (meaning, condition on (X10 , Y10 ), . . . , (Xn00 , Yn00 )), the scores V1 , . . . , Vn+1 scores are exchangeable for (x, y) = (Xn+1 , Yn+1 ), as (X1 , Y1 ), . . . , (Xn+1 , Yn+1 ) are.
- As split conformal prediction can be seen as a special case of conformal prediction, in which the regression function µ0 is treated as fixed, Corollary 1 also applies to the split scenario, and guarantees that the band defined for x ∈ Rd by  Xn  w w Cn (x) = µ0 (x) ± Quantile 1 − α; b pi (x)δ|Yi −µ0 (Xi )| + pn+1 (x)δ∞ , (10) i=1 where the probabilities are as in (7), has coverage at least 1 − α, conditional on (X1

## 5) 风险与局限
- However, the histogram is more dispersed than it is when there is no covariate shift (compare to the top row, in red).
- Suppose that on the test data (Z, X, Y ) ∼ Pe, the distribution of Z has changed, causing a change in the distribution of X, and thus causing a change in the distribution of the unobserved Y (however the distribution of X|Z is unchanged).
- These ideas may be generalized to more complex graphical settings, which we leave to future work.

## 6) 对 OpenAlice 的直接改造
- transfer 评估引入 density-ratio 加权的 conformal 校准。
