
(() => {
  if (window.__speedBrainLoaded) return;
  window.__speedBrainLoaded = true;

  const DEFAULTS = {
    enabled: true,
    speechSpeed: 1.25,
    silenceSpeed: 2.0,
    threshold: -55,
    silenceDelay: 700,
    rampDuration: 600
  };

  let settings = { ...DEFAULTS };

  let video = null;
  let currentMode = "speech";
  let silenceSince = 0;
  let speedTransition = null;
  let lastAppliedRate = 1;
  let videoListeners = [];
  let eventsVideo = null;
  let currentSource = "";

  function debug(event, details = {}) {
    chrome.runtime.sendMessage({ type: "SPEED_BRAIN_DEBUG", area: "content", event, details }).catch(() => {});
  }

  // UI
  const indicator = document.createElement("div");

  indicator.id = "speed-brain-indicator";
  indicator.innerHTML = `
    <span class="sb-dot"></span>
    <span class="sb-label">SPEED SPEECH</span>
    <span class="sb-speed">1.25x</span>
  `;

  const style = document.createElement("style");

  style.textContent = `
    #speed-brain-indicator {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      display: none;
      align-items: center;
      gap: 9px;
      padding: 11px 15px;
      background: rgba(17,17,23,.94);
      color: white;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 12px;
      font: 600 12px Arial,sans-serif;
      box-shadow: 0 5px 25px rgba(0,0,0,.25);
      pointer-events: none;
    }

    #speed-brain-indicator .sb-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #8b5cf6;
    }

    #speed-brain-indicator .sb-speed {
      color: #a78bfa;
    }
  `;

  document.documentElement.appendChild(style);
  document.documentElement.appendChild(indicator);

  function showIndicator(mode, speed) {
    if (!settings.enabled) {
      indicator.style.display = "none";
      return;
    }

    indicator.style.display = "flex";

    indicator.querySelector(".sb-label").textContent = mode;
    indicator.querySelector(".sb-speed").textContent =
      `${speed.toFixed(2)}x`;
  }

  function setSpeed(speed) {
    if (!video || !settings.enabled) return;

    const targetRate = Number(speed);
    if (lastAppliedRate === targetRate && speedTransition !== null) return;

    if (speedTransition !== null) {
      cancelAnimationFrame(speedTransition);
      speedTransition = null;
    }

    const startRate = video.playbackRate;
    const duration = Math.max(0, Number(settings.rampDuration));
    const startedAt = performance.now();
    lastAppliedRate = targetRate;

    if (duration === 0) {
      video.playbackRate = targetRate;
      showIndicator(currentMode === "speech" ? "SPEECH" : "SILENCE", targetRate);
      return;
    }

    const transition = now => {
      if (!video || !settings.enabled) {
        speedTransition = null;
        return;
      }
      const progress = Math.min(1, (now - startedAt) / duration);
      // Smoothstep easing avoids an abrupt change at either end.
      const eased = progress * progress * (3 - 2 * progress);
      const currentRate = startRate + (targetRate - startRate) * eased;
      video.playbackRate = currentRate;
      showIndicator(currentMode === "speech" ? "SPEECH" : "SILENCE", currentRate);
      if (progress < 1) {
        speedTransition = requestAnimationFrame(transition);
      } else {
        speedTransition = null;
        video.playbackRate = targetRate;
        showIndicator(currentMode === "speech" ? "SPEECH" : "SILENCE", targetRate);
      }
    };

    speedTransition = requestAnimationFrame(transition);

    showIndicator(currentMode === "speech" ? "SPEECH" : "SILENCE", startRate);
  }

  function stopAnalysis() {
    if (speedTransition !== null) {
      cancelAnimationFrame(speedTransition);
      speedTransition = null;
    }
    silenceSince = 0;
  }

  function resetForSourceChange() {
    stopAnalysis();
    currentMode = "speech";
    silenceSince = 0;
    if (settings.enabled && video) setSpeed(settings.speechSpeed);
  }

  function attachVideoEvents(target) {
    for (const [eventName, handler] of videoListeners) {
      eventsVideo?.removeEventListener(eventName, handler);
    }
    videoListeners = [];
    eventsVideo = target;

    const checkSource = () => {
      const newSource = target.currentSrc || target.src || "";
      if (newSource && newSource !== currentSource) {
        currentSource = newSource;
        debug("video-source-change", { readyState: target.readyState, paused: target.paused });
        resetForSourceChange();
      }
    };
    const onEmptied = () => {
      currentSource = "";
      resetForSourceChange();
    };

    for (const eventName of ["loadstart", "loadedmetadata", "loadeddata", "canplay", "playing"]) {
      const handler = checkSource;
      target.addEventListener(eventName, handler);
      videoListeners.push([eventName, handler]);
    }
    target.addEventListener("emptied", onEmptied);
    videoListeners.push(["emptied", onEmptied]);
  }

  function handleAudioLevel(volume) {
    if (!settings.enabled || !video || !Number.isFinite(volume)) return;
    if (video.paused || video.ended) {
      showIndicator("PAUSED", video.playbackRate);
      silenceSince = 0;
      return;
    }
    const now = performance.now();
    const threshold = Number(settings.threshold);
    const isQuiet = currentMode === "silence" ? volume < threshold + 3 : volume < threshold;
    if (!isQuiet) {
      silenceSince = 0;
      if (currentMode !== "speech") {
        currentMode = "speech";
        debug("mode-change", { mode: currentMode, volumeDb: Number(volume.toFixed(1)), thresholdDb: threshold });
        setSpeed(settings.speechSpeed);
      }
    } else {
      if (!silenceSince) silenceSince = now;
      if (currentMode !== "silence" && now - silenceSince >= Math.max(0, Number(settings.silenceDelay))) {
        currentMode = "silence";
        debug("mode-change", { mode: currentMode, volumeDb: Number(volume.toFixed(1)), thresholdDb: threshold });
        setSpeed(settings.silenceSpeed);
      }
    }

  }

  function bindVideo() {
    const nextVideo =
      document.querySelector("video.html5-main-video") ||
      document.querySelector("video");

    if (!nextVideo || nextVideo === video) return;

    stopAnalysis();

    video = nextVideo;
    debug("video-bound", { readyState: video.readyState, paused: video.paused });
    currentSource = video.currentSrc || video.src || "";
    attachVideoEvents(video);
    currentMode = "speech";

    if (settings.enabled) {
      setSpeed(settings.speechSpeed);

      showIndicator("WAITING FOR AUDIO", settings.speechSpeed);
    }
  }

  function applySettings(newSettings) {
    settings = {
      ...DEFAULTS,
      ...newSettings
    };
    debug("settings-applied", {
      enabled: settings.enabled,
      speechSpeed: settings.speechSpeed,
      silenceSpeed: settings.silenceSpeed,
      thresholdDb: settings.threshold,
      silenceDelayMs: settings.silenceDelay,
      rampDurationMs: settings.rampDuration
    });

    if (!settings.enabled) {
      stopAnalysis();

      if (video) {
        video.playbackRate = 1;
      }

      indicator.style.display = "none";
      currentMode = "speech";

      return;
    }

    bindVideo();

    if (video) {
      setSpeed(currentMode === "speech" ? settings.speechSpeed : settings.silenceSpeed);
    }
  }

  // Popup messages
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "UPDATE_SETTINGS") {
      applySettings(message.settings || {});
    } else if (message?.type === "SPEED_BRAIN_AUDIO_LEVEL") {
      handleAudioLevel(Number(message.volume));
    } else if (message?.type === "SPEED_BRAIN_CAPTURE_STATE" && video && settings.enabled) {
      debug("capture-state", { state: message.state });
      showIndicator(message.state === "active" ? currentMode.toUpperCase() :
        message.state === "stopped" ? "WAITING FOR AUDIO" : "AUDIO ERROR", video.playbackRate);
    }
  });

  // Load saved settings
  chrome.storage.local.get(null, stored => {
    const result = { ...DEFAULTS, ...stored };
    if (result.threshold === -48 && result.silenceDelay === 300 && stored.rampDuration === undefined) {
      result.threshold = DEFAULTS.threshold;
      result.silenceDelay = DEFAULTS.silenceDelay;
      chrome.storage.local.set({ threshold: result.threshold, silenceDelay: result.silenceDelay });
    }
    applySettings(result);
  });

  // Live settings updates
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    const updatedSettings = {};

    for (const key of Object.keys(DEFAULTS)) {
      if (changes[key]) {
        updatedSettings[key] = changes[key].newValue;
      }
    }

    if (Object.keys(updatedSettings).length === 0) return;

    applySettings({
      ...settings,
      ...updatedSettings
    });
  });

  // Detect YouTube video changes
  const observer = new MutationObserver(() => {
    bindVideo();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  setInterval(() => {
    bindVideo();
  }, 1500);

})();
