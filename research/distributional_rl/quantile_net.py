from __future__ import annotations


def require_torch():
    try:
        import torch
        import torch.nn as nn
    except ImportError as exc:
        raise RuntimeError(
            "PyTorch is required for distributional RL research. Install torch in the research environment."
        ) from exc
    return torch, nn


def build_quantile_network(state_dim: int, action_dim: int, num_quantiles: int = 16):
    torch, nn = require_torch()

    class QuantileNetwork(nn.Module):
        def __init__(self):
            super().__init__()
            self.backbone = nn.Sequential(
                nn.Linear(state_dim + 1, 128),
                nn.ReLU(),
                nn.Linear(128, 64),
                nn.ReLU(),
            )
            self.head = nn.Linear(64, action_dim)

        def forward(self, state, tau):
            if tau.ndim == 1:
                tau = tau.unsqueeze(-1)
            inputs = torch.cat([state, tau], dim=-1)
            return self.head(self.backbone(inputs))

    return QuantileNetwork(), num_quantiles
