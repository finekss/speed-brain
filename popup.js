
const DEFAULTS = {
  enabled: true,
  speechSpeed: 1,
  silenceSpeed: 2.0,
  threshold: -55,
  silenceDelay: 100,
  rampDuration: 600
};

const controls = {
  enabled: document.getElementById("enabled"),
  speechSpeed: document.getElementById("speechSpeed"),
  silenceSpeed: document.getElementById("silenceSpeed"),
  threshold: document.getElementById("threshold"),
  silenceDelay: document.getElementById("silenceDelay"),
  rampDuration: document.getElementById("rampDuration")
};

const status = document.getElementById("status");

let loaded = false;
let saveTimer;
let lastEnabled = null;

async function connectTabAudio() {
  if (!controls.enabled.checked) {
    status.textContent = "TURN ON";
    return;
  }

  const button = document.getElementById("captureAudio");
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("No active tab found.");
    const result = await chrome.runtime.sendMessage({
      type: "SPEED_BRAIN_START_CAPTURE",
      tabId: tab.id
    });
    if (!result?.ok) throw new Error(result?.error || "Could not capture tab audio.");
    button.textContent = "Connected";
    status.textContent = "ON";
    chrome.runtime.sendMessage({ type: "SPEED_BRAIN_DEBUG", area: "popup", event: "connect-request-sent", details: { tabId: tab.id } }).catch(() => {});
  } catch (error) {
    button.textContent = "Connect debug";
    status.textContent = "ERROR";
    chrome.runtime.sendMessage({ type: "SPEED_BRAIN_DEBUG", area: "popup", event: "connect-request-failed", details: { error: error.message } }).catch(() => {});
    console.error(error);
  } finally {
    button.disabled = false;
  }
}

async function disconnectTabAudio() {
  try {
    await chrome.runtime.sendMessage({ type: "SPEED_BRAIN_STOP_CAPTURE" });
    document.getElementById("captureAudio").textContent = "Connect";
  } catch (error) {
    console.error(error);
  }
}

function getSettings() {
  return {
    enabled: controls.enabled.checked,
    speechSpeed: Number(controls.speechSpeed.value),
    silenceSpeed: Number(controls.silenceSpeed.value),
    threshold: Number(controls.threshold.value),
    silenceDelay: Number(controls.silenceDelay.value),
    rampDuration: Number(controls.rampDuration.value)
  };
}

function updateLabels() {
  document.getElementById("speechValue").textContent =
    Number(controls.speechSpeed.value).toFixed(2) + "x";

  document.getElementById("silenceValue").textContent =
    Number(controls.silenceSpeed.value).toFixed(2) + "x";

  document.getElementById("thresholdValue").textContent =
    controls.threshold.value + " dB";

  document.getElementById("delayValue").textContent =
    controls.silenceDelay.value + " ms";

  document.getElementById("rampValue").textContent =
    controls.rampDuration.value + " ms";

  status.textContent = controls.enabled.checked ? "ON" : "OFF";
}

async function saveSettings() {
  if (!loaded) return;

  try {
    const next = getSettings();
    await chrome.storage.local.set(next);
    if (lastEnabled !== null && lastEnabled !== next.enabled) {
      lastEnabled = next.enabled;
      if (!next.enabled) await disconnectTabAudio();
      else await connectTabAudio();
    }
    status.textContent = "SAVED";
  } catch (error) {
    console.error(error);
    status.textContent = "ERROR";
  }
}

function scheduleSave(immediate = false) {
  if (!loaded) return;

  updateLabels();
  clearTimeout(saveTimer);

  if (immediate) {
    saveSettings();
  } else {
    saveTimer = setTimeout(saveSettings, 150);
  }
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(null);
    const settings = { ...DEFAULTS, ...stored };
    if (settings.threshold === -48 && settings.silenceDelay === 300 && stored.rampDuration === undefined) {
      settings.threshold = DEFAULTS.threshold;
      settings.silenceDelay = DEFAULTS.silenceDelay;
      await chrome.storage.local.set({ threshold: settings.threshold, silenceDelay: settings.silenceDelay });
    }

    for (const [key, control] of Object.entries(controls)) {
      if (key === "enabled") {
        control.checked = Boolean(settings[key]);
      } else {
        control.value = settings[key];
      }
    }

    loaded = true;
    lastEnabled = Boolean(settings.enabled);
    updateLabels();
  } catch (error) {
    status.textContent = "ERROR";
    console.error(error);
  }
}

Object.values(controls).forEach(control => {
  control.addEventListener("input", () => scheduleSave());
  control.addEventListener("change", () => scheduleSave(true));
});

document.getElementById("captureAudio").addEventListener("click", connectTabAudio);

const diagnosticPanel = document.getElementById("diagnostics");
const diagnosticText = document.getElementById("debugLog");

async function loadDebugLog() {
  const stored = await chrome.storage.local.get("speedBrainDebugLog");
  diagnosticText.value = (stored.speedBrainDebugLog || [])
    .map(entry => `${entry.at} [${entry.area}] ${entry.event} ${JSON.stringify(entry.details)}`)
    .join("\n");
  diagnosticText.scrollTop = diagnosticText.scrollHeight;
}

diagnosticPanel.addEventListener("toggle", () => {
  if (diagnosticPanel.open) loadDebugLog().catch(console.error);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.speedBrainDebugLog && diagnosticPanel.open) {
    loadDebugLog().catch(console.error);
  }
});

document.getElementById("copyLog").addEventListener("click", async () => {
  await loadDebugLog();
  try {
    await navigator.clipboard.writeText(diagnosticText.value);
    status.textContent = "COPED";
  } catch (_) {
    diagnosticText.focus();
    diagnosticText.select();
    status.textContent = "SELECT LOG";
  }
});

document.getElementById("clearLog").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SPEED_BRAIN_CLEAR_DEBUG" });
  diagnosticText.value = "";
});

document.getElementById("reset").addEventListener("click", async () => {
  if (!loaded) return;

  clearTimeout(saveTimer);

  for (const [key, control] of Object.entries(controls)) {
    if (key === "enabled") {
      control.checked = DEFAULTS[key];
    } else {
      control.value = DEFAULTS[key];
    }
  }

  updateLabels();
  await saveSettings();
});

loadSettings();
