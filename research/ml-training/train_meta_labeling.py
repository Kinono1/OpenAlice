from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def load_dataset(path: Path, label_column: str):
    with path.open("r", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
    if not rows:
        raise RuntimeError(f"No rows found in {path}")
    feature_columns = [name for name in rows[0].keys() if name and name != label_column]
    features = [[float(row[column]) for column in feature_columns] for row in rows]
    labels = [int(float(row[label_column])) for row in rows]
    return feature_columns, features, labels


def fit_model(features, labels, rounds: int, learning_rate: float):
    try:
        from xgboost import XGBClassifier

        model = XGBClassifier(
            n_estimators=rounds,
            learning_rate=learning_rate,
            max_depth=4,
            subsample=0.9,
            colsample_bytree=0.9,
            objective="binary:logistic",
            eval_metric="logloss",
        )
        model.fit(features, labels)
        backend = "xgboost"
        return model, backend
    except ImportError:
        try:
            from sklearn.ensemble import GradientBoostingClassifier
        except ImportError as exc:
            raise RuntimeError(
                "train_meta_labeling.py requires xgboost or scikit-learn."
            ) from exc

        model = GradientBoostingClassifier(
            n_estimators=rounds,
            learning_rate=learning_rate,
        )
        model.fit(features, labels)
        backend = "sklearn-gradient-boosting"
        return model, backend


def main():
    parser = argparse.ArgumentParser(description="Train a meta-labeling classifier.")
    parser.add_argument("--dataset", required=True, help="CSV dataset with feature columns.")
    parser.add_argument("--label-column", default="label")
    parser.add_argument("--rounds", type=int, default=200)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--output-dir", default="research/ml-training/artifacts")
    parser.add_argument("--validate-only", action="store_true", help="Validate dataset contract and exit before training")
    args = parser.parse_args()

    dataset_path = Path(args.dataset)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    feature_columns, features, labels = load_dataset(dataset_path, args.label_column)
    if args.validate_only:
        print(
            json.dumps(
                {
                    "dataset": str(dataset_path),
                    "feature_columns": feature_columns,
                    "feature_count": len(feature_columns),
                    "row_count": len(features),
                    "label_distribution": {
                        "positive": sum(1 for label in labels if label == 1),
                        "negative": sum(1 for label in labels if label == 0),
                    },
                },
                indent=2,
            )
        )
        return
    model, backend = fit_model(features, labels, args.rounds, args.learning_rate)

    model_path = output_dir / "meta_labeling_model.json"
    summary_path = output_dir / "meta_labeling_summary.json"

    if backend == "xgboost":
        model.save_model(model_path)
    else:
        try:
            import joblib
        except ImportError as exc:
            raise RuntimeError(
                "scikit-learn fallback requires joblib to persist the trained model."
            ) from exc
        model_path = output_dir / "meta_labeling_model.joblib"
        joblib.dump(model, model_path)

    summary_path.write_text(
        json.dumps(
            {
                "dataset": str(dataset_path),
                "backend": backend,
                "model_path": str(model_path),
                "feature_columns": feature_columns,
                "label_distribution": {
                    "positive": sum(1 for label in labels if label == 1),
                    "negative": sum(1 for label in labels if label == 0),
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
