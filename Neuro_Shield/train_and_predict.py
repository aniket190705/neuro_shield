import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split
from xgboost import XGBClassifier


BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "telemetry_data.csv"
MODEL_PATH = BASE_DIR / "fatigue_model.pkl"
FEATURE_COLUMNS = ["keys", "mouse_distance", "tab_switches", "backspace"]
FEATURE_WEIGHTS = {
    "backspace": 0.50,
    "tab_switches": 0.38,
    "keys": 0.07,
    "mouse_distance": 0.05,
}
# Applied after weighted sum×10 so typical stress reaches HIGH (60%+ UI) more often
FATIGUE_OUTPUT_SCALE = 1.22
# UI bands on rounded percent (score×10): 0–30 LOW, 31–59 MEDIUM, 60+ HIGH
RISK_THRESHOLDS = {
    "low_percent_max": 30,
    "medium_percent_max": 59,
    "high_percent_min": 60,
}
REFERENCE_STATES = {
    "low": {
        "keys": "15+ with mean around 20",
        "mouse_distance": "under ~320 px or calm reading",
        "tab_switches": "0",
        "backspace": "0",
        "edge_case": "keys can be 0 when tab_switches are 0 and mouse_distance is under 500",
    },
    "medium": {
        "keys": "varied",
        "mouse_distance": "roughly 700+ px with any tab switch",
        "tab_switches": "1+",
        "backspace": "1+",
    },
    "high": {
        "keys": "often low when combined with stress signals",
        "mouse_distance": "1000+ combined with tabs or corrections",
        "tab_switches": "2+",
        "backspace": "3+",
    },
}


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def scale(value, low, high):
    if high == low:
        return 0.0
    return clamp((value - low) / (high - low), 0.0, 1.0)


def key_fatigue_component(keys):
    if keys >= 15:
        return 0.0
    if keys >= 5:
        return 0.35 + ((14 - keys) / 9) * 0.30
    return 0.75 + ((4 - keys) / 4) * 0.25


def mouse_fatigue_component(mouse_distance):
    """Ramps from ~180px; stronger mid/high bands."""
    if mouse_distance < 180:
        return 0.0
    if mouse_distance < 850:
        return scale(mouse_distance, 180, 850) * 0.62
    if mouse_distance < 1800:
        return 0.62 + scale(mouse_distance, 850, 1800) * 0.24
    return 0.86 + scale(mouse_distance, 1800, 4000) * 0.14


def tab_switch_fatigue_component(tab_switches):
    if tab_switches == 0:
        return 0.0
    if tab_switches == 1:
        return 0.44
    if tab_switches == 2:
        return 0.74
    return 0.90 + scale(tab_switches, 3, 6) * 0.10


def backspace_fatigue_component(backspace):
    if backspace == 0:
        return 0.0
    if backspace <= 2:
        return 0.28 + scale(backspace, 1, 2) * 0.40
    if backspace <= 5:
        return 0.62 + scale(backspace, 3, 5) * 0.18
    return 0.84 + scale(backspace, 6, 12) * 0.16


def fatigue_score(keys, mouse_distance, tab_switches, backspace):
    keys = int(clamp(keys, 0, 80))
    mouse_distance = float(clamp(mouse_distance, 0.0, 5000.0))
    tab_switches = int(clamp(tab_switches, 0, 15))
    backspace = int(clamp(backspace, 0, 25))

    reading_or_thinking = (
        keys == 0
        and tab_switches == 0
        and mouse_distance < 500
        and backspace <= 2
    )

    components = {
        "keys": key_fatigue_component(keys),
        "mouse_distance": mouse_fatigue_component(mouse_distance),
        "tab_switches": tab_switch_fatigue_component(tab_switches),
        "backspace": backspace_fatigue_component(backspace),
    }
    weighted_score = (
        sum(components[name] * FEATURE_WEIGHTS[name] for name in FEATURE_COLUMNS)
        * 10
        * FATIGUE_OUTPUT_SCALE
    )

    if keys <= 6 and tab_switches >= 1:
        weighted_score += 0.55
    if keys <= 5 and tab_switches >= 2:
        weighted_score += 1.35
    if keys <= 5 and backspace >= 3:
        weighted_score += 0.65
    if keys <= 5 and backspace >= 4:
        weighted_score += 1.1
    if tab_switches >= 2 and mouse_distance >= 900:
        weighted_score += 0.85
    if backspace >= 3 and tab_switches >= 2:
        weighted_score += 0.8
    if tab_switches >= 1 and mouse_distance >= 600:
        weighted_score += 0.45
    if tab_switches >= 3:
        weighted_score += 0.5
    if backspace >= 5:
        weighted_score += 0.5
    if tab_switches >= 2 and backspace >= 2:
        weighted_score += 0.35

    if keys >= 15 and mouse_distance < 1000 and tab_switches <= 1 and backspace <= 2:
        weighted_score -= 0.6
    if reading_or_thinking:
        weighted_score = min(weighted_score, 1.35)

    return round(float(clamp(weighted_score, 0.0, 10.0)), 4)


def derive_risk(keys, mouse_distance, tab_switches, backspace):
    score = fatigue_score(keys, mouse_distance, tab_switches, backspace)
    p = round(score * 10)
    if p >= RISK_THRESHOLDS["high_percent_min"]:
        return 2
    if p > RISK_THRESHOLDS["low_percent_max"]:
        return 1
    return 0


def build_synthetic_dataset(row_count=1500):
    records = []
    rng = np.random.default_rng(42)
    rows_per_state = row_count // 3

    for index in range(row_count):
        state = min(index // rows_per_state, 2)

        if state == 0:
            if index % 12 == 0:
                keys = 0
                mouse_distance = rng.normal(260, 110)
                tab_switches = 0
                backspace = rng.integers(0, 2)
            else:
                keys = rng.normal(20, 5)
                mouse_distance = rng.normal(500, 220)
                tab_switches = rng.choice([0, 0, 0, 1])
                backspace = rng.choice([0, 0, 1, 1, 2])
        elif state == 1:
            keys = rng.normal(9.5, 3.0)
            mouse_distance = rng.normal(1500, 260)
            tab_switches = rng.choice([1, 2, 2, 2, 3])
            backspace = rng.choice([2, 3, 4, 5, 6])
        else:
            keys = rng.normal(2.2, 1.8)
            mouse_distance = rng.normal(2600, 520)
            tab_switches = rng.choice([3, 3, 4, 5, 6, 7])
            backspace = rng.choice([6, 7, 8, 9, 10, 12, 14])

        if index % 29 == 0:
            mouse_distance += rng.normal(650, 160)
        if index % 37 == 0:
            backspace += 2
        if index % 43 == 0:
            tab_switches += 1
        if index % 53 == 0:
            keys += rng.normal(5, 2)

        keys = int(round(clamp(keys, 0, 80)))
        mouse_distance = float(round(clamp(mouse_distance, 0.0, 5000.0), 2))
        tab_switches = int(clamp(tab_switches, 0, 15))
        backspace = int(clamp(backspace, 0, 25))
        score = fatigue_score(keys, mouse_distance, tab_switches, backspace)
        risk = derive_risk(keys, mouse_distance, tab_switches, backspace)

        records.append(
            {
                "keys": keys,
                "mouse_distance": mouse_distance,
                "tab_switches": tab_switches,
                "backspace": backspace,
                "fatigue_score": score,
                "risk_index": risk,
            }
        )

    return pd.DataFrame(records)


def ensure_dataset():
    dataset = build_synthetic_dataset()
    dataset.to_csv(DATA_PATH, index=False)
    return dataset


def train_and_save_model(verbose=True):
    dataset = ensure_dataset()
    features = dataset[FEATURE_COLUMNS]
    labels = dataset["risk_index"]

    x_train, x_test, y_train, y_test = train_test_split(
        features,
        labels,
        test_size=0.2,
        random_state=42,
        stratify=labels,
    )

    models = {
        "random_forest": RandomForestClassifier(
            n_estimators=250,
            max_depth=8,
            random_state=42,
        ),
        "xgboost": XGBClassifier(
            n_estimators=250,
            max_depth=5,
            learning_rate=0.08,
            subsample=0.9,
            colsample_bytree=0.9,
            objective="multi:softprob",
            num_class=3,
            eval_metric="mlogloss",
            random_state=42,
        ),
    }

    best_name = None
    best_model = None
    best_accuracy = -1.0

    for model_name, model in models.items():
        model.fit(x_train, y_train)
        predictions = model.predict(x_test)
        accuracy = accuracy_score(y_test, predictions)

        if accuracy > best_accuracy:
            best_name = model_name
            best_model = model
            best_accuracy = accuracy

    joblib.dump(
        {
            "model_name": best_name,
            "accuracy": best_accuracy,
            "feature_columns": FEATURE_COLUMNS,
            "feature_weights": FEATURE_WEIGHTS,
            "fatigue_output_scale": FATIGUE_OUTPUT_SCALE,
            "risk_thresholds": RISK_THRESHOLDS,
            "reference_states": REFERENCE_STATES,
            "model": best_model,
        },
        MODEL_PATH,
    )

    if verbose:
        print(
            json.dumps(
                {
                    "dataset_path": str(DATA_PATH),
                    "model_path": str(MODEL_PATH),
                    "best_model": best_name,
                    "accuracy": round(best_accuracy, 4),
                    "feature_weights": FEATURE_WEIGHTS,
                    "risk_thresholds": RISK_THRESHOLDS,
                    "class_distribution": dataset["risk_index"].value_counts().sort_index().to_dict(),
                }
            )
        )


def load_model_bundle():
    if not MODEL_PATH.exists():
        train_and_save_model(verbose=False)
    return joblib.load(MODEL_PATH)


def predict_risk(keys, mouse_distance, tab_switches, backspace=0):
    bundle = load_model_bundle()
    model = bundle["model"]
    feature_columns = bundle["feature_columns"]

    frame = pd.DataFrame(
        [
            {
                "keys": int(keys),
                "mouse_distance": float(mouse_distance),
                "tab_switches": int(tab_switches),
                "backspace": int(backspace),
            }
        ]
    )[feature_columns]

    risk_index = int(model.predict(frame)[0])
    probabilities = model.predict_proba(frame)[0]
    probability = round(float(probabilities[risk_index]), 4)
    score = fatigue_score(keys, mouse_distance, tab_switches, backspace)

    return {
        "risk_index": risk_index,
        "probability": probability,
        "fatigue_score": score,
    }


def main():
    if len(sys.argv) in (4, 5):
        keys = int(sys.argv[1])
        mouse_distance = float(sys.argv[2])
        tab_switches = int(sys.argv[3])
        backspace = int(sys.argv[4]) if len(sys.argv) == 5 else 0
        print(json.dumps(predict_risk(keys, mouse_distance, tab_switches, backspace)))
        return

    train_and_save_model()


if __name__ == "__main__":
    main()
