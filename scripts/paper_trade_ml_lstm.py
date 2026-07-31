#!/usr/bin/env python3
"""LSTM BTC direction predictor — uses trained LSTM model for inference."""
import json, os, sys, warnings
import numpy as np
import torch
import torch.nn as nn
warnings.filterwarnings("ignore")

ROOT = "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
MODEL_PATH = os.path.join(ROOT, "models/signals/btc_lstm_scripted.pt")
CONFIG_PATH = os.path.join(ROOT, "models/signals/btc_lstm_config.json")
DATA_PATH = os.path.join(ROOT, "data/market/live_5m/BTC_USDT_USDT_5m.csv")

SEQ_LEN = 32; HORIZON = 24

def load_data(path):
    with open(path) as f:
        lines = f.read().strip().split("\n")
    h = lines[0].split(",")
    ci = h.index("close"); vi = h.index("volume") if "volume" in h else -1
    data = []
    for l in lines[1:]:
        cols = l.split(",")
        try: data.append({"c": float(cols[ci]), "v": float(cols[vi]) if vi >= 0 else 0})
        except: pass
    return data

def compute_features(data):
    closes = np.array([d["c"] for d in data], dtype=np.float64)
    volumes = np.array([d["v"] for d in data], dtype=np.float64)
    i = len(data) - 1
    if i < SEQ_LEN + HORIZON: return None, None
    
    seq = closes[i-SEQ_LEN:i]
    seq_norm = (seq - np.mean(seq)) / (np.std(seq) + 1e-10)
    
    rets = np.diff(closes[i-SEQ_LEN:i+1]) / closes[i-SEQ_LEN:i]
    log_rets = np.diff(np.log(seq + 1e-10))
    
    feat = np.array([
        float(np.mean(rets)), float(np.std(rets)), float(np.min(rets)), float(np.max(rets)),
        float(np.mean(log_rets)), float(np.std(log_rets)),
        float(np.std(rets)), 
        float(volumes[i-1] / (np.mean(volumes[i-SEQ_LEN:i-1]) + 1e-10)),
        float(np.mean(rets[-4:]) if len(rets) >= 4 else 0),
        float(np.mean(rets[-12:]) if len(rets) >= 12 else 0),
        float(np.mean(rets)),
        float((seq[-1] - np.min(seq)) / (np.max(seq) - np.min(seq) + 1e-10)),
        float(rets[-1] if len(rets) > 0 else 0),
    ], dtype=np.float32)
    
    return seq_norm.astype(np.float32), feat

def main():
    if not os.path.exists(MODEL_PATH):
        print(f"ML-LSTM: model not found, train with scripts/train_lstm_model.py first")
        sys.exit(0)
    
    data = load_data(DATA_PATH)
    if len(data) < SEQ_LEN + HORIZON:
        print(f"ML-LSTM: insufficient data ({len(data)} bars)")
        sys.exit(0)
    
    seq, feat = compute_features(data)
    if seq is None:
        print("ML-LSTM: feature computation failed")
        sys.exit(0)
    
    try:
        model = torch.jit.load(MODEL_PATH)
        model.eval()
        with torch.no_grad():
            seq_t = torch.FloatTensor(seq).view(1, -1, 1)
            feat_t = torch.FloatTensor(feat).view(1, -1)
            pred = model(seq_t, feat_t).item()
    except Exception as e:
        print(f"ML-LSTM: inference error: {e}")
        sys.exit(0)
    
    direction = "UP" if pred > 0 else "DOWN"
    confidence = min(abs(pred) * 100, 99.9) / 100
    
    result = {
        "generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "symbol": "BTC-USDT",
        "prediction": 1 if pred > 0 else 0,
        "direction": direction,
        "confidence": round(float(confidence), 4),
        "raw_value": round(float(pred), 6),
        "model": "lstm",
    }
    
    print(f"ML-LSTM BTC prediction: {direction} (conf={confidence:.2%} raw={pred:+.6f})")
    
    out_path = os.path.join(ROOT, "data/runtime/ml_lstm_prediction.latest.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)

if __name__ == "__main__":
    main()
