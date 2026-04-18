const cors = require("cors");
const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 5001;
const MAX_LOGS = 100;
const EVALUATION_WINDOW_SIZE = 6;
/** UI bands on rounded percent (score×10): 0–30 LOW, 31–59 MEDIUM, 60+ HIGH */
const IDLE_DECAY_PER_EVALUATION = 1.5;
/** 12 × 5s windows = 60s of consecutive idle telemetry → overall score forced to 100% */
const IDLE_MINUTE_WINDOWS = 12;
const logs = [];
let evaluationBatch = [];
let consecutiveIdleWindows = 0;
let overallState = {
  has_prediction: false,
  status: "collecting",
  fatigue_score: 0,
  score: 0,
  risk: "WAITING",
  risk_index: null,
  trend_delta: 0,
  windows_collected: 0,
  windows_required: EVALUATION_WINDOW_SIZE,
  evaluations_completed: 0,
  batch_average: 0,
  updated_at: null,
  idle_inactive: false,
};
const FRONTEND_DIST = path.join(__dirname, "frontend", "dist");

const RISK_LABELS = {
  0: "LOW",
  1: "MEDIUM",
  2: "HIGH",
};

const RISK_INDEX_BY_LABEL = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  WAITING: null,
};

const PYTHON_SCRIPT = path.join(__dirname, "train_and_predict.py");

function resolvePythonRuntime() {
  if (process.env.PYTHON_BIN) {
    return { command: process.env.PYTHON_BIN, prefixArgs: [] };
  }

  if (process.platform === "win32") {
    const windowsCandidates = [
      "C:\\Program Files\\Python312\\python.exe",
      "C:\\Python312\\python.exe",
    ];

    const resolved = windowsCandidates.find((candidate) => fs.existsSync(candidate));
    if (resolved) {
      return { command: resolved, prefixArgs: [] };
    }

    return { command: "py", prefixArgs: ["-3"] };
  }

  return { command: "python3", prefixArgs: [] };
}

const PYTHON_RUNTIME = resolvePythonRuntime();

app.use(cors());
app.use(express.json());

function trimLogs() {
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS);
  }
}

function buildFallbackResponse(input) {
  return {
    window_risk: "MEDIUM",
    window_score: 0.5,
    window_fatigue_score: 5,
    model_probability: 0.5,
    window_risk_index: 1,
    telemetry: input,
    source: "fallback",
    timestamp: new Date().toISOString(),
  };
}

function roundScore(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function isIdleTelemetry(telemetry) {
  return (
    telemetry.keys === 0 &&
    telemetry.mouse_distance === 0 &&
    telemetry.tab_switches === 0 &&
    telemetry.backspace === 0
  );
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Matches frontend rollingRisk.js: rounded % = round(score×10). */
function riskFromFatigueScore(score) {
  const percent = Math.round(Number(score) * 10);
  if (percent >= 60) {
    return "HIGH";
  }
  if (percent > 30) {
    return "MEDIUM";
  }
  return "LOW";
}

function resetRollingState() {
  evaluationBatch = [];
  consecutiveIdleWindows = 0;
  overallState = {
    has_prediction: false,
    status: "collecting",
    fatigue_score: 0,
    score: 0,
    risk: "WAITING",
    risk_index: null,
    trend_delta: 0,
    windows_collected: 0,
    windows_required: EVALUATION_WINDOW_SIZE,
    evaluations_completed: 0,
    batch_average: 0,
    updated_at: null,
    idle_inactive: false,
  };
}

function getOverallCollectionState(status) {
  let nextStatus = status;
  if (!nextStatus) {
    if (overallState.idle_inactive) {
      nextStatus = "idle_inactive";
    } else if (overallState.has_prediction) {
      nextStatus = "collecting_next";
    } else {
      nextStatus = "collecting";
    }
  }

  return {
    ...overallState,
    status: nextStatus,
    windows_collected: evaluationBatch.length,
    windows_required: EVALUATION_WINDOW_SIZE,
    idle_inactive: Boolean(overallState.idle_inactive),
  };
}

function evaluateThirtySecondBatch() {
  const completedBatch = evaluationBatch.slice(0, EVALUATION_WINDOW_SIZE);
  const scores = completedBatch.map((entry) => Number(entry.window_fatigue_score || 0));
  const batchAverage = average(scores);
  const batchMax = scores.length ? Math.max(...scores) : 0;
  const effectiveBatch = roundScore(batchAverage * 0.5 + batchMax * 0.5);
  const batchIsIdle = completedBatch.every((entry) => isIdleTelemetry(entry.telemetry));
  const previousScore = Number(overallState.fatigue_score || 0);
  const trendDelta = overallState.has_prediction ? effectiveBatch - previousScore : 0;
  let nextScore = effectiveBatch;

  if (overallState.has_prediction) {
    if (batchIsIdle) {
      nextScore = Math.max(batchAverage, previousScore - IDLE_DECAY_PER_EVALUATION);
    } else if (effectiveBatch >= previousScore) {
      nextScore = previousScore * 0.2 + effectiveBatch * 0.8;
    } else {
      nextScore = previousScore * 0.62 + effectiveBatch * 0.38;
    }
  }

  nextScore = roundScore(Math.max(0, Math.min(10, nextScore)));
  const risk = riskFromFatigueScore(nextScore);

  overallState = {
    has_prediction: true,
    status: "evaluated",
    fatigue_score: nextScore,
    score: roundScore(nextScore / 10),
    risk,
    risk_index: RISK_INDEX_BY_LABEL[risk],
    trend_delta: roundScore(trendDelta),
    windows_collected: EVALUATION_WINDOW_SIZE,
    windows_required: EVALUATION_WINDOW_SIZE,
    evaluations_completed: Number(overallState.evaluations_completed || 0) + 1,
    batch_average: roundScore(batchAverage),
    updated_at: new Date().toISOString(),
    idle_inactive: false,
  };

  evaluationBatch = evaluationBatch.slice(EVALUATION_WINDOW_SIZE);
  return overallState;
}

function addWindowAndMaybeEvaluate(windowResult) {
  evaluationBatch.push(windowResult);

  if (evaluationBatch.length >= EVALUATION_WINDOW_SIZE) {
    return evaluateThirtySecondBatch();
  }

  return getOverallCollectionState("collecting");
}

function predictWithPython({ keys, mouse_distance, tab_switches, backspace }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      PYTHON_RUNTIME.command,
      [
        ...PYTHON_RUNTIME.prefixArgs,
        PYTHON_SCRIPT,
        String(keys),
        String(mouse_distance),
        String(tab_switches),
        String(backspace),
      ],
      {
        cwd: __dirname,
        windowsHide: true,
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Python exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Invalid Python response: ${stdout || error.message}`));
      }
    });
  });
}

function validateTelemetry(body) {
  const payload = body?.metrics
    ? {
        keys: body.metrics.keys ?? body.metrics.keys_pressed,
        mouse_distance:
          body.metrics.mouse_distance ?? body.metrics.mouse_travel_pixels,
        tab_switches: body.metrics.tab_switches,
        backspace: body.metrics.backspace ?? body.metrics.backspaces,
      }
    : body;

  const keys = Number(payload?.keys);
  const mouseDistance = Number(payload?.mouse_distance);
  const tabSwitches = Number(payload?.tab_switches);
  const backspace = Number(payload?.backspace ?? 0);

  if (
    !Number.isFinite(keys) ||
    !Number.isFinite(mouseDistance) ||
    !Number.isFinite(tabSwitches) ||
    !Number.isFinite(backspace)
  ) {
    return null;
  }

  return {
    keys: Math.round(Number(keys)),
    mouse_distance: Number(mouseDistance),
    tab_switches: Math.round(Number(tabSwitches)),
    backspace: Math.round(Number(backspace)),
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "online" });
});

app.post("/api/telemetry", async (req, res) => {
  const telemetry = validateTelemetry(req.body);

  if (!telemetry) {
    res.status(400).json({
      error: "Invalid telemetry payload. Expected keys, mouse_distance, tab_switches, backspace.",
    });
    return;
  }

  if (isIdleTelemetry(telemetry)) {
    consecutiveIdleWindows += 1;
  } else {
    consecutiveIdleWindows = 0;
    overallState.idle_inactive = false;
  }

  let responsePayload;

  try {
    const prediction = await predictWithPython(telemetry);
    const windowFatigueScore = Number(prediction.fatigue_score) || 0;
    responsePayload = {
      success: true,
      window_risk: RISK_LABELS[prediction.risk_index] || "MEDIUM",
      window_score: roundScore(windowFatigueScore / 10),
      window_fatigue_score: windowFatigueScore,
      model_probability: Number(prediction.probability) || 0.5,
      window_risk_index: prediction.risk_index,
      telemetry,
      source: "model",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    responsePayload = buildFallbackResponse(telemetry);
    responsePayload.success = false;
    responsePayload.error = error.message;
  }

  let mergedOverall = addWindowAndMaybeEvaluate(responsePayload);

  if (isIdleTelemetry(telemetry) && consecutiveIdleWindows >= IDLE_MINUTE_WINDOWS) {
    overallState = {
      ...overallState,
      has_prediction: true,
      status: "idle_inactive",
      fatigue_score: 10,
      score: 1,
      risk: "HIGH",
      risk_index: 2,
      trend_delta: 0,
      windows_collected: evaluationBatch.length,
      windows_required: EVALUATION_WINDOW_SIZE,
      updated_at: new Date().toISOString(),
      idle_inactive: true,
    };
    mergedOverall = getOverallCollectionState("idle_inactive");
  }

  const hasOverallPrediction = Boolean(mergedOverall.has_prediction);

  responsePayload = {
    ...responsePayload,
    risk: hasOverallPrediction ? mergedOverall.risk : "WAITING",
    score: hasOverallPrediction ? mergedOverall.score : null,
    fatigue_score: hasOverallPrediction ? mergedOverall.fatigue_score : null,
    risk_index: hasOverallPrediction ? mergedOverall.risk_index : null,
    overall: mergedOverall,
  };

  logs.push(responsePayload);
  trimLogs();

  res.json(responsePayload);
});

app.get("/api/telemetry", (_req, res) => {
  res.json({
    success: true,
    count: logs.length,
    overall: getOverallCollectionState(),
    data: logs,
  });
});

app.get("/api/logs", (_req, res) => {
  res.json(logs);
});

app.post("/api/reset", (_req, res) => {
  logs.splice(0, logs.length);
  resetRollingState();
  res.json({ success: true, overall: getOverallCollectionState() });
});

if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }

    res.sendFile(path.join(FRONTEND_DIST, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.json({ status: "online", frontend: "not-built" });
  });
}

app.listen(PORT, () => {
  console.log(`Fatigue backend listening on http://localhost:${PORT}`);
});
