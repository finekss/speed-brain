async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Analyze tab audio locally to detect pauses and preserve playback audio."
  });
}

async function saveDebugEvent(area, event, details = {}) {
  const key = "speedBrainDebugLog";
  const stored = await chrome.storage.local.get(key);
  const log = stored[key] || [];
  log.push({ at: new Date().toISOString(), area, event, details });
  await chrome.storage.local.set({ [key]: log.slice(-200) });
  console.debug("[Speed Brain]", area, event, details);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SPEED_BRAIN_FORWARD_TO_TAB") {
    chrome.tabs.sendMessage(Number(message.tabId), message.payload).catch(error => {
      if (message.payload?.type !== "SPEED_BRAIN_AUDIO_LEVEL") {
        saveDebugEvent("worker", "tab-message-forward-error", {
          tabId: message.tabId,
          error: error.message || String(error)
        }).catch(console.error);
      }
    });
    return;
  }
  if (message?.type === "SPEED_BRAIN_DEBUG") {
    saveDebugEvent(message.area || "unknown", message.event || "event", message.details || {}).catch(console.error);
    return;
  }
  if (message?.type === "SPEED_BRAIN_CLEAR_DEBUG") {
    chrome.storage.local.remove("speedBrainDebugLog");
    return;
  }
  if (message?.type !== "SPEED_BRAIN_START_CAPTURE" && message?.type !== "SPEED_BRAIN_STOP_CAPTURE") return;

  (async () => {
    if (message.type === "SPEED_BRAIN_STOP_CAPTURE") {
      await saveDebugEvent("worker", "capture-stop-request");
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (contexts.length) await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAPTURE" });
      sendResponse({ ok: true });
      return;
    }

    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) throw new Error("No active tab was selected.");
    await saveDebugEvent("worker", "capture-start-request", { tabId });
    await ensureOffscreenDocument();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await saveDebugEvent("worker", "stream-id-created", { tabId });
    const captureResult = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "START_CAPTURE",
      streamId,
      tabId
    });
    if (!captureResult?.ok) throw new Error(captureResult?.error || "Audio capture did not start.");
    await saveDebugEvent("worker", "capture-active", { tabId });
    sendResponse({ ok: true });
  })().catch(error => {
    saveDebugEvent("worker", "capture-request-error", { error: error.message || String(error) }).catch(console.error);
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});
