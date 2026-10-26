// "New transcription" screen: upload or record, then transcribe with progress inside the card.
import * as storage from "../storage.js";
import * as deepgram from "../engines/deepgram.js";
import * as fmt from "../format.js";
import * as exp from "../export.js";
import * as media from "../media-store.js";
import { createRecorder, isRecordingSupported, recoverRecordings, recoverRecording } from "../recorder.js";
import {
  h, icon, iconBtn, pill, selectWrap, alertBox, errorMessage, baseName, plural, dedupeTerms,
  formatDateTime, clock, LANGUAGES,
} from "./dom.js";
import { state, setBusy } from "./state.js";

const MAX_TERMS_WARNING = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const METER_BARS = 36;
const CHUNK_SECONDS = 5; // the recorder saves a chunk every 5 seconds

/* Wake lock while the transcription runs ----------------------------- */

let wakeLock = null;

async function acquireWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    wakeLock = null; // unsupported or denied: ignore
  }
}

function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch { /* ignore */ }
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (state.running && document.visibilityState === "visible" && !wakeLock) acquireWakeLock();
});

/* The view ------------------------------------------------------------ */

export function createNewView(ctx) {
  const st = {
    file: null,
    source: "upload",       // "upload" | "recording"
    mode: "idle",           // idle | ready | starting | recording | paused | stopping | running
    langTouched: false,
    job: null,
    cancelled: false,
    phase: null,
    phaseStart: 0,
    timer: null,
    recorder: null,
    recovered: null,        // session id of a recovered recording that is still stored as chunks
    levels: new Array(METER_BARS).fill(0),
  };
  const alert = alertBox();

  /* Elements ---------------------------------------------------------- */

  const fileInput = h("input", {
    type: "file",
    class: "visually-hidden",
    accept: "audio/*,video/*,.m4a,.mp4,.mp3,.wav,.mov,.webm",
    tabindex: "-1",
    "aria-hidden": "true",
    onchange() {
      const f = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      fileInput.value = "";
      if (f) setFile(f, "upload");
    },
  });

  // Placeholder or chosen file
  const placeholder = h("div", { class: "compose-placeholder" });

  // Recording panel
  const recDot = h("span", { class: "rec-dot", "aria-hidden": "true" });
  const recTime = h("span", { class: "rec-time", text: "0:00" });
  const recState = h("span", { class: "rec-state", text: "Recording" });
  const meter = h("div", { class: "meter", "aria-hidden": "true" },
    Array.from({ length: METER_BARS }, () => h("span", { class: "meter-bar" })));
  const pauseBtn = pill("Pause", { iconName: "pause", onclick: () => togglePause() });
  const stopBtn = pill("Stop", { iconName: "stop", primary: true, onclick: () => stopRecording() });
  const recPanel = h("div", { class: "rec-panel", hidden: true },
    h("div", { class: "rec-top" }, recDot, recTime, recState),
    meter,
    h("p", { class: "hint", text: "Keep this screen on and stay in this app while recording. Locking the screen or switching apps can interrupt the microphone." }),
    h("div", { class: "btn-row" }, pauseBtn, stopBtn));

  // Ready panel (opened from the Record button in the sidebar)
  const readyPanel = h("div", { class: "rec-ready", hidden: true },
    h("button", { type: "button", class: "rec-big", "aria-label": "Start recording", onclick: () => startRecording() },
      h("span", { class: "rec-big-dot" })),
    h("p", { class: "muted", text: "Tap to start recording" }));

  // Progress panel
  const phaseText = h("span", { text: "Uploading" });
  const percentText = h("span", { text: "0%" });
  const barFill = h("div", { class: "bar-fill" });
  const bar = h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0", "aria-label": "Progress" }, barFill);
  const cancelBtn = pill("Cancel", { danger: true, onclick: () => cancel() });
  const progress = h("div", { class: "progress-box", hidden: true, "aria-live": "polite" },
    h("div", { class: "progress-line" }, phaseText, percentText),
    bar,
    h("p", { class: "hint", text: "Keep the screen on and stay in this tab until the transcript is ready. Long lectures can take several minutes." }),
    h("div", { class: "btn-row" }, cancelBtn));

  // Action row
  const uploadBtn = pill("Upload", { iconName: "upload", onclick: () => fileInput.click() });
  const recordBtn = pill("Record", { iconName: "mic", onclick: () => startRecording() });
  const sendBtn = h("button", {
    type: "button",
    class: "icon-btn primary send",
    "aria-label": "Start transcription",
    title: "Start transcription",
    disabled: true,
    onclick: () => start(),
  }, icon("arrowUp", 22));
  const actions = h("div", { class: "compose-actions" }, uploadBtn, recordBtn, h("span", { class: "spacer" }), sendBtn);

  const card = h("div", { class: "compose-card" },
    h("div", { class: "compose-main" }, placeholder, readyPanel, recPanel, progress),
    actions);

  // Options
  const langSelect = h("select", { "aria-label": "Language", onchange() { st.langTouched = true; } },
    LANGUAGES.map((l) => h("option", { value: l.value, text: l.label })));
  const listSelect = h("select", {
    "aria-label": "Keyterm list",
    onchange() {
      try { storage.saveSettings({ keytermListId: listSelect.value }); } catch { /* ignore */ }
      updateTerms();
    },
  });
  const extraTerms = h("textarea", {
    rows: 4,
    placeholder: "One term per line, for example names and technical words",
    "aria-label": "Extra terms for this lecture",
    spellcheck: false,
    autocapitalize: "none",
    oninput: () => updateTerms(),
  });
  const termCount = h("p", { class: "hint", text: "0 terms" });
  const termWarn = h("div", { class: "alert warn", hidden: true, text: `You have more than ${MAX_TERMS_WARNING} terms. Deepgram works best with a shorter list, and extra terms may be ignored or reduce accuracy.` });
  const extraBox = h("details", { class: "extra" },
    h("summary", {}, h("span", { text: "Extra terms" }), icon("chevronDown", 16)),
    h("div", { class: "extra-body stack-sm" }, extraTerms, termCount, termWarn));
  const options = h("div", { class: "options" },
    h("label", { class: "opt" }, h("span", { text: "Language" }), selectWrap(langSelect)),
    h("label", { class: "opt" }, h("span", { text: "Keyterms" }), selectWrap(listSelect)),
    extraBox);

  // Recovery banner
  const banner = h("div", { class: "banner", hidden: true });

  const el = h("div", { class: "page" },
    h("div", { class: "page-inner new-inner" },
      h("h1", { class: "hero", text: "Transcribe a lecture" }),
      alert.el,
      banner,
      card,
      options,
      fileInput));

  // Drag and drop (desktop)
  card.addEventListener("dragover", (e) => { if (st.mode === "idle" || st.mode === "ready") { e.preventDefault(); card.classList.add("drop"); } });
  card.addEventListener("dragleave", () => card.classList.remove("drop"));
  card.addEventListener("drop", (e) => {
    card.classList.remove("drop");
    if (st.mode !== "idle" && st.mode !== "ready") return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    setFile(f, "upload");
  });

  /* Rendering the card ------------------------------------------------ */

  function renderPlaceholder() {
    if (!st.file) {
      placeholder.replaceChildren(h("p", { class: "ph-text", text: "Choose a recording or record a lecture" }));
      return;
    }
    const nodes = [
      h("div", { class: "file-chip" },
        icon("file", 20),
        h("div", { class: "file-meta" },
          h("span", { class: "file-name", text: st.file.name }),
          h("span", { class: "file-size", text: `${fmt.formatBytes(st.file.size)}${st.source === "recording" ? " · recorded here" : ""}` })),
        iconBtn("x", "Remove file", () => removeFile(), "ghost")),
    ];
    if (st.source === "recording") {
      nodes.push(h("div", { class: "btn-row" },
        pill("Save to device", { iconName: "download", cls: "small", onclick: () => saveToDevice() })));
    }
    placeholder.replaceChildren(...nodes);
  }

  function update() {
    const m = st.mode;
    const busy = m === "running";
    const recording = m === "starting" || m === "recording" || m === "paused" || m === "stopping";
    placeholder.hidden = busy || recording || m === "ready";
    readyPanel.hidden = m !== "ready";
    recPanel.hidden = !recording;
    progress.hidden = !busy;
    actions.hidden = busy || recording;
    sendBtn.disabled = !st.file || busy || recording;
    recordBtn.disabled = !isRecordingSupported();
    recordBtn.title = isRecordingSupported() ? "" : "Recording is not supported in this browser";
    for (const c of [langSelect, listSelect, extraTerms]) c.disabled = busy;
    card.classList.toggle("is-recording", recording);

    recDot.classList.toggle("paused", m === "paused");
    recState.textContent = m === "paused" ? "Paused" : m === "stopping" ? "Saving" : m === "starting" ? "Starting" : "Recording";
    pauseBtn.firstChild.replaceWith(icon(m === "paused" ? "record" : "pause", 18));
    pauseBtn.lastChild.textContent = m === "paused" ? "Resume" : "Pause";
    pauseBtn.disabled = m === "starting" || m === "stopping";
    stopBtn.disabled = m === "starting" || m === "stopping";

    renderPlaceholder();
    refreshBanner();
  }

  function setFile(file, source) {
    alert.clear();
    if (source === "upload") st.recovered = null;
    st.file = file;
    st.source = source;
    if (st.mode === "ready") st.mode = "idle";
    update();
  }

  function removeFile() {
    st.file = null;
    st.recovered = null;
    update();
  }

  function saveToDevice() {
    if (!st.file) return;
    try { exp.downloadFile(st.file.name, st.file, st.file.type || "audio/mp4"); } catch (err) { alert.show(errorMessage(err)); }
  }

  /* Terms and options ------------------------------------------------- */

  function getTerms() {
    let listTerms = [];
    if (listSelect.value) {
      const list = storage.listKeytermLists().find((l) => l.id === listSelect.value);
      if (list) listTerms = list.terms || [];
    }
    let extra = [];
    try { extra = fmt.parseKeyterms(extraTerms.value); } catch { extra = []; }
    return dedupeTerms([...listTerms, ...extra]);
  }

  function updateTerms() {
    const n = getTerms().length;
    termCount.textContent = `${plural(n, "term", "terms")} will be sent to Deepgram.`;
    termWarn.hidden = n <= MAX_TERMS_WARNING;
  }

  function refreshOptions() {
    if (state.running) return;
    const s = storage.getSettings();
    if (!st.langTouched) langSelect.value = s.language || "de";
    const lists = storage.listKeytermLists();
    const wanted = listSelect.value || s.keytermListId || "";
    listSelect.replaceChildren(
      h("option", { value: "", text: "None" }),
      ...lists.map((l) => h("option", { value: l.id, text: `${l.name} (${plural((l.terms || []).length, "term", "terms")})` })));
    listSelect.value = lists.some((l) => l.id === wanted) ? wanted : "";
    updateTerms();
  }

  /* Recording --------------------------------------------------------- */

  function drawMeter() {
    const bars = meter.children;
    for (let i = 0; i < bars.length; i++) {
      bars[i].style.transform = `scaleY(${Math.max(0.06, st.levels[i])})`;
    }
  }

  function pushLevel(l) {
    st.levels.push(Math.max(0, Math.min(1, Number(l) || 0)));
    st.levels.shift();
    drawMeter();
  }

  async function startRecording() {
    if (st.mode !== "idle" && st.mode !== "ready") return;
    alert.clear();
    if (!isRecordingSupported()) {
      alert.show("Recording is not supported in this browser. Choose a file instead.");
      return;
    }
    if (st.file && st.source === "recording" && !window.confirm("Replace the current recording? It has not been transcribed yet. Use Save to device first if you want to keep it.")) return;

    const rec = createRecorder({
      onLevel: pushLevel,
      onTick: (sec) => { recTime.textContent = clock(sec); },
      onError: (err) => alert.show(errorMessage(err), "warn"),
    });
    st.mode = "starting";
    st.levels.fill(0);
    recTime.textContent = "0:00";
    setBusy({ recording: true });
    update();
    try {
      await rec.start(); // called inside the click, so the browser allows the microphone prompt
    } catch (err) {
      st.mode = "idle";
      setBusy({ recording: false });
      alert.show(errorMessage(err));
      update();
      return;
    }
    st.recorder = rec;
    st.mode = "recording";
    update();
  }

  function togglePause() {
    const rec = st.recorder;
    if (!rec) return;
    if (st.mode === "recording") { rec.pause(); st.mode = "paused"; }
    else if (st.mode === "paused") { rec.resume(); st.mode = "recording"; }
    update();
  }

  async function stopRecording() {
    const rec = st.recorder;
    if (!rec || (st.mode !== "recording" && st.mode !== "paused")) return;
    st.mode = "stopping";
    update();
    try {
      const out = await rec.stop();
      const file = new File([out.blob], out.name, { type: out.type || out.blob.type || "audio/mp4" });
      st.recorder = null;
      st.mode = "idle";
      st.recovered = null;
      setBusy({ recording: false });
      setFile(file, "recording");
    } catch (err) {
      st.recorder = null;
      st.mode = "idle";
      setBusy({ recording: false });
      alert.show(errorMessage(err));
      update();
    }
  }

  /* Recovery of unfinished recordings --------------------------------- */

  let bannerToken = 0;

  async function refreshBanner() {
    const mine = ++bannerToken;
    if (st.mode !== "idle" && st.mode !== "ready") { banner.hidden = true; return; }
    let sessions = [];
    try { sessions = await recoverRecordings(); } catch { sessions = []; }
    if (mine !== bannerToken) return;
    if (st.recovered) sessions = sessions.filter((s) => s.sessionId !== st.recovered);
    if (!sessions.length) { banner.hidden = true; banner.replaceChildren(); return; }
    const s = sessions[0];
    const approx = fmt.formatDuration((s.chunks || 0) * CHUNK_SECONDS);
    banner.replaceChildren(
      h("p", { text: `Unfinished recording found: about ${approx} (${fmt.formatBytes(s.bytes)}), started ${formatDateTime(s.startedAt)}.` }),
      h("div", { class: "btn-row" },
        pill("Recover unfinished recording", { primary: true, cls: "small", onclick: () => recover(s.sessionId) }),
        pill("Discard", { cls: "small", onclick: () => discard(s.sessionId) })));
    banner.hidden = false;
  }

  async function recover(sessionId) {
    try {
      const r = await recoverRecording(sessionId);
      const file = new File([r.blob], r.name, { type: r.type || "audio/mp4" });
      setFile(file, "recording");
      st.recovered = sessionId;
      update();
    } catch (err) {
      alert.show(errorMessage(err));
    }
  }

  async function discard(sessionId) {
    if (!window.confirm("Delete this unfinished recording from this device? This cannot be undone.")) return;
    try { await media.deleteRecordingSession(sessionId); } catch (err) { alert.show(errorMessage(err)); }
    refreshBanner();
  }

  /* Transcription ------------------------------------------------------ */

  function setRunning(on) {
    st.mode = on ? "running" : "idle";
    setBusy({ running: on });
    if (!on) {
      clearInterval(st.timer);
      st.timer = null;
    }
    update();
  }

  function setUploadProgress(fraction) {
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    if (f >= 1) { setProcessing(); return; }
    if (st.phase === "processing") return;
    st.phase = "upload";
    bar.classList.remove("indeterminate");
    const pct = Math.round(f * 100);
    phaseText.textContent = "Uploading to Deepgram";
    percentText.textContent = `${pct}%`;
    barFill.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(pct));
  }

  function setProcessing() {
    if (st.phase === "processing") return;
    st.phase = "processing";
    st.phaseStart = Date.now();
    bar.classList.add("indeterminate");
    bar.removeAttribute("aria-valuenow");
    barFill.style.width = "";
    phaseText.textContent = "Processing at Deepgram";
    const tick = () => { percentText.textContent = `Elapsed ${fmt.formatTime((Date.now() - st.phaseStart) / 1000)}`; };
    tick();
    st.timer = setInterval(tick, 1000);
  }

  function cancel() {
    if (!st.job) return;
    st.cancelled = true;
    cancelBtn.disabled = true;
    cancelBtn.lastChild.textContent = "Cancelling";
    try { st.job.abort(); } catch { /* ignore */ }
  }

  async function start() {
    if (state.running) return;
    alert.clear();
    const file = st.file;
    if (!file) { alert.show("Choose or record audio first."); return; }
    if (file.size > MAX_FILE_BYTES) {
      alert.show("This file is larger than 2 GB, which is more than Deepgram accepts.");
      return;
    }
    const apiKey = storage.getApiKey();
    if (!apiKey) { ctx.route(); return; }

    const settings = storage.getSettings();
    const keyterms = getTerms();
    const language = langSelect.value;

    st.cancelled = false;
    st.phase = null;
    cancelBtn.disabled = false;
    cancelBtn.lastChild.textContent = "Cancel";
    bar.classList.remove("indeterminate");
    setRunning(true);
    setUploadProgress(0);
    await acquireWakeLock();

    let transcript = null;
    try {
      st.job = deepgram.transcribe({
        file,
        apiKey,
        language,
        keyterms,
        diarizer: settings.diarizer || "v1",
        smartFormat: false,
        smoothSpeakers: settings.smoothSpeakers !== false,
        onUploadProgress: (f) => setUploadProgress(f),
      });
      transcript = await st.job.promise;
    } catch (err) {
      const aborted = st.cancelled || (err && err.name === "AbortError");
      st.job = null;
      releaseWakeLock();
      setRunning(false);
      if (aborted) alert.show("Cancelled. Nothing was saved.", "warn");
      else alert.show(errorMessage(err));
      return;
    }
    st.job = null;

    let audioNote = "";
    try {
      if (!transcript.id) transcript.id = crypto.randomUUID();
      if (!transcript.title) transcript.title = baseName(file.name);
      if (!transcript.language) transcript.language = language;
      if (!transcript.keyterms) transcript.keyterms = keyterms;
      if (!transcript.createdAt) transcript.createdAt = new Date().toISOString();
      if (!transcript.speakerNames) transcript.speakerNames = {};
      // Keep the audio next to the transcript so it can be played back later.
      try {
        await media.saveAudio({ id: transcript.id, blob: file, name: file.name, type: file.type });
        transcript.audioId = transcript.id;
      } catch (err) {
        audioNote = `The audio could not be stored on this device (${errorMessage(err)}), so there will be no playback.`;
      }
      state.unsaved = transcript;
      await storage.saveTranscript(transcript);
      state.unsaved = null;
      try { await storage.requestPersistence(); } catch { /* ignore */ }
    } catch (err) {
      alert.show(`The transcript is ready but could not be saved on this device (${errorMessage(err)}). Export it now, it will be lost when you close this tab.`);
    }

    if (st.recovered) {
      try { await media.deleteRecordingSession(st.recovered); } catch { /* ignore */ }
      st.recovered = null;
    }
    releaseWakeLock();
    setRunning(false);
    st.file = null;
    extraTerms.value = "";
    updateTerms();
    update();
    ctx.refreshHistory();
    if (audioNote) alert.show(audioNote, "warn");
    ctx.navigate(`#t/${encodeURIComponent(transcript.id)}`);
  }

  update();
  return {
    el,
    /** Called every time the view is shown. mode "record" shows the big record button. */
    show(mode) {
      refreshOptions();
      if (st.mode === "idle" || st.mode === "ready") st.mode = mode === "record" ? "ready" : "idle";
      update();
    },
  };
}
