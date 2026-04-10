from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ForecastModelConfig:
    input_dim: int
    hidden_dim: int = 64
    num_layers: int = 2
    horizon: int = 1
    architecture: str = "lstm"
    patch_len: int = 8
    dropout: float = 0.1
    num_heads: int = 4


def require_torch():
    try:
        import torch
        import torch.nn as nn
    except ImportError as exc:
        raise RuntimeError(
            "PyTorch is required for phase 3 model training/export. Install torch first."
        ) from exc
    return torch, nn


def build_model(config: ForecastModelConfig):
    _, nn = require_torch()

    class LstmForecaster(nn.Module):
        def __init__(self, cfg: ForecastModelConfig):
            super().__init__()
            self.encoder = nn.LSTM(
                input_size=cfg.input_dim,
                hidden_size=cfg.hidden_dim,
                num_layers=cfg.num_layers,
                batch_first=True,
                dropout=cfg.dropout if cfg.num_layers > 1 else 0.0,
            )
            self.head = nn.Sequential(
                nn.LayerNorm(cfg.hidden_dim),
                nn.Linear(cfg.hidden_dim, cfg.hidden_dim),
                nn.GELU(),
                nn.Linear(cfg.hidden_dim, cfg.horizon),
            )

        def forward(self, x):
            encoded, _ = self.encoder(x)
            return self.head(encoded[:, -1, :])

    class PatchTSTForecaster(nn.Module):
        def __init__(self, cfg: ForecastModelConfig):
            super().__init__()
            self.patch_len = cfg.patch_len
            self.input_dim = cfg.input_dim
            self.patch_proj = nn.Linear(cfg.patch_len * cfg.input_dim, cfg.hidden_dim)
            encoder_layer = nn.TransformerEncoderLayer(
                d_model=cfg.hidden_dim,
                nhead=cfg.num_heads,
                dim_feedforward=cfg.hidden_dim * 4,
                dropout=cfg.dropout,
                batch_first=True,
                activation="gelu",
            )
            self.transformer = nn.TransformerEncoder(
                encoder_layer, num_layers=max(1, cfg.num_layers)
            )
            self.head = nn.Sequential(
                nn.LayerNorm(cfg.hidden_dim),
                nn.Linear(cfg.hidden_dim, cfg.horizon),
            )

        def forward(self, x):
            batch, steps, dims = x.shape
            if dims != self.input_dim:
                raise RuntimeError(
                    f"Expected input_dim={self.input_dim}, received {dims}."
                )
            usable_steps = max(self.patch_len, steps - (steps % self.patch_len))
            x = x[:, -usable_steps:, :]
            patch_count = usable_steps // self.patch_len
            patches = x.reshape(batch, patch_count, self.patch_len * dims)
            encoded = self.patch_proj(patches)
            encoded = self.transformer(encoded)
            return self.head(encoded[:, -1, :])

    if config.architecture == "patchtst":
        return PatchTSTForecaster(config)
    return LstmForecaster(config)
