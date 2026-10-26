// Audio player wrapper around one hidden <audio> element, plus waveform peak computation.

const TIME_INTERVAL_MS = 100; // "time" events fire about 10 times per second
const MAX_DECODE_BYTES = 150 * 1024 * 1024;

export function createPlayer() {
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.setAttribute("playsinline", "");
  audio.playsInline = true;
  audio.style.display = "none";
  try {
    audio.preservesPitch = true;
    audio.webkitPreservesPitch = true;
  } catch (e) {
    /* ignore */
  }
  document.body.appendChild(audio);

  const listeners = new Map();
  let objectUrl = null;
  let loadToken = 0;
  let timer = null;
  let lastTimeEmit = 0;
  let rate = 1;

  function emit(event, arg) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(arg);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function emitTime(force) {
    const now = performance.now();
    if (!force && now - lastTimeEmit < TIME_INTERVAL_MS - 10) return;
    lastTimeEmit = now;
    emit("time", audio.currentTime);
  }

  function startTimer() {
    if (timer === null) timer = setInterval(() => emitTime(false), TIME_INTERVAL_MS);
  }

  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function revoke() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  // Smooth clock: audio.currentTime advances in coarse steps on iOS Safari, so the time between
  // updates is interpolated with performance.now(). The anchor pairs a media time with a clock reading.
  const MAX_AHEAD = 0.6; // never run further than this ahead of the raw media time
  const MAX_BACK = 0.02; // tolerated backward step between two reads
  const anchor = { media: 0, perf: 0, raw: 0 };
  let lastSmooth = null;

  function reanchor() {
    const raw = audio.currentTime || 0;
    anchor.media = raw;
    anchor.raw = raw;
    anchor.perf = performance.now();
    lastSmooth = null; // jumps (seek, rate change, play, pause) are exact
  }

  for (const ev of ["play", "playing", "pause", "seeking", "seeked", "ratechange", "waiting", "loadedmetadata"]) {
    audio.addEventListener(ev, reanchor);
  }

  function smoothTime() {
    const raw = audio.currentTime || 0;
    if (audio.paused || audio.ended) return raw;
    if (raw !== anchor.raw) {
      // The media clock moved: new anchor, but keep the output from jumping backwards.
      anchor.media = raw;
      anchor.raw = raw;
      anchor.perf = performance.now();
    }
    const elapsed = Math.max(0, (performance.now() - anchor.perf) / 1000);
    let t = anchor.media + elapsed * (audio.playbackRate || 1);
    t = Math.min(t, raw + MAX_AHEAD);
    if (lastSmooth !== null) t = Math.max(t, lastSmooth - MAX_BACK);
    const d = audio.duration;
    if (Number.isFinite(d) && d > 0) t = Math.min(t, d);
    t = Math.max(0, t);
    lastSmooth = t;
    return t;
  }

  audio.addEventListener("play", () => {
    startTimer();
    emit("state", true);
  });
  audio.addEventListener("pause", () => {
    stopTimer();
    emitTime(true);
    emit("state", false);
  });
  audio.addEventListener("ended", () => {
    stopTimer();
    emitTime(true);
    emit("state", false);
    emit("ended");
  });
  audio.addEventListener("timeupdate", () => emitTime(false));
  audio.addEventListener("seeked", () => emitTime(true));
  audio.addEventListener("error", () => {
    // Ignore the error caused by clearing src in unload().
    if (!audio.getAttribute("src")) return;
    emit("error", new Error("This audio file could not be played."));
  });
  window.addEventListener("pagehide", revoke);

  // MediaRecorder webm files often report an infinite duration until the end has been read once.
  function fixInfiniteDuration() {
    return new Promise((resolve) => {
      if (audio.duration !== Infinity) {
        resolve();
        return;
      }
      const done = () => {
        audio.removeEventListener("timeupdate", done);
        audio.currentTime = 0;
        resolve();
      };
      audio.addEventListener("timeupdate", done);
      audio.currentTime = 1e101;
      setTimeout(done, 3000);
    });
  }

  const player = {
    load(blob) {
      const token = ++loadToken;
      player.unload();
      return new Promise((resolve, reject) => {
        if (!(blob instanceof Blob)) {
          reject(new Error("No audio to load."));
          return;
        }
        const cleanup = () => {
          audio.removeEventListener("loadedmetadata", onMeta);
          audio.removeEventListener("error", onErr);
        };
        const onMeta = async () => {
          cleanup();
          await fixInfiniteDuration();
          if (token !== loadToken) {
            reject(new Error("Load was replaced by a newer one."));
            return;
          }
          audio.playbackRate = rate;
          emit("loaded");
          resolve();
        };
        const onErr = () => {
          cleanup();
          reject(new Error("This audio file could not be opened."));
        };
        audio.addEventListener("loadedmetadata", onMeta);
        audio.addEventListener("error", onErr);
        objectUrl = URL.createObjectURL(blob);
        audio.src = objectUrl;
        audio.load();
      });
    },

    unload() {
      stopTimer();
      try {
        audio.pause();
      } catch (e) {
        /* ignore */
      }
      audio.removeAttribute("src");
      audio.load();
      revoke();
    },

    async play() {
      try {
        await audio.play();
      } catch (e) {
        // AbortError happens when a pause or new load interrupts play(); not worth reporting.
        if (e && e.name !== "AbortError") emit("error", e);
      }
    },

    pause() {
      audio.pause();
    },

    toggle() {
      return audio.paused ? player.play() : (audio.pause(), Promise.resolve());
    },

    seek(sec, { play = false } = {}) {
      const max = player.duration;
      let t = Number(sec) || 0;
      t = Math.max(0, max ? Math.min(t, max) : t);
      audio.currentTime = t;
      if (play) return player.play();
      return Promise.resolve();
    },

    setRate(r) {
      const v = Number(r);
      if (!v || v <= 0) return;
      rate = v;
      audio.defaultPlaybackRate = v;
      audio.playbackRate = v;
    },

    get rate() {
      return rate;
    },

    get currentTime() {
      return audio.currentTime || 0;
    },

    // Interpolated playback time for smooth UI such as the word marker.
    smoothTime,

    get duration() {
      const d = audio.duration;
      return Number.isFinite(d) ? d : 0;
    },

    get playing() {
      return !audio.paused && !audio.ended;
    },

    // Returns an unsubscribe function.
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
  };

  return player;
}

// Context at a low sample rate: decodeAudioData resamples to it, which keeps the decoded buffer small
// (90 minutes mono at 8 kHz is about 170 MB instead of 1 GB or more at 48 kHz).
function createDecodeContext() {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (Offline) {
    for (const rate of [8000, 16000, 22050, 44100]) {
      try {
        return new Offline(1, 1, rate);
      } catch (e) {
        /* unsupported rate, try next */
      }
    }
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) return new Ctx();
  return null;
}

const yieldToUi = () => new Promise((r) => setTimeout(r));

// Normalized RMS per bucket (0..1) for a waveform display.
export async function computePeaks(blob, buckets = 600) {
  if (!(blob instanceof Blob)) throw new Error("No audio to analyse.");
  if (blob.size > MAX_DECODE_BYTES) throw new Error("This file is too large to draw a waveform.");
  const ctx = createDecodeContext();
  if (!ctx) throw new Error("Waveform is not supported in this browser.");

  let buffer;
  try {
    const data = await blob.arrayBuffer();
    // Callback form as a fallback for older Safari versions without promise support.
    buffer = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });
  } catch (e) {
    throw new Error("The waveform could not be computed for this file.");
  } finally {
    try {
      if (ctx.close) ctx.close();
    } catch (e) {
      /* offline contexts cannot be closed */
    }
  }

  const n = Math.max(1, Math.floor(buckets));
  const total = buffer.length;
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const peaks = new Float32Array(n);
  let max = 0;
  let sinceYield = 0;

  for (let b = 0; b < n; b++) {
    const start = Math.floor((b * total) / n);
    const end = Math.max(start + 1, Math.floor(((b + 1) * total) / n));
    let sum = 0;
    for (let i = start; i < end && i < total; i++) {
      for (let c = 0; c < channels.length; c++) {
        const v = channels[c][i];
        sum += v * v;
      }
    }
    const count = Math.max(1, Math.min(end, total) - start) * channels.length;
    const rms = Math.sqrt(sum / count);
    peaks[b] = rms;
    if (rms > max) max = rms;
    sinceYield += (end - start) * channels.length;
    if (sinceYield >= 200000) {
      sinceYield = 0;
      await yieldToUi();
    }
  }

  if (max > 0) for (let b = 0; b < n; b++) peaks[b] /= max;
  return peaks;
}
