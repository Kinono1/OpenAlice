#!/usr/bin/env python3
"""Train LSTM BTC direction predictor on 5m data, export for inference."""
import json, os, sys, warnings, pickle
import numpy as np
import torch
import torch.nn as nn
from pathlib import Path
warnings.filterwarnings("ignore")

ROOT = "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
DATA_PATH = os.path.join(ROOT, "data/market/live_5m/BTC_USDT_USDT_5m.csv")
MODEL_DIR = os.path.join(ROOT, "models/signals")
os.makedirs(MODEL_DIR, exist_ok=True)

SEQ_LEN = 32
HORIZON = 24
HIDDEN = 32
EPOCHS = 20
BATCH = 128
LR = 0.001

def load_data(path):
    with open(path) as f:
        lines = f.read().strip().split("\n")
    h = lines[0].split(",")
    ci = h.index("close"); vi = h.index("volume") if "volume" in h else -1; ti = h.index("timestamp")
    data = []
    for l in lines[1:]:
        cols = l.split(",")
        try: data.append({"t": int(cols[ti]), "c": float(cols[ci]), "v": float(cols[vi]) if vi >= 0 else 0})
        except: pass
    return data

def engineer_features(data):
    closes = np.array([d["c"] for d in data], dtype=np.float64)
    volumes = np.array([d["v"] for d in data], dtype=np.float64)
    rets = np.diff(closes) / closes[:-1]
    features = []
    targets = []
    for i in range(SEQ_LEN, len(data) - HORIZON):
        # Sequence features
        seq_rets = rets[i-SEQ_LEN:i]
        seq_vols = volumes[i-SEQ_LEN:i]
        seq_closes = closes[i-SEQ_LEN:i]
        
        # Log returns
        log_rets = np.diff(np.log(seq_closes + 1e-10))
        
        # Volatility (rolling std)
        vol = np.std(seq_rets) if len(seq_rets) > 0 else 0
        
        # Volume ratio
        vol_ratio = seq_vols[-1] / (np.mean(seq_vols[:-1]) + 1e-10)
        
        # Momentum features
        mom_short = np.mean(seq_rets[-4:]) if len(seq_rets) >= 4 else 0
        mom_med = np.mean(seq_rets[-12:]) if len(seq_rets) >= 12 else 0
        mom_long = np.mean(seq_rets) if len(seq_rets) > 0 else 0
        
        # Price relative to range
        high = np.max(seq_closes)
        low = np.min(seq_closes)
        range_pos = (seq_closes[-1] - low) / (high - low + 1e-10)
        
        # Target: forward return
        fwd_ret = (closes[i + HORIZON] - closes[i]) / closes[i]
        
        feat = np.array([
            np.mean(seq_rets), np.std(seq_rets), np.min(seq_rets), np.max(seq_rets),
            np.mean(log_rets), np.std(log_rets),
            vol, vol_ratio, mom_short, mom_med, mom_long, range_pos,
            seq_rets[-1] if len(seq_rets) > 0 else 0,
        ], dtype=np.float32)
        
        # Also include raw sequence for LSTM
        seq_norm = (seq_closes - np.mean(seq_closes)) / (np.std(seq_closes) + 1e-10)
        
        features.append({"seq": seq_norm.astype(np.float32), "feat": feat, "target": float(fwd_ret)})
        targets.append(float(fwd_ret))
    
    return features, np.array(targets, dtype=np.float32)

class LSTMModel(nn.Module):
    def __init__(self, input_size=1, hidden=HIDDEN, num_feats=13):
        super().__init__()
        self.lstm = nn.LSTM(input_size, hidden, batch_first=True)
        self.fc = nn.Sequential(
            nn.Linear(hidden + num_feats, 16),
            nn.ReLU(),
            nn.Linear(16, 1),
        )
    
    def forward(self, seq, feats):
        out, _ = self.lstm(seq)
        last = out[:, -1, :]
        combined = torch.cat([last, feats], dim=1)
        return self.fc(combined).squeeze()

def main():
    print("Loading BTC 5m data...")
    data = load_data(DATA_PATH)
    print(f"  {len(data)} bars loaded")
    
    features, targets = engineer_features(data)
    print(f"  {len(features)} samples created (seq_len={SEQ_LEN}, horizon={HORIZON})")
    
    n = len(features)
    split = int(n * 0.8)
    train_feats, test_feats = features[:split], features[split:]
    train_targs, test_targs = targets[:split], targets[split:]
    
    # Prepare tensors
    def make_loader(feats, targs, batch_size=BATCH, shuffle=False):
        seqs = torch.stack([torch.FloatTensor(f["seq"]).view(-1, 1) for f in feats])
        fts = torch.stack([torch.FloatTensor(f["feat"]) for f in feats])
        tgt = torch.FloatTensor(targs)
        ds = torch.utils.data.TensorDataset(seqs, fts, tgt)
        return torch.utils.data.DataLoader(ds, batch_size=batch_size, shuffle=shuffle)
    
    train_loader = make_loader(train_feats, train_targs, shuffle=True)
    test_loader = make_loader(test_feats, test_targs)
    
    model = LSTMModel()
    optim = torch.optim.Adam(model.parameters(), lr=LR)
    loss_fn = nn.MSELoss()
    
    print(f"\nTraining LSTM (hidden={HIDDEN}, epochs={EPOCHS})...")
    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0
        for seq, feat, tgt in train_loader:
            optim.zero_grad()
            pred = model(seq, feat)
            loss = loss_fn(pred, tgt)
            loss.backward()
            optim.step()
            total_loss += loss.item()
        
        # Eval
        model.eval()
        with torch.no_grad():
            preds, actuals = [], []
            for seq, feat, tgt in test_loader:
                p = model(seq, feat)
                preds.extend(p.numpy())
                actuals.extend(tgt.numpy())
            pred_dir = np.array([1 if p > 0 else 0 for p in preds])
            actual_dir = np.array([1 if a > 0 else 0 for a in actuals])
            acc = np.mean(pred_dir == actual_dir)
        
        if (epoch + 1) % 5 == 0 or epoch == 0:
            print(f"  Epoch {epoch+1:2d}/{EPOCHS}  loss={total_loss:.4f}  val_acc={acc:.2%}")
    
    # Final evaluation
    model.eval()
    with torch.no_grad():
        preds, actuals = [], []
        for seq, feat, tgt in test_loader:
            p = model(seq, feat)
            preds.extend(p.numpy())
            actuals.extend(tgt.numpy())
        preds = np.array(preds)
        actuals = np.array(actuals)
        pred_dir = (preds > 0).astype(int)
        actual_dir = (actuals > 0).astype(int)
        acc = np.mean(pred_dir == actual_dir)
        print(f"\n  Test accuracy: {acc:.2%}")
        
        # Confusion matrix
        tp = np.sum((pred_dir == 1) & (actual_dir == 1))
        tn = np.sum((pred_dir == 0) & (actual_dir == 0))
        fp = np.sum((pred_dir == 1) & (actual_dir == 0))
        fn = np.sum((pred_dir == 0) & (actual_dir == 1))
        print(f"  Confusion: TP={tp} TN={tn} FP={fp} FN={fn}")
    
    # Save model
    model_path = os.path.join(MODEL_DIR, "btc_lstm_model.pt")
    torch.save({
        "model_state": model.state_dict(),
        "hidden": HIDDEN,
        "seq_len": SEQ_LEN,
        "horizon": HORIZON,
        "test_accuracy": float(acc),
    }, model_path)
    
    # Also save as scripted module for inference
    scripted = torch.jit.script(model)
    script_path = os.path.join(MODEL_DIR, "btc_lstm_scripted.pt")
    scripted.save(script_path)
    
    # Save feature config
    feat_config = {
        "seq_len": SEQ_LEN,
        "horizon": HORIZON,
        "hidden": HIDDEN,
        "num_features": 13,
        "accuracy": float(acc),
    }
    with open(os.path.join(MODEL_DIR, "btc_lstm_config.json"), "w") as f:
        json.dump(feat_config, f, indent=2)
    
    print(f"\nModel saved: {model_path}")
    print(f"Scripted: {script_path}")
    print(f"Config: {os.path.join(MODEL_DIR, 'btc_lstm_config.json')}")

if __name__ == "__main__":
    main()
