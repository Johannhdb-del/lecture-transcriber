import * as storage from "./storage.js";
import * as deepgram from "./engines/deepgram.js";
import * as fmt from "./format.js";
import * as exp from "./export.js";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const LANGUAGES = [
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
];
const MAX_TERMS_WARNING = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const SPEAKER_COLORS = 6;

/** Create an element. Text is always inserted as text, never as HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "spellcheck") { el.setAttribute("spellcheck", v ? "true" : "false"); continue; }
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "for") el.htmlFor = v;
    else if (k.startsWith("aria-") || k.startsWith("data-")) el.setAttribute(k, v === true ? "true" : v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Inline alert area with show and clear. */
function alertBox() {
  const el = h("div", { class: "alert", role: "alert", hidden: true });
  return {
    el,
    show(message, kind = "error") {
      el.className = kind === "error" ? "alert" : `alert ${kind}`;
      el.textContent = message;
      el.hidden = false;
    },
    clear() {
      el.hidden = true;
      el.textContent = "";
    },
  };
}

function errorMessage(err) {
  return (err && err.message) ? err.message : "Something went wrong. Please try again.";
}

function languageLabel(code) {
  return (LANGUAGES.find((l) => l.value === code) || { label: String(code || "").toUpperCase() }).label;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function baseName(filename) {
  return String(filename || "").replace(/\.[^./\\]+$/, "") || "Untitled";
}

function dedupeTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const raw of terms) {
    const t = String(raw).trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { class: "offscreen", readOnly: true, value: text });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/* ------------------------------------------------------------------ */
/* Global state                                                        */
/* ------------------------------------------------------------------ */

const nav = document.getElementById("nav");
const viewNew = document.getElementById("view-new");
const view = document.getElementById("view");

let running = false;          // a transcription is in progress
let routeToken = 0;           // guards against stale async renders
let newViewApi = null;        // built lazily, kept alive across routes
let unsavedTranscript = null; // fallback when saving to storage failed

/* ------------------------------------------------------------------ */
/* Wake lock                                                           */
/* ------------------------------------------------------------------ */

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
  if (running && document.visibilityState === "visible" && !wakeLock) acquireWakeLock();
});

window.addEventListener("beforeunload", (e) => {
  if (running) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/");
  let arg = parts.slice(1).join("/");
  try { arg = decodeURIComponent(arg); } catch { /* keep raw */ }
  return { name: parts[0], arg };
}

function setActiveTab(tab) {
  for (const a of nav.querySelectorAll("a[data-tab]")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function updateBusyIndicator() {
  const a = nav.querySelector('a[data-tab="new"]');
  if (a) a.classList.toggle("busy", running);
}

function showNew() {
  viewNew.hidden = false;
  view.hidden = true;
}

function showDynamic(...nodes) {
  view.replaceChildren(...nodes);
  view.hidden = false;
  viewNew.hidden = true;
}

async function route() {
  const token = ++routeToken;
  window.scrollTo(0, 0);
  document.title = "Lecture Transcriber";

  if (!storage.getApiKey()) {
    nav.hidden = true;
    renderKeySetup();
    return;
  }
  nav.hidden = false;

  const { name, arg } = parseHash();
  switch (name) {
    case "new":
      setActiveTab("new");
      if (!newViewApi) newViewApi = buildNewView();
      newViewApi.refresh();
      showNew();
      break;
    case "history":
      setActiveTab("history");
      await renderHistory(token);
      break;
    case "settings":
      setActiveTab("settings");
      renderSettings();
      break;
    case "t":
      setActiveTab("history");
      await renderTranscript(arg, token);
      break;
    default:
      history.replaceState(null, "", "#new");
      route();
  }
}

window.addEventListener("hashchange", route);

/* ------------------------------------------------------------------ */
/* API key form (shared by setup and settings)                         */
/* ------------------------------------------------------------------ */

function keyForm({ submitLabel = "Test and save", onSaved }) {
  const alert = alertBox();
  const input = h("input", {
    type: "password",
    id: "api-key-input",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: false,
    placeholder: "Paste your Deepgram API key",
    "aria-label": "Deepgram API key",
  });
  const toggle = h("button", {
    type: "button",
    class: "btn",
    text: "Show",
    "aria-pressed": "false",
    onclick() {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "Hide" : "Show";
      toggle.setAttribute("aria-pressed", String(show));
    },
  });
  const submit = h("button", { type: "submit", class: "btn primary", text: submitLabel });

  const form = h("form", {
    class: "stack",
    async onsubmit(e) {
      e.preventDefault();
      alert.clear();
      const key = input.value.trim();
      if (!key) {
        alert.show("Paste your API key first.");
        return;
      }
      submit.disabled = true;
      toggle.disabled = true;
      submit.textContent = "Testing the key";
      try {
        const res = await deepgram.testKey(key);
        if (res && res.ok) {
          storage.setApiKey(key);
          input.value = "";
          onSaved();
          return;
        }
        alert.show((res && res.message) || "Key not accepted.");
      } catch (err) {
        alert.show(errorMessage(err));
      }
      submit.disabled = false;
      toggle.disabled = false;
      submit.textContent = submitLabel;
    },
  },
  alert.el,
  h("div", { class: "input-row" }, input, toggle),
  h("div", { class: "btn-row" }, submit));
  return form;
}

function renderKeySetup() {
  const form = keyForm({ onSaved: () => route() });
  showDynamic(
    h("div", { class: "stack" },
      h("h1", { text: "Welcome" }),
      h("p", { class: "lead", text: "This app turns lecture recordings into readable transcripts with speaker labels. It uses Deepgram for the speech recognition, so you need a Deepgram API key." }),
      h("div", { class: "card stack" },
        h("h2", { text: "Add your Deepgram key" }),
        h("p", {}, "Create a key in the Deepgram console under API Keys at ",
          h("a", { href: "https://console.deepgram.com", target: "_blank", rel: "noopener noreferrer", text: "console.deepgram.com" }),
          ". The key is stored only on this device and is sent only to Deepgram."),
        form,
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* New transcription view                                              */
/* ------------------------------------------------------------------ */

function buildNewView() {
  const state = { file: null, langTouched: false, job: null, cancelled: false, timer: null, phaseStart: 0 };
  const alert = alertBox();

  // File picker
  const fileInput = h("input", {
    type: "file",
    id: "file-input",
    class: "visually-hidden",
    accept: "audio/*,video/*,.m4a,.mp4,.mp3,.wav,.mov,.webm",
    onchange() {
      state.file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      updateFileLine();
    },
  });
  const pickLabel = h("label", { class: "btn", for: "file-input", text: "Choose audio or video file" });
  const fileLine = h("p", { class: "file-name", text: "No file chosen." });

  // Options
  const langSelect = h("select", {
    id: "language",
    onchange() { state.langTouched = true; },
  }, LANGUAGES.map((l) => h("option", { value: l.value, text: l.label })));

  const listSelect = h("select", {
    id: "keyterm-list",
    onchange() {
      try { storage.saveSettings({ keytermListId: listSelect.value }); } catch { /* ignore */ }
      updateTerms();
    },
  });

  const extraTerms = h("textarea", {
    id: "extra-terms",
    rows: 4,
    placeholder: "One term per line, for example names and technical words",
    spellcheck: false,
    autocapitalize: "none",
    oninput: () => updateTerms(),
  });

  const termCount = h("p", { class: "hint", text: "0 terms" });
  const termWarn = h("div", { class: "alert warn", hidden: true, text: `You have more than ${MAX_TERMS_WARNING} terms. Deepgram works best with a shorter list, and extra terms may be ignored or reduce accuracy.` });

  const submit = h("button", { type: "button", class: "btn primary", text: "Transcribe", onclick: () => start() });

  // Progress
  const phaseText = h("span", { text: "Uploading" });
  const percentText = h("span", { text: "0%" });
  const barFill = h("div", { class: "bar-fill" });
  const bar = h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0", "aria-label": "Progress" }, barFill);
  const cancelBtn = h("button", { type: "button", class: "btn danger", text: "Cancel", onclick: () => cancel() });
  const progress = h("div", { class: "card progress-box", hidden: true, "aria-live": "polite" },
    h("div", { class: "progress-line" }, phaseText, percentText),
    bar,
    h("p", { class: "muted small", text: "Keep the screen on and stay in this tab until the transcript is ready. Long lectures can take several minutes." }),
    h("div", { class: "btn-row" }, cancelBtn),
  );

  const form = h("div", { class: "card stack" },
    h("div", { class: "field" },
      h("span", { class: "label", text: "Recording" }),
      pickLabel, fileInput, fileLine),
    h("div", { class: "grid-2" },
      h("div", { class: "field" }, h("label", { for: "language", text: "Language" }), langSelect),
      h("div", { class: "field" }, h("label", { for: "keyterm-list", text: "Keyterm list" }), listSelect),
    ),
    h("div", { class: "field" },
      h("label", { for: "extra-terms", text: "Extra terms for this lecture" }),
      extraTerms, termCount, termWarn),
    h("div", { class: "btn-row" }, submit),
  );

  const root = h("div", { class: "stack" },
    h("h1", { text: "New transcription" }),
    alert.el,
    form,
    progress,
  );
  viewNew.replaceChildren(root);

  const controls = [fileInput, langSelect, listSelect, extraTerms, submit];

  function updateFileLine() {
    if (state.file) {
      fileLine.textContent = `${state.file.name} (${fmt.formatBytes(state.file.size)})`;
    } else {
      fileLine.textContent = "No file chosen.";
    }
  }

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
    termCount.textContent = plural(n, "term", "terms") + " will be sent to Deepgram.";
    termWarn.hidden = n <= MAX_TERMS_WARNING;
  }

  function refresh() {
    if (running) return;
    const settings = storage.getSettings();
    if (!state.langTouched) langSelect.value = settings.language || "de";
    const lists = storage.listKeytermLists();
    const wanted = listSelect.value || settings.keytermListId || "";
    listSelect.replaceChildren(
      h("option", { value: "", text: "None" }),
      ...lists.map((l) => h("option", { value: l.id, text: `${l.name} (${plural((l.terms || []).length, "term", "terms")})` })),
    );
    listSelect.value = lists.some((l) => l.id === wanted) ? wanted : "";
    updateTerms();
  }

  function setRunning(on) {
    running = on;
    for (const c of controls) c.disabled = on;
    pickLabel.setAttribute("aria-disabled", String(on));
    pickLabel.style.pointerEvents = on ? "none" : "";
    pickLabel.style.opacity = on ? "0.5" : "";
    submit.textContent = on ? "Working" : "Transcribe";
    progress.hidden = !on;
    updateBusyIndicator();
    if (!on) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function setUploadProgress(fraction) {
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    if (f >= 1) {
      setProcessing();
      return;
    }
    if (state.phase === "processing") return;
    state.phase = "upload";
    bar.classList.remove("indeterminate");
    const pct = Math.round(f * 100);
    phaseText.textContent = "Uploading to Deepgram";
    percentText.textContent = `${pct}%`;
    barFill.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(pct));
  }

  function setProcessing() {
    if (state.phase === "processing") return;
    state.phase = "processing";
    state.phaseStart = Date.now();
    bar.classList.add("indeterminate");
    bar.removeAttribute("aria-valuenow");
    barFill.style.width = "";
    phaseText.textContent = "Processing at Deepgram";
    const tick = () => {
      percentText.textContent = `Elapsed ${fmt.formatTime((Date.now() - state.phaseStart) / 1000)}`;
    };
    tick();
    state.timer = setInterval(tick, 1000);
  }

  function cancel() {
    if (!state.job) return;
    state.cancelled = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = "Cancelling";
    try { state.job.abort(); } catch { /* ignore */ }
  }

  async function start() {
    if (running) return;
    alert.clear();
    const file = state.file;
    if (!file) {
      alert.show("Choose an audio or video file first.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      alert.show("This file is larger than 2 GB, which is more than Deepgram accepts.");
      return;
    }
    const apiKey = storage.getApiKey();
    if (!apiKey) {
      route();
      return;
    }

    const settings = storage.getSettings();
    const keyterms = getTerms();
    const language = langSelect.value;

    state.cancelled = false;
    state.phase = null;
    cancelBtn.disabled = false;
    cancelBtn.textContent = "Cancel";
    setRunning(true);
    setUploadProgress(0);
    await acquireWakeLock();

    let transcript = null;
    try {
      state.job = deepgram.transcribe({
        file,
        apiKey,
        language,
        keyterms,
        diarizer: settings.diarizer || "v1",
        smartFormat: false,
        onUploadProgress: (f) => setUploadProgress(f),
      });
      transcript = await state.job.promise;
    } catch (err) {
      const aborted = state.cancelled || (err && err.name === "AbortError");
      state.job = null;
      releaseWakeLock();
      setRunning(false);
      if (aborted) alert.show("Cancelled. Nothing was saved.", "warn");
      else alert.show(errorMessage(err));
      return;
    }
    state.job = null;

    try {
      if (!transcript.id) transcript.id = crypto.randomUUID();
      if (!transcript.title) transcript.title = baseName(file.name);
      if (!transcript.language) transcript.language = language;
      if (!transcript.keyterms) transcript.keyterms = keyterms;
      if (!transcript.createdAt) transcript.createdAt = new Date().toISOString();
      if (!transcript.speakerNames) transcript.speakerNames = {};
      unsavedTranscript = transcript;
      await storage.saveTranscript(transcript);
      unsavedTranscript = null;
      try { await storage.requestPersistence(); } catch { /* ignore */ }
    } catch (err) {
      // Keep the transcript in memory so the user can still export it.
      alert.show(`The transcript is ready but could not be saved on this device (${errorMessage(err)}). Export it now, it will be lost when you close this tab.`);
    }

    releaseWakeLock();
    setRunning(false);
    state.file = null;
    fileInput.value = "";
    updateFileLine();
    extraTerms.value = "";
    updateTerms();
    location.hash = `#t/${encodeURIComponent(transcript.id)}`;
  }

  updateFileLine();
  return { refresh };
}

/* ------------------------------------------------------------------ */
/* History view                                                        */
/* ------------------------------------------------------------------ */

async function renderHistory(token) {
  const alert = alertBox();
  const root = h("div", { class: "stack" }, h("h1", { text: "History" }), alert.el);
  showDynamic(root);

  let items = [];
  try {
    items = await storage.listTranscripts();
  } catch (err) {
    if (token !== routeToken) return;
    alert.show(`Could not load your transcripts. ${errorMessage(err)}`);
    return;
  }
  if (token !== routeToken) return;

  if (!items.length) {
    root.append(h("div", { class: "empty card" },
      h("p", { text: "No transcripts yet. Transcripts you create are saved on this device and show up here." }),
      h("a", { class: "btn primary", href: "#new", text: "New transcription" }),
    ));
    return;
  }

  const list = h("ul", { class: "list" });
  for (const it of items) {
    const meta = [formatDate(it.createdAt), it.durationSec != null ? fmt.formatDuration(it.durationSec) : "", languageLabel(it.language)]
      .filter(Boolean).join(" · ");
    list.append(h("li", {},
      h("a", { class: "list-item", href: `#t/${encodeURIComponent(it.id)}` },
        h("span", { class: "list-title", text: it.title || "Untitled" }),
        h("span", { class: "list-meta", text: meta }),
      ),
    ));
  }
  root.append(list);
}

/* ------------------------------------------------------------------ */
/* Transcript view                                                     */
/* ------------------------------------------------------------------ */

const EXPORT_FORMATS = [
  { id: "txt", label: "TXT", ext: "txt", mime: "text/plain;charset=utf-8", build: (t) => exp.toText(t) },
  { id: "md", label: "Markdown", ext: "md", mime: "text/markdown;charset=utf-8", build: (t) => exp.toMarkdown(t) },
  { id: "srt", label: "SRT", ext: "srt", mime: "application/x-subrip;charset=utf-8", build: (t) => exp.toSRT(t) },
  { id: "vtt", label: "VTT", ext: "vtt", mime: "text/vtt;charset=utf-8", build: (t) => exp.toVTT(t) },
];

async function renderTranscript(id, token) {
  const alert = alertBox();
  const back = h("a", { class: "btn ghost back-link", href: "#history", text: "← Back to History" });
  showDynamic(h("div", { class: "stack" }, back, alert.el, h("p", { class: "muted", text: "Loading" })));

  let t = null;
  try {
    t = await storage.getTranscript(id);
  } catch (err) {
    if (token !== routeToken) return;
    alert.show(`Could not load this transcript. ${errorMessage(err)}`);
    return;
  }
  if (token !== routeToken) return;
  if (!t && unsavedTranscript && unsavedTranscript.id === id) t = unsavedTranscript;
  if (!t) {
    showDynamic(h("div", { class: "stack" }, back,
      h("div", { class: "empty card" },
        h("p", { text: "This transcript was not found on this device. It may have been deleted." }),
        h("a", { class: "btn primary", href: "#history", text: "Go to History" }))));
    return;
  }
  if (!t.speakerNames) t.speakerNames = {};
  document.title = `${t.title || "Transcript"} · Lecture Transcriber`;

  const status = h("span", { class: "status", role: "status", "aria-live": "polite" });
  let statusTimer = null;
  function flash(message) {
    status.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ""; }, 2500);
  }

  async function persist() {
    try {
      await storage.saveTranscript(t);
      alert.clear();
      return true;
    } catch (err) {
      alert.show(`Could not save changes. ${errorMessage(err)}`);
      return false;
    }
  }

  // Title
  const titleInput = h("input", {
    type: "text",
    class: "title-input",
    value: t.title || "",
    "aria-label": "Title",
    autocomplete: "off",
    onchange: async () => {
      const next = titleInput.value.trim();
      if (!next) { titleInput.value = t.title || ""; return; }
      if (next === t.title) return;
      t.title = next;
      document.title = `${next} · Lecture Transcriber`;
      if (await persist()) flash("Title saved");
    },
  });

  // Meta line
  const metaParts = [
    formatDate(t.createdAt),
    t.durationSec != null ? fmt.formatDuration(t.durationSec) : "",
    languageLabel(t.language),
    t.stats && t.stats.words != null ? `${Number(t.stats.words).toLocaleString()} words` : "",
    t.costUsd != null ? `Est. cost $${Number(t.costUsd).toFixed(2)}` : "",
  ].filter(Boolean);
  const meta = h("p", { class: "meta", text: metaParts.join(" · ") });

  // Speakers
  const speakersBox = h("div", { class: "chips" });
  let editingIdx = null;

  function renderSpeakers() {
    const indices = fmt.speakerIndices(t);
    speakersBox.replaceChildren();
    for (const idx of indices) {
      const color = `sp-${Math.abs(Number(idx)) % SPEAKER_COLORS}`;
      if (editingIdx === idx) {
        const input = h("input", {
          type: "text",
          value: t.speakerNames[String(idx)] || "",
          placeholder: `Speaker ${Number(idx) + 1}`,
          "aria-label": `Name for speaker ${Number(idx) + 1}`,
          autocomplete: "off",
          onkeydown(e) {
            if (e.key === "Enter") { e.preventDefault(); save(); }
            else if (e.key === "Escape") { editingIdx = null; renderSpeakers(); }
          },
        });
        const save = async () => {
          const name = input.value.trim();
          if (name) t.speakerNames[String(idx)] = name;
          else delete t.speakerNames[String(idx)];
          editingIdx = null;
          renderSpeakers();
          renderBody();
          await persist();
        };
        speakersBox.append(h("div", { class: `chip editing ${color}` },
          h("span", { class: "dot", "aria-hidden": "true" }),
          input,
          h("button", { type: "button", class: "btn small primary", text: "Save", onclick: save }),
          h("button", { type: "button", class: "btn small", text: "Cancel", onclick: () => { editingIdx = null; renderSpeakers(); } }),
        ));
        setTimeout(() => { input.focus(); input.select(); }, 0);
      } else {
        speakersBox.append(h("div", { class: `chip ${color}` },
          h("span", { class: "dot", "aria-hidden": "true" }),
          h("span", { class: "chip-name", text: fmt.speakerName(t, idx) }),
          h("button", {
            type: "button",
            class: "btn small ghost",
            text: "Rename",
            "aria-label": `Rename ${fmt.speakerName(t, idx)}`,
            onclick: () => { editingIdx = idx; renderSpeakers(); },
          }),
        ));
      }
    }
  }

  // Export bar
  function filenameFor(f) {
    return `${exp.safeFilename(t.title || "transcript")}.${f.ext}`;
  }

  const exportBar = h("div", { class: "export-bar" });
  for (const f of EXPORT_FORMATS) {
    exportBar.append(h("button", {
      type: "button",
      class: "btn",
      text: f.label,
      "aria-label": `Download ${f.label}`,
      onclick() {
        try {
          exp.downloadFile(filenameFor(f), f.build(t), f.mime);
          flash(`${f.label} downloaded`);
        } catch (err) {
          alert.show(`Could not create the ${f.label} file. ${errorMessage(err)}`);
        }
      },
    }));
  }
  exportBar.append(h("button", {
    type: "button",
    class: "btn",
    text: "Copy text",
    async onclick() {
      const ok = await copyText(exp.toText(t));
      if (ok) flash("Copied to clipboard");
      else alert.show("Copying was blocked by the browser. Use a download button instead.");
    },
  }));

  let canShare = false;
  try { canShare = !!exp.canShareFiles(); } catch { canShare = false; }
  if (canShare) {
    const shareSelect = h("select", { "aria-label": "Share format" },
      EXPORT_FORMATS.map((f) => h("option", { value: f.id, text: f.label })));
    const shareBtn = h("button", {
      type: "button",
      class: "btn",
      text: "Share",
      async onclick() {
        const f = EXPORT_FORMATS.find((x) => x.id === shareSelect.value) || EXPORT_FORMATS[0];
        try {
          const done = await exp.shareFile(filenameFor(f), f.build(t), f.mime);
          if (!done) alert.show("Sharing is not available here. Use a download button instead.", "warn");
        } catch (err) {
          alert.show(`Could not share the file. ${errorMessage(err)}`);
        }
      },
    });
    exportBar.append(h("span", { class: "share-group" }, shareBtn, shareSelect));
  }

  exportBar.append(h("button", {
    type: "button",
    class: "btn danger",
    text: "Delete",
    async onclick() {
      if (!window.confirm(`Delete "${t.title || "this transcript"}" from this device? This cannot be undone.`)) return;
      try {
        await storage.deleteTranscript(t.id);
        if (unsavedTranscript && unsavedTranscript.id === t.id) unsavedTranscript = null;
        location.hash = "#history";
      } catch (err) {
        alert.show(`Could not delete the transcript. ${errorMessage(err)}`);
      }
    },
  }));

  // Body
  const body = h("div", { class: "transcript" });
  function renderBody() {
    body.replaceChildren();
    const paragraphs = Array.isArray(t.paragraphs) ? t.paragraphs : [];
    if (!paragraphs.length) {
      body.append(h("p", { class: "muted", text: "No speech was detected in this recording." }));
      return;
    }
    const frag = document.createDocumentFragment();
    let prev = null;
    for (const p of paragraphs) {
      const spk = p.speaker == null ? 0 : p.speaker;
      const head = h("div", { class: "para-head" });
      if (spk !== prev) head.append(h("span", { class: "spk", text: fmt.speakerName(t, spk) }));
      head.append(h("span", { class: "ts", text: fmt.formatTime(p.start || 0) }));
      const text = (p.sentences || []).map((s) => s.text).join(" ");
      frag.append(h("div", { class: `para sp-${Math.abs(Number(spk)) % SPEAKER_COLORS}` },
        head,
        h("p", { class: "para-text", text }),
      ));
      prev = spk;
    }
    body.append(frag);
  }

  renderSpeakers();
  renderBody();

  showDynamic(h("div", { class: "stack" },
    back,
    alert.el,
    h("div", { class: "field" }, titleInput),
    meta,
    h("div", { class: "field" }, h("span", { class: "label", text: "Speakers" }), speakersBox),
    exportBar,
    status,
    body,
  ));
}

/* ------------------------------------------------------------------ */
/* Settings view                                                       */
/* ------------------------------------------------------------------ */

function renderSettings(openId = "") {
  const alert = alertBox();
  const settings = storage.getSettings();

  // Defaults
  const langSelect = h("select", {
    id: "default-language",
    onchange() { storage.saveSettings({ language: langSelect.value }); flashDefaults(); },
  }, LANGUAGES.map((l) => h("option", { value: l.value, text: l.label })));
  langSelect.value = settings.language || "de";

  const diarSelect = h("select", {
    id: "speaker-model",
    onchange() { storage.saveSettings({ diarizer: diarSelect.value }); flashDefaults(); },
  },
  h("option", { value: "v1", text: "v1 (recommended)" }),
  h("option", { value: "latest", text: "latest" }));
  diarSelect.value = settings.diarizer === "latest" ? "latest" : "v1";

  const defaultsStatus = h("span", { class: "status", role: "status" });
  let defTimer = null;
  function flashDefaults() {
    defaultsStatus.textContent = "Saved";
    clearTimeout(defTimer);
    defTimer = setTimeout(() => { defaultsStatus.textContent = ""; }, 2000);
  }

  const defaultsCard = h("section", { class: "card stack" },
    h("h2", { text: "Defaults" }),
    h("div", { class: "grid-2" },
      h("div", { class: "field" }, h("label", { for: "default-language", text: "Default language" }), langSelect),
      h("div", { class: "field" },
        h("label", { for: "speaker-model", text: "Speaker model" }), diarSelect,
        h("p", { class: "hint", text: "v1 is recommended. Try latest only if speaker labels look wrong." })),
    ),
    defaultsStatus,
  );

  // Keyterm lists
  const listsBox = h("div", {});
  for (const list of storage.listKeytermLists()) listsBox.append(keytermItem(list, list.id === openId));
  if (!listsBox.children.length) {
    listsBox.append(h("p", { class: "muted", text: "No lists yet. A list holds names and technical words that help Deepgram spell them correctly." }));
  }

  const importInput = h("input", {
    type: "file",
    id: "import-terms",
    class: "visually-hidden",
    accept: ".txt,text/plain",
    async onchange() {
      const file = importInput.files && importInput.files[0];
      importInput.value = "";
      if (!file) return;
      alert.clear();
      try {
        const text = await file.text();
        const terms = fmt.parseKeyterms(text);
        if (!terms.length) {
          alert.show("No terms found in that file. Use one term per line.");
          return;
        }
        const saved = storage.saveKeytermList({ name: baseName(file.name), terms });
        renderSettings(saved.id);
      } catch (err) {
        alert.show(`Could not import the file. ${errorMessage(err)}`);
      }
    },
  });

  const listsCard = h("section", { class: "card stack" },
    h("h2", { text: "Keyterm lists" }),
    h("p", { class: "muted", text: "Save vocabulary for a course once and pick it for each transcription. One term per line. Lines starting with # are ignored." }),
    listsBox,
    h("div", { class: "btn-row" },
      h("button", {
        type: "button",
        class: "btn",
        text: "Add list",
        onclick() {
          try {
            const saved = storage.saveKeytermList({ name: "New list", terms: [] });
            renderSettings(saved.id);
          } catch (err) {
            alert.show(`Could not create the list. ${errorMessage(err)}`);
          }
        },
      }),
      h("label", { class: "btn", for: "import-terms", text: "Import .txt file" }),
      importInput,
    ),
  );

  // API key
  const key = storage.getApiKey();
  const last4 = key.length >= 4 ? key.slice(-4) : key;
  const keyHolder = h("div", {});
  const keyCard = h("section", { class: "card stack" },
    h("h2", { text: "Deepgram API key" }),
    h("p", {}, "Stored on this device only. Current key: ", h("span", { class: "key-mask", text: `•••• ${last4}` })),
    keyHolder,
    h("div", { class: "btn-row" },
      h("button", {
        type: "button",
        class: "btn",
        text: "Change key",
        onclick() {
          if (keyHolder.children.length) { keyHolder.replaceChildren(); return; }
          keyHolder.append(keyForm({ submitLabel: "Test and save", onSaved: () => renderSettings() }));
        },
      }),
      h("button", {
        type: "button",
        class: "btn danger",
        text: "Remove key",
        onclick() {
          if (!window.confirm("Remove the API key from this device? You will need to enter it again to transcribe.")) return;
          storage.clearApiKey();
          route();
        },
      }),
    ),
  );

  const tipCard = h("section", { class: "card stack" },
    h("h2", { text: "Keep your data" }),
    h("p", { text: "Add this app to your Home Screen (Share button in Safari, then Add to Home Screen). Safari may clear stored data of websites you do not use for a while, but apps on the Home Screen are kept." }),
    h("h2", { text: "Privacy" }),
    h("p", { text: "Audio goes directly from this device to Deepgram, with the setting that opts out of Deepgram using it to improve their models. Transcripts and your key stay on this device. There is no server of ours in between." }),
  );

  showDynamic(h("div", { class: "stack" },
    h("h1", { text: "Settings" }),
    alert.el,
    defaultsCard,
    listsCard,
    keyCard,
    tipCard,
  ));

  function keytermItem(list, open) {
    const summaryName = h("span", { text: list.name });
    const summaryCount = h("span", { class: "muted small", text: plural((list.terms || []).length, "term", "terms") });
    const nameInput = h("input", { type: "text", value: list.name, id: `kt-name-${list.id}`, autocomplete: "off" });
    const termsArea = h("textarea", {
      id: `kt-terms-${list.id}`,
      rows: 8,
      spellcheck: false,
      autocapitalize: "none",
      value: (list.terms || []).join("\n"),
    });
    const status = h("span", { class: "status", role: "status" });
    return h("details", { class: "kt", open },
      h("summary", {}, summaryName, summaryCount),
      h("div", { class: "kt-body stack" },
        h("div", { class: "field" }, h("label", { for: `kt-name-${list.id}`, text: "Name" }), nameInput),
        h("div", { class: "field" }, h("label", { for: `kt-terms-${list.id}`, text: "Terms, one per line" }), termsArea),
        h("div", { class: "btn-row" },
          h("button", {
            type: "button",
            class: "btn primary",
            text: "Save list",
            onclick() {
              try {
                const terms = fmt.parseKeyterms(termsArea.value);
                const name = nameInput.value.trim() || "Untitled list";
                const saved = storage.saveKeytermList({ id: list.id, name, terms });
                summaryName.textContent = saved.name;
                summaryCount.textContent = plural(saved.terms.length, "term", "terms");
                nameInput.value = saved.name;
                termsArea.value = saved.terms.join("\n");
                status.textContent = "Saved";
                setTimeout(() => { status.textContent = ""; }, 2000);
              } catch (err) {
                alert.show(`Could not save the list. ${errorMessage(err)}`);
              }
            },
          }),
          h("button", {
            type: "button",
            class: "btn danger",
            text: "Delete list",
            onclick() {
              if (!window.confirm(`Delete the list "${list.name}"?`)) return;
              storage.deleteKeytermList(list.id);
              if (storage.getSettings().keytermListId === list.id) storage.saveSettings({ keytermListId: "" });
              renderSettings();
            },
          }),
          status,
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

route();
