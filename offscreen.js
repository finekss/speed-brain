let stream = null;
let audioContext = null;
let analyser = null;
let source = null;
let loopback = null;
let levelTimer = null;
let capturedTabId = null;
let sampleCount = 0;
let sampleMin = Infinity;
let sampleMax = -Infinity;
let sampleSum = 0;

function debug(event, details = {}) {
  chrome.runtime.sendMessage({ type: "SPEED_BRAIN_DEBUG", area: "offscreen", event, details }).catch(() => {});
}

function notifyTab(tabId, payload) {
  chrome.runtime.sendMessage({
    type: "SPEED_BRAIN_FORWARD_TO_TAB",
    tabId,
    payload
  }).catch(error => debug("tab-message-forward-error", { tabId, error: error.message || String(error) }));
}

async function stopCapture(reason = "requested") {
  const stoppedTabId = capturedTabId;
  if (levelTimer !== null) clearInterval(levelTimer);
  levelTimer = null;
  if (source) source.disconnect();
  if (analyser) analyser.disconnect();
  if (loopback) loopback.disconnect();
  source = analyser = loopback = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  if (audioContext && audioContext.state !== "closed") await audioContext.close();
  audioContext = null;
  if (stoppedTabId !== null) {
    debug("capture-stopped", { tabId: stoppedTabId, reason });
    notifyTab(stoppedTabId, { type: "SPEED_BRAIN_CAPTURE_STATE", state: "stopped" });
  }
  capturedTabId = null;
}

async function startCapture(streamId, tabId) {
  if (capturedTabId === tabId && stream && stream.getAudioTracks().some(track => track.readyState === "live")) {
    notifyTab(tabId, { type: "SPEED_BRAIN_CAPTURE_STATE", state: "active" });
    return true;
  }
  await stopCapture("replaced-by-new-request");

  try {
    debug("capture-starting", { tabId });
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false
    });
    capturedTabId = tabId;
    audioContext = new AudioContext();
    source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;

    loopback = audioContext.createGain();
    loopback.gain.value = 1;
    source.connect(analyser);
    analyser.connect(loopback);
    loopback.connect(audioContext.destination);
    await audioContext.resume();
    debug("capture-active", {
      tabId,
      audioTracks: stream.getAudioTracks().length,
      trackState: stream.getAudioTracks()[0]?.readyState,
      audioContextState: audioContext.state
    });

    const samples = new Float32Array(analyser.fftSize);
    levelTimer = setInterval(() => {
      if (!analyser || capturedTabId === null) return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      const volume = rms > 0 ? 20 * Math.log10(rms) : -100;
      sampleCount++;
      sampleMin = Math.min(sampleMin, volume);
      sampleMax = Math.max(sampleMax, volume);
      sampleSum += volume;
      if (sampleCount >= 25) {
        debug("audio-level-window", {
          tabId: capturedTabId,
          minDb: Number(sampleMin.toFixed(1)),
          maxDb: Number(sampleMax.toFixed(1)),
          meanDb: Number((sampleSum / sampleCount).toFixed(1)),
          trackMuted: stream.getAudioTracks()[0]?.muted ?? null,
          contextState: audioContext?.state
        });
        sampleCount = 0;
        sampleMin = Infinity;
        sampleMax = -Infinity;
        sampleSum = 0;
      }
      notifyTab(capturedTabId, {
        type: "SPEED_BRAIN_AUDIO_LEVEL",
        volume
      });
    }, 80);

    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        debug("audio-track-ended", { tabId, trackState: track.readyState });
        operationQueue = operationQueue.then(() => stopCapture("audio-track-ended"))
          .catch(error => debug("capture-stop-error", { error: error.message || String(error) }));
      }, { once: true });
      track.addEventListener("mute", () => debug("audio-track-muted", { tabId }), { once: false });
      track.addEventListener("unmute", () => debug("audio-track-unmuted", { tabId }), { once: false });
    }
    notifyTab(tabId, { type: "SPEED_BRAIN_CAPTURE_STATE", state: "active" });
    return true;
  } catch (error) {
    console.error("Speed Brain tab audio capture failed:", error);
    debug("capture-error", { tabId, error: error.message || String(error) });
    await stopCapture("capture-error");
    notifyTab(tabId, { type: "SPEED_BRAIN_CAPTURE_STATE", state: "error" });
    return false;
  }
}

let operationQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return;
  if (message.type === "START_CAPTURE") {
    operationQueue = operationQueue.then(() => startCapture(message.streamId, message.tabId))
      .then(ok => sendResponse({ ok }))
      .catch(error => {
        debug("capture-queue-error", { error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }
  if (message.type === "STOP_CAPTURE") {
    operationQueue = operationQueue.then(() => stopCapture("user-disabled"))
      .then(() => sendResponse({ ok: true }))
      .catch(error => {
        debug("capture-stop-error", { error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }
});
