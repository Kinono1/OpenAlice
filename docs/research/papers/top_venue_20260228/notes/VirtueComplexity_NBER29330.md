# VirtueComplexity_NBER29330

- Venue: `NBER w29330`
- Source: https://www.nber.org/papers/w29330
- OpenAlice gate targets: `model_capacity`

## 1) 核心问题
Supply chain disruptions, which have become commonplace, are often associated with globalization and trade. Little is known about optimal policy in the face of insecure supply chains. Should governments promote resilience by subsidizing backup sources of input supply? Should they encourage firms to source from closer and presumably safer domestic suppliers? We address these questions in a very simple model of production with a single critical input and with exogenous risks of relationship-specific and country-wide supply disturbances. We follow Matsuyama and Ushchev (2020) in positing a class of preferences that are homothetic with a single aggregator and that obey Marshall's Second Law of Demand. The familiar case of CES preferences is a member of the class, but it imposes restrictions that are important for policy conclusions.We find that, in the CES case, a subsidy for diversification

## 2) 方法机制（抓主干）
- In this paper, we propose a bare-bones framework that can aid with evaluating policy that influences the organization of supply chains.
- Our framework puts supply shortages front and center.
- We have proposed a simple framework in which the supply of any product requires the availability of a critical input.
- Our framework could be extended to allow for more complex supply chains, including multiple purchased inputs from various sources that might also be combined with primary factors of production.
- For both calibrations, n(µ ) = 0.78 and nB (µ ) = 0.97.

## 3) 证据与结果（正文摘录）
- We address these questions in a very simple model of production with a single critical input and with exogenous risks of relationship-specific and country-wide supply disturbances.
- Pandemics and other biological threats, cyber-attacks, climate shocks and extreme weather events, terrorist attacks, geopolitical and economic competition, and other conditions can reduce critical manufacturing capacity and the availability and integrity of critical goods, products, and services.
- They result from natural disasters, geopolitical disputes, transportation failures, cyber-attacks, fires, power outages, labor shortages, human error and, of course, pandemics.
- The disruptions impose significant costs, presenting firms with expected losses of between 24% of a year’s earnings before interest, taxes, depreciation and amortization (EBITDA) in pharmaceuticals to 67% in aerospace, over a ten-year period.
- And if distance from suppliers intensifies the risk of disruption, wouldn’t it be better to bring some parts of the supply chains back home?
- Each firm may establish a relationship with a potential supplier in a low-cost but riskier foreign country, in a higher-cost but safer home location, or in both.

## 4) 定量线索（含数字句）
- The disruptions impose significant costs, presenting firms with expected losses of between 24% of a year’s earnings before interest, taxes, depreciation and amortization (EBITDA) in pharmaceuticals to 67% in aerospace, over a ten-year period.
- Across the thirteen industries that McKinsey examined, the expected losses per decade amounted to about 42% of annual EBITDA (see Exhibit E5 on p.12).
- Using a calibrated general-equilibrium model of production networks, they conclude that the disaster imposed a 0.47 percentage point reduction in Japan’s aggregate real GDP growth.
- Figure 5 depicts a reasonably typical case with symmetric translog preferences.17 We take the translog parameter θ = 3.5, the relationship-specific probability of supply disruption 1 − ρ = 0.1, the elasticity of demand for differentiated products ε = 1.4, and the respective unit costs of the input qH = 0.1 and qF = 0.08, so that the cost advantage of the foreign country is 20%.
- Figure 6 depicts a situation with a much smaller difference in costs (only 1%) and a much smaller elasticity of demand for differentiated products (ε = 1.01).20 Here, the number of firms 19 However, the optimal offshoring falls as the difference in riskiness rises when the cost difference between home and foreign is only 10%; see Figure 8 in the appendix. 20 The parameters that underlie this figure are: qF = 0.999, q
- Using the implicit function theorem, ! ! ∂µh /∂sr 1 −δ B ρ(1 − ρ)dπ[z B (µh+f ]) = , ∂µf /∂sr ∆ δρdπ[z F (µh )] + δ B ρ(1 − ρ)dπ[z B (µh+f ]) where ∆ := −ρ2 δdπ[z H (µf )] · δdπ[z F (µh )] + δ B (1 − ρ)dπ[z B (µh+f )] −  ρ2 δ B (1 − ρ)dπ[z B (µh+f )] · δdπ[z F (µh )] < 0. 40 Using dµb = −dµh+f , we conclude that ∂µh ρ(1 − ρ) B dπ[z B (µh+f )] =− δ > 0, ∂sr ∆ dµh+f ∂µb ρ dπ[z F (µh )] =− δ > 0, ∂sr ∆ dµh   ∂µf ∂µb 

## 5) 风险与局限
- This is, of course, the simplest imaginable production function; in future work we plan to allow for additional factors of production and more complex supply chains.
- In the complementary event, with probability ρ, no idiosyncratic supply disruption occurs and the firm can buy as much as it wants from the particular supplier provided that the latter is located in a country that is “open for business.” However, with probability 1 − γi a country-wide shock disrupts all chains with suppliers in country i.
- The relative safety of the home country is captured by the assumption that 5 γH ≥ γF .
- Equation (3) expresses the demand for any variety ω in implicit form; the substantive assumption is that this demand depends only on the relative price p/A.
- First, we impose Assumption 1 The market-share function s (z) is strictly decreasing when positive, with limz→0 s (z) = ∞ and limz→z̄ s (z) = 0, for z̄ ≡ inf { z > 0| s (z) = 0}.

## 6) 对 OpenAlice 的直接改造
- 复杂模型仅在 transfer+CI+turnover 同过门控时准入。
