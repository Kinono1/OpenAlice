#!/usr/bin/env python3
"""ML Model Paper Trader — runs BTC direction prediction → signal."""
import json, os, sys, warnings
import numpy as np
import joblib
from datetime import datetime, timezone
warnings.filterwarnings("ignore")

ROOT = "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
MODEL_PATH = os.path.join(ROOT, "models", "signals", "btc_direction_model.joblib")
DATA_PATH = os.path.join(ROOT, "data", "market", "live_5m", "BTC_USDT_USDT_5m.csv")

def load_closes(path, max_bars=1000):
    if not os.path.exists(path): return []
    with open(path) as f:
        lines = f.read().strip().split("\n")
    if len(lines) < 2: return []
    h = lines[0].split(",")
    ci = h.index("close") if "close" in h else 5
    return [float(l.split(",")[ci]) for l in lines[1:] if l.strip()][-max_bars:]

def compute_features(closes):
    if len(closes) < 60: return None
    rets = [(closes[i] - closes[i-1]) / closes[i-1] for i in range(1, len(closes))]
    if len(rets) < 60: return None
    r60 = rets[-60:]
    return np.array([[float(np.mean(r60)), float(np.std(r60)), float(float(np.mean((r60 - np.mean(r60))**3)) / (np.std(r60)**3 + 1e-10)), float(np.min(r60)), float(np.max(r60))]], dtype=np.float64)

def main():
    if not os.path.exists(MODEL_PATH):
        print(f"ML: model not found at {MODEL_PATH}")
        sys.exit(0)

    model_data = joblib.load(MODEL_PATH)
    if isinstance(model_data, dict):
        model = model_data.get("model", model_data)
        metadata = {k: v for k, v in model_data.items() if k != "model"}
    else:
        model = model_data
        metadata = {}

    closes = load_closes(DATA_PATH)
    if len(closes) < 60:
        print(f"ML: insufficient data ({len(closes)} bars)")
        sys.exit(0)

    X = compute_features(closes)
    if X is None:
        print("ML: feature computation failed")
        sys.exit(0)

    pred = model.predict(X)[0]
    proba = model.predict_proba(X)[0] if hasattr(model, "predict_proba") else [0.5, 0.5]
    confidence = max(proba)
    direction = "UP" if pred == 1 else "DOWN"
    
    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "symbol": "BTC-USDT",
        "prediction": int(pred),
        "direction": direction,
        "confidence": round(float(confidence), 4),
        "features": {
            "mean": round(float(X[0][0]), 6),
            "std": round(float(X[0][1]), 6),
            "skew": round(float(X[0][2]), 6),
            "min": round(float(X[0][3]), 6),
            "max": round(float(X[0][4]), 6),
        },
    }
    
    print(f"ML BTC prediction: {direction} (conf={confidence:.2%})")
    print(json.dumps(result))

    out_path = os.path.join(ROOT, "data", "runtime", "ml_prediction.latest.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    print(f"Saved: {out_path}")

if __name__ == "__main__":
    main()
