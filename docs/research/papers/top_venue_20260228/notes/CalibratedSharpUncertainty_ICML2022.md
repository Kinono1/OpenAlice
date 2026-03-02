# CalibratedSharpUncertainty_ICML2022

- Venue: `ICML 2022`
- Source: https://proceedings.mlr.press/v162/zhao22d.html
- OpenAlice gate targets: `gate_pass_robust_ci`

## 1) 核心问题
Learning to Solve PDE-constrained Inverse Problems with Graph Networks Qingqing Zhao 1 David B. Lindell 1 Gordon Wetzstein 1 a) Pipeline Abstract Learned Prior Learned Predicted Forward dynamics Learned graph neural networks (GNNs) have re- Model y cently been established as fast and accurate alter- 𝒖𝒙 (𝒙𝒊 ) GNN natives for principled solvers in simulating the dy- x e tim namics of physical systems. In many application y 𝒖𝒚 (𝒙𝒊 ) domains across science and engineering, however, x e

## 2) 方法机制（抓主干）
- State-of-the-art learning- architectures to efficiently solve PDE-constrained inverse based mesh simulators operate on adaptive meshes using problems of the form in Eq.
- Our approach general, operate on irregular meshes motivates us to explore is inspired by recent GNN architectures for modeling time- emerging coordinate network architectures (Park et al., resolved dynamics (Pfaff et al., 2021; Sanchez-Gonzalez 2019; Tancik et al., 2020; Sitzmann et al., 2020) as suitable et al., 2020) that generalize to unseen initial conditions and priors.
- Whereas these approaches focus on learn- simulation domain and map coordinates to a quantity of ing the forward simulation given a set of initial or boundary interest, such as the initial condition or the parameters of a conditions, ours aims at solving ill-posed PDE-constrained specific problem. inverse problems that require a learned simulation model as part of the framework.
- We demonstrate that this architecture affords the density, viscosity, or other material parameters (Mosser faster runtimes and better quality for fewer observations et al., 2020; He & Wang, 2021; Fan et al., 2020), from than the principled solvers we tested, while offering the a sparse set of measurements.
- Related Work other class of techniques are tailored to the inverse design problem, which aims to optimize material properties such Machine learning methods have emerged as a powerful that the PDE solution satisfies certain useful properties, e.g., tool for modeling the dynamics of physical systems.
- Previous techniques span 2019), we use a generative model to learn a prior over the a spectrum of being entirely data-driven (i.e., modeling dy- solution space of material parameters or initial conditions; namics with a feedforward pass through a network) (Bhat- however, our framework is the first to learn to map a latent nagar et al., 2019; Li et al., 2021; Tompson et al., 2017; Lu code to material parameters or ini

## 3) 证据与结果（正文摘录）
- State-of-the-art learning- architectures to efficiently solve PDE-constrained inverse based mesh simulators operate on adaptive meshes using problems of the form in Eq.
- Other methods can super- same benefits of improved accuracy over grid-based CNNs resolve PDE solutions from estimated solutions at coarse to inverse problems that graph networks offer for forward resolution (Esmaeilzadeh et al., 2020) or recover initial con- simulations (Figure 1). ditions from PDE solutions observed at coarse resolution later in time (Li et al., 2020b; Frerix et al., 2021).
- Our approach is most similar to other methods that (2008)), physics-based machine learning techniques may infer material properties or initial conditions from sparse offer improved computational performance, ease of imple- measurements of the PDE solution over time.
- This allows our model Gonzalez et al., 2020; Seo et al., 2020) to hybrid approaches to solve physics-based inverse problems on irregular grids that either directly incorporate conventional solvers (Um with adaptive resolution, leading to improved computational 3 4 SGD argmin! ' ℒ (Observations, Predictions) Initial Condition (wavefield) 1 " Observation Objective 𝑧!"!# 𝑥! 2 Sparse Observations Simulation Parameters (v
- While the FEM solver on the fine grid outperforms the GNN, it is also ≈8× slower.
- We address two different tasks, (1) recovering the initial 50 time steps and averaged over 96 trajectories in Fig. 3. condition, uinit , and (2) full-waveform inversion (Virieux & The GNN-based simulator provides a robust solution.
- We observe that the GNN outperforms the U-Net (CNN) with a similar number of nodes and provides comparable results with the U-Net (CNN) using 7× more nodes.

## 4) 定量线索（含数字句）
- Other methods can super- same benefits of improved accuracy over grid-based CNNs resolve PDE solutions from estimated solutions at coarse to inverse problems that graph networks offer for forward resolution (Esmaeilzadeh et al., 2020) or recover initial con- simulations (Figure 1). ditions from PDE solutions observed at coarse resolution later in time (Li et al., 2020b; Frerix et al., 2021).
- At this setting, the FEM solver simulated on a s.t. ut+1 = ut + Mc (ut , u′t ) fine irregular mesh is roughly 8× slower than the GNN; run- | {z } u0 (x)=Guinit (z,x) or c(x)=Gc (z,x) ning the FEM solver on the same grid as the GNN is 2.5× slower than the GNN with accuracy roughly 80× worse in Here, we minimize the mean squared error (MSE) between terms of MSE. the predicted field (upred t ) and the ground truth obser
- The classical FEM solver using a fine irregular mesh gives the lowest MSE, however it is at least 8× slower than the learned simulator approaches.
- At the beginning of the optimization, we only solver operating on the finest mesh gives the most accurate have observations at time step T = {2∆t}, and we include forward model, it gives the best MSE in the inverse problem. one extra time step’s measurement every 120 optimization However, it is at least 8× slower than the learned simulator iterations until T = {2∆t, 4∆t, · · · , 30∆t}. approaches.
- Here “C.” refers to the coarse meshes and “F.” refers to the Forward Model # nodes MSE Runtime (s) fine meshes, consistent with the notation used in Fig. 4.

## 5) 风险与局限
- In many application y 𝒖𝒚 (𝒙𝒊 ) domains across science and engineering, however, x e tim we are not only interested in a forward simulation but also in solving inverse problems with con- b) Inverse Problem Results straints defined by a partial differential equation Observations Predicted dynamics GT dynamics Wave Equation (PDE).
- Previous techniques span 2019), we use a generative model to learn a prior over the a spectrum of being entirely data-driven (i.e., modeling dy- solution space of material parameters or initial conditions; namics with a feedforward pass through a network) (Bhat- however, our framework is the first to learn to map a latent nagar et al., 2019; Li et al., 2021; Tompson et al., 2017; Lu code to material parameters or ini
- The classical FEM solver using a fine irregular mesh gives the lowest MSE, however it is at least 8× slower than the learned simulator approaches.
- From the table introducing a damping function as in (Chen et al., 2015). we observe that with or without the prior, our approach pro- In frequency-domain full-waveform inversion, one can first vides a favorable trade-off between the accuracy and the optimize low-frequencies to avoid local minima (Aghamiry speed.
- At the beginning of the optimization, we only solver operating on the finest mesh gives the most accurate have observations at time step T = {2∆t}, and we include forward model, it gives the best MSE in the inverse problem. one extra time step’s measurement every 120 optimization However, it is at least 8× slower than the learned simulator iterations until T = {2∆t, 4∆t, · · · , 30∆t}. approaches.

## 6) 对 OpenAlice 的直接改造
- 在校准目标加入 sharpness 项，避免区间过宽导致机会流失。
