from __future__ import annotations

import argparse
from pathlib import Path

from model import ForecastModelConfig, build_model, require_torch


def main():
    parser = argparse.ArgumentParser(description="Export a trained forecaster to ONNX.")
    parser.add_argument("--checkpoint", required=True, help="Path to .pt checkpoint.")
    parser.add_argument("--output", required=True, help="Output .onnx path.")
    parser.add_argument("--lookback", type=int, default=48)
    args = parser.parse_args()

    torch, _ = require_torch()

    checkpoint_path = Path(args.checkpoint)
    payload = torch.load(checkpoint_path, map_location="cpu")
    config = ForecastModelConfig(**payload["config"])
    feature_names = payload.get("feature_names", [])
    if config.input_dim != len(feature_names):
        raise RuntimeError(
            f"Checkpoint input_dim={config.input_dim} does not match feature_names length={len(feature_names)}."
        )
    model = build_model(config)
    model.load_state_dict(payload["state_dict"])
    model.eval()

    dummy = torch.zeros((1, args.lookback, config.input_dim), dtype=torch.float32)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        model,
        dummy,
        output_path,
        input_names=["features"],
        output_names=["forecast"],
        dynamic_axes={"features": {1: "lookback"}, "forecast": {1: "horizon"}},
        opset_version=17,
    )

    metadata_path = output_path.with_suffix(".json")
    metadata_path.write_text(
        __import__("json").dumps(
            {
                "architecture": config.architecture,
                "input_dim": config.input_dim,
                "lookback": args.lookback,
                "feature_names": feature_names,
                "checkpoint_path": str(checkpoint_path),
                "onnx_path": str(output_path),
            },
            indent=2,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
