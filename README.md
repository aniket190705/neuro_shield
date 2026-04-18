# 🧠 NeuroShield: Real-Time Human Error & Fatigue Predictor

> **The problem:** In critical industries, fatigue goes undetected until a failure occurs.

## 🚀 The solution
Current fatigue monitoring systems rely on invasive webcams or self-reporting. NeuroShield takes a different approach. By passively monitoring non-invasive behavioral signals like erratic mouse movements, typing pace drops, and frantic context-switching, our machine learning engine calculates a real-time cognitive risk score without ever recording the actual keys pressed or screens viewed.

## 🏗️ System Architecture
We built a highly responsive, parallel-processing pipeline designed to evaluate telemetry in 5-second windows:
1. **The Tracker (Frontend):** A lightweight Manifest V3 Chrome Extension injects into the browser, silently tallying metrics (keystrokes, backspace ratios, mouse travel distance, and visibility changes).
2. **The Bridge (Backend):** A Node.js/Express REST API catches these 5-second JSON payloads and saves the raw telemetry to a PostgreSQL database.
3. **The Brain (AI/ML):** The Node server uses `child_process` to spawn a Python script, passing the metrics to a pre-trained Scikit-Learn **Random Forest Classifier** to generate an immediate Risk Score (Low, Medium, High).
4. **The Dashboard (UI):** A real-time visualization layer that polls the database to display the user's current cognitive state.

## 🧠 The Machine Learning Model
Since real-world fatigue telemetry is highly restricted, we engineered a custom synthetic dataset. 
* We mapped realistic 5-second human physical limitations (e.g., a fast typist hitting 20 keys vs. a fatigued typist hitting 4 keys).
* We trained our Random Forest model using combined behavioral features, enabling it to capture patterns across different signals that indicate fatigue. 

## 🛠️ Tech Stack
* **Frontend:** Vanilla JavaScript (Chrome Extension API)
* **Backend:** Node.js, Express.js
* **Machine Learning:** Python 3, Pandas, Scikit-Learn, NumPy, RandomForestClassifier

## 🏃‍♂️ How to Run Locally
## 🛠️ Setup Instructions

Follow these steps to run the project locally:
### 1️⃣ Clone the Repository

```bash
git clone <repo-url>
cd human-error-fatigue-predictor
```

---

### 2️⃣ Backend Setup

```bash
cd backend
npm install
npm start
```

---

### 3️⃣ Machine Learning Setup

```bash
cd ml
pip install -r requirements.txt
python train_model.py
```

---

### 4️⃣ Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

---

### 5️⃣ Chrome Extension Setup

1. Open Chrome and go to:
   `chrome://extensions`

2. Enable **Developer Mode** (top right)

3. Click **"Load unpacked"**

4. Select the `extension/` folder from the project

---

### ✅ You're Ready!

* Backend running on: `http://localhost:3000`
* Frontend running on: `http://localhost:5173`
* Extension will start sending data automatically

---

## ⚠️ Challenges & Improvements

### 🔹 Feature Weighting Challenge

One major challenge we faced was determining the right importance (weights) for each feature. Not all signals such as typing speed, mouse movement, and tab switching, contribute equally to fatigue detection. Initially, improper weighting led to misleading predictions. We improved our feature engineering step by step balance the contribution of each signal.

---

### 🔹 Time-Window Stability Issue

During testing, we found that predictions based on 5-second data were too unstable and inconsistent, since such short intervals didn’t capture enough meaningful user behavior. To fix this, we introduced a 30-second rolling window by aggregating six consecutive 5-second intervals. This gave us a more complete and reliable view of user activity, significantly improving the accuracy of our fatigue predictions.

---

## 🚀 Future Scope

In the future, we aim to extend the system by introducing a dedicated dashboard for supervisors (team leaders managing 10-15 members). This dashboard will allow supervisors to monitor the fatigue levels of each team member in real time.

The supervisor will be able to view individual risk levels and receive alerts when any team member shows signs of high fatigue or cognitive overload. This can help in taking timely actions such as task redistribution, breaks, or intervention to prevent critical errors.
