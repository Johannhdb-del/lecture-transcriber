// Microphone recorder. Chunks are persisted to IndexedDB every 5 s so a crash or
// reload never loses more than the last few seconds (see recoverRecordings).
import {
  appendRecordingChunk,
  assembleRecording,
  deleteRecordingSession,
  getRecordingSessions,
} from "./media-store.js";

const TIMESLICE_MS = 5000;
const TICK_MS = 250;
const LEVEL_MS = 66; // ~15 updates per second
const STOP_TIMEOUT_MS = 8000;
const AUDIO_BITS_PER_SECOND = 96000;

// Sessions owned by a live recorder in this page; hidden from recoverRecordings().
const activeSessions = new Set();

export function isRecordingSupported() {
  return !!(
    typeof navigator !== "undefined" &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder === "function"
  );
}

function pickMimeType() {
  const MR = window.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== "function") return "";
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  for (const type of candidates) {
    try {
      if (MR.isTypeSupported(type)) return type;
    } catch (e) {
      /* try next */
    }
  }
  return ""; // let the browser choose its default
}

function extensionFor(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("ogg")) return "ogg";
  return "m4a"; // audio/mp4, audio/aac, unknown
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function recordingName(date, type) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  return (
    `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}.${extensionFor(type)}`
  );
}

function newSessionId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `rec-${Date.now()}-${rand}`;
}

function safeCall(fn, ...args) {
  if (typeof fn !== "function") return;
  try {
    fn(...args);
  } catch (e) {
    /* never let a UI callback break recording */
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function micErrorMessage(e) {
  const name = e && e.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was denied. Allow microphone access for this site in the browser settings and try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found on this device.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The microphone is busy or unavailable. Close other apps that use it and try again.";
  }
  return "The microphone could not be started" + (e && e.message ? ": " + e.message : ".");
}

// Detect the container from the first bytes (the media store keeps no type metadata).
async function sniffType(blob) {
  try {
    const buf = await blob.slice(0, 12).arrayBuffer();
    const b = new Uint8Array(buf);
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      return "audio/webm";
    }
    if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      return "audio/mp4"; // "ftyp"
    }
    if (b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) {
      return "audio/ogg";
    }
  } catch (e) {
    /* fall through */
  }
  return "audio/mp4";
}

export function createRecorder({ onLevel, onTick, onChunkSaved, onError, onPcm } = {}) {
  let state = "idle"; // idle | recording | paused | stopping
  let sessionId = null;
  let mediaRecorder = null;
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let pcmNode = null; // AudioWorkletNode feeding onPcm (16 kHz Int16 frames)
  let pcmSink = null; // zero gain node that keeps the worklet in the pulled graph
  let wakeLock = null;
  let mimeType = "";
  let startedAt = null;

  let nextIndex = 0;
  let saveChain = Promise.resolve();
  let storedCount = 0; // chunks successfully written to IndexedDB (indices 0..storedCount-1)
  let storedBytes = 0;
  let memMode = false; // true after the first failed write: later chunks stay in memory
  let memTail = []; // chunks not in the store, in order
  let firstChunkType = "";

  let accMs = 0;
  let segStart = null;
  let tickTimer = null;
  let levelTimer = null;
  let stoppedPromise = null;
  let resolveStopped = null;
  let stopPromise = null;
  let trackCleanups = [];
  let visibilityBound = false;

  const report = (message) => safeCall(onError, new Error(message));

  // --- clock ------------------------------------------------------------
  function clockStart() {
    if (segStart === null) segStart = performance.now();
  }
  function clockStop() {
    if (segStart !== null) {
      accMs += performance.now() - segStart;
      segStart = null;
    }
  }
  function elapsedMs() {
    return accMs + (segStart !== null ? performance.now() - segStart : 0);
  }

  // --- timers / level meter ----------------------------------------------
  function startTimers() {
    stopTimers();
    tickTimer = setInterval(() => {
      if (state === "recording" || state === "paused") safeCall(onTick, elapsedMs() / 1000);
    }, TICK_MS);
    if (analyser) {
      const data = new Uint8Array(analyser.fftSize);
      levelTimer = setInterval(() => {
        if (state !== "recording") {
          safeCall(onLevel, 0);
          return;
        }
        try {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          const db = rms > 0 ? 20 * Math.log10(rms) : -100;
          safeCall(onLevel, Math.max(0, Math.min(1, (db + 60) / 60)));
        } catch (e) {
          /* meter is cosmetic */
        }
      }, LEVEL_MS);
    }
  }
  function stopTimers() {
    if (tickTimer) clearInterval(tickTimer);
    if (levelTimer) clearInterval(levelTimer);
    tickTimer = levelTimer = null;
  }

  // --- wake lock / visibility -------------------------------------------
  async function requestWakeLock() {
    try {
      if (!("wakeLock" in navigator) || wakeLock) return;
      const lock = await navigator.wakeLock.request("screen");
      if (state === "idle" || state === "stopping") {
        lock.release().catch(() => {});
        return;
      }
      wakeLock = lock;
      lock.addEventListener("release", () => {
        if (wakeLock === lock) wakeLock = null;
      });
    } catch (e) {
      wakeLock = null; // not fatal (low battery, unsupported, denied)
    }
  }
  function releaseWakeLock() {
    const lock = wakeLock;
    wakeLock = null;
    if (lock) {
      try {
        lock.release().catch(() => {});
      } catch (e) {
        /* ignore */
      }
    }
  }
  function onVisibility() {
    if (document.visibilityState !== "visible") return;
    if (state !== "recording" && state !== "paused") return;
    requestWakeLock();
    if (audioCtx && audioCtx.state !== "running" && audioCtx.state !== "closed") {
      audioCtx.resume().catch(() => {});
    }
  }
  function bindVisibility() {
    if (!visibilityBound) {
      document.addEventListener("visibilitychange", onVisibility);
      visibilityBound = true;
    }
  }
  function unbindVisibility() {
    if (visibilityBound) {
      document.removeEventListener("visibilitychange", onVisibility);
      visibilityBound = false;
    }
  }

  // --- resources ---------------------------------------------------------
  function releaseResources() {
    stopTimers();
    unbindVisibility();
    releaseWakeLock();
    for (const fn of trackCleanups) {
      try {
        fn();
      } catch (e) {
        /* ignore */
      }
    }
    trackCleanups = [];
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch (e) {
          /* ignore */
        }
      }
    }
    stream = null;
    try {
      if (sourceNode) sourceNode.disconnect();
    } catch (e) {
      /* ignore */
    }
    sourceNode = null;
    if (pcmNode) {
      try {
        pcmNode.port.onmessage = null;
        pcmNode.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    if (pcmSink) {
      try {
        pcmSink.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    pcmNode = null;
    pcmSink = null;
    analyser = null;
    if (audioCtx) {
      const ctx = audioCtx;
      audioCtx = null;
      try {
        ctx.close().catch(() => {});
      } catch (e) {
        /* ignore */
      }
    }
    safeCall(onLevel, 0);
  }

  function resetSession() {
    mediaRecorder = null;
    stoppedPromise = null;
    resolveStopped = null;
    state = "idle";
  }

  // --- chunk persistence -------------------------------------------------
  function enqueueChunk(blob) {
    const index = nextIndex++;
    const id = sessionId;
    if (!firstChunkType && blob.type) firstChunkType = blob.type;
    // Always go through the chain so ordering is preserved even after a failure.
    saveChain = saveChain.then(async () => {
      if (memMode) {
        memTail.push(blob);
        return;
      }
      try {
        await appendRecordingChunk(id, index, blob);
        storedCount = index + 1;
        storedBytes += blob.size;
        safeCall(onChunkSaved, { sessionId: id, index, size: blob.size, totalBytes: storedBytes, chunks: storedCount });
      } catch (e) {
        memMode = true;
        memTail.push(blob);
        report(
          "Could not save the recording to this device's storage (it may be full). " +
            "Recording continues in memory; keep this page open and stop the recording to save it."
        );
      }
    });
  }

  // --- API ---------------------------------------------------------------
  async function start() {
    if (state !== "idle") throw new Error("A recording is already in progress.");
    if (!isRecordingSupported()) {
      throw new Error("Recording is not supported in this browser.");
    }
    state = "stopping"; // blocks re-entrancy while permission prompt is open

    // Must happen synchronously inside the user gesture (before any await).
    let ctx = null;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        ctx = new AC();
        ctx.resume().catch(() => {});
      }
    } catch (e) {
      ctx = null; // meter unavailable, recording still works
    }

    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      });
    } catch (e) {
      if (ctx) ctx.close().catch(() => {});
      state = "idle";
      throw new Error(micErrorMessage(e));
    }

    stream = s;
    audioCtx = ctx;

    try {
      // Level meter (optional).
      if (ctx) {
        try {
          if (ctx.state !== "running") ctx.resume().catch(() => {});
          sourceNode = ctx.createMediaStreamSource(s);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.3;
          sourceNode.connect(analyser); // not connected to destination: no feedback
        } catch (e) {
          analyser = null;
        }
      }

      // Optional PCM tap for live transcription. Failure never stops the recording.
      if (typeof onPcm === "function") {
        try {
          if (!ctx || !sourceNode) throw new Error("no audio graph");
          if (!ctx.audioWorklet || typeof AudioWorkletNode !== "function") throw new Error("no AudioWorklet");
          await ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url).href);
          const node = new AudioWorkletNode(ctx, "pcm-downsampler", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            channelCountMode: "explicit",
          });
          node.port.onmessage = (ev) => {
            if (state === "recording" && ev.data) safeCall(onPcm, ev.data);
          };
          // Zero gain to the destination: Safari only pulls nodes that reach the output, and nothing is audible.
          const sink = ctx.createGain();
          sink.gain.value = 0;
          sourceNode.connect(node);
          node.connect(sink);
          sink.connect(ctx.destination);
          pcmNode = node;
          pcmSink = sink;
          if (ctx.state !== "running") ctx.resume().catch(() => {});
        } catch (e) {
          report("Live text could not start (the audio filter failed to load). Recording continues without it.");
        }
      }

      // Recorder with preferred mime type, falling back to the browser default.
      const preferred = pickMimeType();
      let mr = null;
      if (preferred) {
        try {
          mr = new MediaRecorder(s, { mimeType: preferred, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
        } catch (e) {
          try {
            mr = new MediaRecorder(s, { mimeType: preferred });
          } catch (e2) {
            mr = null;
          }
        }
      }
      if (!mr) mr = new MediaRecorder(s);
      mediaRecorder = mr;
      mimeType = mr.mimeType || preferred || "";

      // Reset per-session state.
      sessionId = newSessionId();
      activeSessions.add(sessionId);
      startedAt = new Date();
      nextIndex = 0;
      saveChain = Promise.resolve();
      storedCount = 0;
      storedBytes = 0;
      memMode = false;
      memTail = [];
      firstChunkType = "";
      accMs = 0;
      segStart = null;
      stoppedPromise = new Promise((resolve) => {
        resolveStopped = resolve;
      });

      mr.addEventListener("dataavailable", (ev) => {
        if (ev.data && ev.data.size > 0) enqueueChunk(ev.data);
      });
      mr.addEventListener("error", (ev) => {
        const detail = ev && ev.error && ev.error.message ? ": " + ev.error.message : "";
        report("The recorder reported an error" + detail + ". Audio recorded so far is kept; stop the recording to save it.");
      });
      mr.addEventListener("stop", () => {
        // Fires on our stop() and also if the browser ends the recording itself.
        if (state === "recording" || state === "paused") {
          clockStop();
          stopTimers();
          safeCall(onLevel, 0);
        }
        if (resolveStopped) resolveStopped();
      });

      // Microphone track events.
      for (const track of s.getAudioTracks()) {
        const onEnded = () => {
          if (state !== "recording" && state !== "paused") return;
          clockStop();
          report("The microphone was disconnected or access was taken away (for example by a call or another app). Your recording so far is kept; press stop to save it.");
        };
        const onMute = () => {
          if (state !== "recording") return;
          report("The microphone was muted by the system (for example by a call or Siri). The recording may contain silence until it comes back.");
        };
        track.addEventListener("ended", onEnded);
        track.addEventListener("mute", onMute);
        trackCleanups.push(() => {
          track.removeEventListener("ended", onEnded);
          track.removeEventListener("mute", onMute);
        });
      }

      mr.start(TIMESLICE_MS);
      state = "recording";
      clockStart();
      bindVisibility();
      requestWakeLock();
      startTimers();
    } catch (e) {
      if (sessionId) activeSessions.delete(sessionId);
      releaseResources();
      sessionId = null;
      resetSession();
      throw new Error("The recorder could not be started" + (e && e.message ? ": " + e.message : "."));
    }
  }

  function pause() {
    if (state !== "recording" || !mediaRecorder) return;
    try {
      if (mediaRecorder.state === "recording") mediaRecorder.pause();
    } catch (e) {
      report("Could not pause the recording.");
      return;
    }
    clockStop();
    state = "paused";
    safeCall(onLevel, 0);
  }

  function resume() {
    if (state !== "paused" || !mediaRecorder) return;
    try {
      if (mediaRecorder.state === "paused") mediaRecorder.resume();
    } catch (e) {
      report("Could not resume the recording.");
      return;
    }
    if (audioCtx && audioCtx.state !== "running" && audioCtx.state !== "closed") {
      audioCtx.resume().catch(() => {});
    }
    state = "recording";
    clockStart();
    requestWakeLock();
  }

  async function doStop() {
    const id = sessionId;
    const mr = mediaRecorder;
    const waitStopped = stoppedPromise;
    clockStop();
    stopTimers();
    try {
      if (mr && mr.state !== "inactive") mr.stop();
    } catch (e) {
      report("The recorder did not stop cleanly; saving what was recorded.");
    }
    // The final dataavailable event fires before "stop".
    await Promise.race([waitStopped, delay(STOP_TIMEOUT_MS)]);
    const durationSec = accMs / 1000;
    releaseResources();
    await saveChain;

    const type = (mr && mr.mimeType) || mimeType || firstChunkType || "";
    const parts = [];
    try {
      if (storedCount > 0) parts.push(await assembleRecording(id, type));
    } catch (e) {
      // Chunks stay in IndexedDB for recoverRecording().
      activeSessions.delete(id);
      throw new Error(
        "The recording was captured but could not be assembled. It is kept on this device and can be recovered from the recordings list."
      );
    }
    for (const b of memTail) parts.push(b);
    if (parts.length === 0) {
      activeSessions.delete(id);
      try {
        await deleteRecordingSession(id);
      } catch (e) {
        /* ignore */
      }
      throw new Error("Nothing was recorded.");
    }
    const blob = new Blob(parts, type ? { type } : {});
    const result = {
      blob,
      type: blob.type || type,
      durationSec,
      name: recordingName(startedAt, type),
    };
    // Delete the stored chunks only now that the final blob exists.
    try {
      await deleteRecordingSession(id);
    } catch (e) {
      /* leftover chunks are harmless; offered again by recoverRecordings() */
    }
    activeSessions.delete(id);
    memTail = [];
    return result;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    if (state !== "recording" && state !== "paused") {
      return Promise.reject(new Error("There is no recording to stop."));
    }
    state = "stopping";
    stopPromise = doStop().finally(() => {
      // Always return to idle, even on failure, so the user can try again.
      resetSession();
      stopPromise = null;
    });
    return stopPromise;
  }

  return {
    start,
    pause,
    resume,
    stop,
    get state() {
      return state;
    },
    get sessionId() {
      return sessionId;
    },
  };
}

export async function recoverRecordings() {
  try {
    const list = await getRecordingSessions();
    return (Array.isArray(list) ? list : []).filter((s) => !activeSessions.has(s.sessionId));
  } catch (e) {
    return [];
  }
}

// Does not delete the session; the caller deletes it after saving the audio.
export async function recoverRecording(sessionId) {
  const raw = await assembleRecording(sessionId, "");
  if (!raw || !raw.size) throw new Error("This recording has no audio data.");
  const type = await sniffType(raw);
  let startedAt = null;
  try {
    const list = await getRecordingSessions();
    const found = (list || []).find((s) => s.sessionId === sessionId);
    if (found && found.startedAt) startedAt = new Date(found.startedAt);
  } catch (e) {
    /* name falls back to now */
  }
  return {
    blob: new Blob([raw], { type }),
    type,
    name: recordingName(startedAt, type),
  };
}
