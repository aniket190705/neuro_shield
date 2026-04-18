const TELEMETRY_ENDPOINTS = [
  "http://localhost:5001/api/telemetry",
  "http://127.0.0.1:5001/api/telemetry",
  "http://[::1]:5001/api/telemetry"
];
let globalTaskSwitches = 0;

const markTabSwitch = () => {
  globalTaskSwitches += 1;
};

const postTelemetry = async (payload) => {
  let lastError = null;
  const telemetryPayload = {
    ...payload,
    metrics: {
      ...payload.metrics,
      tab_switches: globalTaskSwitches
    }
  };

  for (const endpoint of TELEMETRY_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(telemetryPayload),
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${endpoint}`);
      }

      const prediction = await response.json().catch(() => null);

      globalTaskSwitches = 0;
      return {
        ok: true,
        endpoint,
        telemetry: telemetryPayload,
        prediction
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { ok: false, error: lastError || "All loopback endpoints failed" };
};

/** Plain zeros so the server can count 60s idle even when the tab is in the background. */
const postIdleHeartbeat = async () => {
  const body = JSON.stringify({
    keys: 0,
    mouse_distance: 0,
    tab_switches: 0,
    backspace: 0,
  });
  let lastError = null;

  for (const endpoint of TELEMETRY_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body,
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${endpoint}`);
      }

      await response.json().catch(() => null);
      return { ok: true, endpoint };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { ok: false, error: lastError || "All loopback endpoints failed" };
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TAB_SWITCH_EVENT") {
    markTabSwitch();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "IDLE_HEARTBEAT") {
    postIdleHeartbeat()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (message?.type !== "SEND_TELEMETRY") {
    return false;
  }

  postTelemetry(message.payload)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});
