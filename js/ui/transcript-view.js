// The transcript screen: title, toolbar, menus, segments, edit mode, search, undo, player and side panel.
import * as storage from "../storage.js";
import * as fmt from "../format.js";
import * as exp from "../export.js";
import * as corr from "../correction.js";
import * as tasks from "../claude-tasks.js";
import * as media from "../media-store.js";
import {
  h, icon, iconBtn, pill, selectWrap, alertBox, errorMessage, copyText, toast, stamp,
  formatDate, formatDateTime, languageLabel, plural, LANGUAGES,
  openPopover, closePopover, popoverOpenFor, isPopoverOpen, menuItem, menuSeparator, menuHeading, switchRow,
  openDialog, isDialogOpen, isTyping,
} from "./dom.js";
import { state, getPlayer } from "./state.js";
import { buildRuns, renderRuns, findMatches, runsText, segmentAt } from "./segments.js";
import { findWordIndex } from "../word-timing.js";
import { createPlayerBar } from "./player-bar.js";
import { createSidePanel } from "./side-panel.js";
import { createClaudeFlow } from "./claude-flow.js";
import { buildCorrectionReview, correctionResultNode } from "./correction-ui.js";

const SIZES = { s: "16px", m: "19px", l: "22px" };
const MAX_UNDO = 50;
const WIDE_PANEL_PX = 900; // keep in sync with the container query in style.css
const SPEAKER_COLORS = 6;
const SNAP_KEYS = ["paragraphs", "speakerNames", "originalParagraphs", "corrections"];

const EXPORT_FORMATS = [
  { id: "txt", label: "TXT", ext: "txt", mime: "text/plain;charset=utf-8", build: (t) => exp.toText(t) },
  { id: "md", label: "Markdown", ext: "md", mime: "text/markdown;charset=utf-8", build: (t) => exp.toMarkdown(t) },
  { id: "srt", label: "SRT", ext: "srt", mime: "application/x-subrip;charset=utf-8", build: (t) => exp.toSRT(t) },
  { id: "vtt", label: "VTT", ext: "vtt", mime: "text/vtt;charset=utf-8", build: (t) => exp.toVTT(t) },
];

const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
const settings = () => storage.getSettings();

const LEAD_MIN = -0.5;
const LEAD_MAX = 1.0;
const LEAD_STEP = 0.05;
const clampLead = (v) => Math.min(LEAD_MAX, Math.max(LEAD_MIN, Math.round(v * 100) / 100));
function readMarkerLead() {
  const v = Number(settings().markerLead);
  return Number.isFinite(v) ? clampLead(v) : 0.12;
}
const formatLead = (v) => (Math.abs(v) < 0.005 ? "in sync" : `${Math.abs(v).toFixed(2)} s ${v > 0 ? "early" : "late"}`);

function messagePage(text, withLink = false) {
  return {
    el: h("div", { class: "page" }, h("div", { class: "page-inner stack" },
      h("div", { class: "empty card" },
        h("p", { text }),
        withLink ? h("a", { class: "pill primary", href: "#new", text: "Back to start" }) : null))),
    destroy() {},
  };
}

/** Loads the transcript, then builds the view. Returns null when isStale() says a newer route took over. */
export async function createTranscriptView(ctx, id, isStale = () => false) {
  let loaded = null;
  try {
    loaded = await storage.getTranscript(id);
  } catch (err) {
    return isStale() ? null : messagePage(`Could not load this transcript. ${errorMessage(err)}`);
  }
  if (isStale()) return null;
  if (!loaded && state.unsaved && state.unsaved.id === id) loaded = state.unsaved;
  if (!loaded) return messagePage("This transcript was not found on this device. It may have been deleted.", true);
  return buildView(ctx, loaded);
}

function buildView(ctx, loaded) {
  let t = {
    ...loaded,
    paragraphs: Array.isArray(loaded.paragraphs) ? loaded.paragraphs : [],
    speakerNames: loaded.speakerNames || {},
  };
  const player = getPlayer();
  const disposers = [];
  let destroyed = false;
  let deleted = false;

  // view state
  let edit = false;
  let shown = "original"; // "original" | "translation"
  let hasAudio = false;
  let audioBlob = null;
  let playingIdx = -1;
  let lastFocused = -1;
  let lastUserScroll = 0;
  let segEls = [];
  let paraStarts = [];
  let segWords = []; // per segment: [{ el, s }] for the word marker, empty when markers are off
  let nowEl = null; // the word element that currently has w-now
  let rafId = 0;
  let markerLead = readMarkerLead(); // seconds; cached so the frame loop does not read storage
  let activeFlow = null;
  let panelSheetOpen = false;
  let canShare = false;
  try { canShare = !!exp.canShareFiles(); } catch { canShare = false; }

  // undo and redo
  const undoStack = [];
  const redoStack = [];

  // search
  let searchOpen = false;
  let hits = [];
  let hitsByPara = new Map();
  let hitIndex = -1;

  document.title = `${t.title || "Transcript"} · Lecture Transcriber`;

  /* ---------------------------------------------------------------- */
  /* Saving                                                            */
  /* ---------------------------------------------------------------- */

  const alert = alertBox();
  let saveTimer = null;
  let dirty = false;

  function scheduleSave() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty || deleted) return;
    dirty = false;
    if (state.unsaved && state.unsaved.id === t.id) state.unsaved = t;
    try {
      await storage.saveTranscript(t);
      alert.clear();
    } catch (err) {
      dirty = true;
      alert.show(`Could not save changes. ${errorMessage(err)}`);
    }
  }

  function patch(fields) {
    t = { ...t, ...fields };
    scheduleSave();
  }

  const onPageHide = () => { flushSave(); panel.flush(); };
  window.addEventListener("pagehide", onPageHide);
  disposers.push(() => window.removeEventListener("pagehide", onPageHide));

  /* ---------------------------------------------------------------- */
  /* Undo and redo (snapshots share unchanged paragraphs)              */
  /* ---------------------------------------------------------------- */

  const undoBtn = iconBtn("undo", "Undo", () => undo(), "ghost");
  const redoBtn = iconBtn("redo", "Redo", () => redo(), "ghost");

  function snapshot() {
    const s = {};
    for (const k of SNAP_KEYS) s[k] = t[k];
    return s;
  }

  function restore(s) {
    const next = { ...t };
    for (const k of SNAP_KEYS) {
      if (s[k] === undefined) delete next[k];
      else next[k] = s[k];
    }
    t = next;
  }

  function updateUndoButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }

  function commitActive() {
    const a = document.activeElement;
    if (a && a.classList && a.classList.contains("seg-text")) a.blur();
  }

  function changed() {
    scheduleSave();
    updateUndoButtons();
    renderBody();
  }

  function undo() {
    commitActive();
    const s = undoStack.pop();
    if (!s) return;
    redoStack.push(snapshot());
    restore(s);
    changed();
  }

  function redo() {
    commitActive();
    const s = redoStack.pop();
    if (!s) return;
    undoStack.push(snapshot());
    restore(s);
    changed();
  }

  /* ---------------------------------------------------------------- */
  /* Title and meta                                                    */
  /* ---------------------------------------------------------------- */

  const titleEl = h("h1", {
    class: "tv-title",
    tabindex: "0",
    role: "button",
    title: "Click to rename",
    text: t.title || "Untitled",
    onclick: () => startRename(),
    onkeydown(e) { if (e.key === "Enter") { e.preventDefault(); startRename(); } },
  });
  const metaEl = h("p", { class: "tv-meta" });

  function updateMeta() {
    metaEl.textContent = [
      formatDate(t.createdAt),
      t.durationSec != null ? fmt.formatDuration(t.durationSec) : "",
      languageLabel(t.language),
    ].filter(Boolean).join(" · ");
  }

  function startRename() {
    if (!titleEl.isConnected) return;
    const input = h("input", {
      type: "text",
      class: "title-input",
      value: t.title || "",
      autocomplete: "off",
      "aria-label": "Title",
    });
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (input.isConnected) input.replaceWith(titleEl);
      if (save && value && value !== t.title) {
        patch({ title: value });
        titleEl.textContent = value;
        document.title = `${value} · Lecture Transcriber`;
        await flushSave();
        ctx.refreshHistory();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    titleEl.replaceWith(input);
    input.focus();
    input.select();
  }

  /* ---------------------------------------------------------------- */
  /* Segments                                                          */
  /* ---------------------------------------------------------------- */

  const body = h("div", { class: "segments" });
  const scroller = h("div", { class: "main-scroll" });

  function recomputeHits(uncertain, translated) {
    hits = [];
    hitsByPara = new Map();
    const q = searchOpen ? searchInput.value : "";
    if (!q.trim()) { hitIndex = -1; return; }
    const timed = markersOn();
    t.paragraphs.forEach((p, pi) => {
      const runs = buildRuns(t, pi, { uncertain, translated, timed });
      for (const m of findMatches(runsText(runs), q)) {
        const hit = { ...m, pi, idx: hits.length };
        hits.push(hit);
        if (!hitsByPara.has(pi)) hitsByPara.set(pi, []);
        hitsByPara.get(pi).push(hit);
      }
    });
    if (hitIndex >= hits.length) hitIndex = hits.length - 1;
    if (hitIndex < 0 && hits.length) hitIndex = 0;
  }

  function buildSegment(p, pi, ctxInfo) {
    const { uncertain, showTs, translated, showNames, prevSpeaker } = ctxInfo;
    const spk = Number(p.speaker) || 0;
    const meta = h("div", { class: "seg-meta" });

    if (edit) {
      const label = showNames ? fmt.speakerName(t, spk) : "";
      meta.append(h("button", {
        type: "button",
        class: label ? "spk-btn" : "spk-btn empty",
        "aria-label": "Choose speaker",
        text: label || "+ Speaker",
        onclick: (e) => openSpeakerChoice(e.currentTarget, pi),
      }));
    } else if (showNames && (spk !== prevSpeaker || pi === 0)) {
      meta.append(h("span", { class: "spk", text: fmt.speakerName(t, spk) }));
    }
    if (edit && hasAudio) {
      meta.append(h("button", {
        type: "button", class: "mini-play", "aria-label": "Play from here", title: "Play from here",
        onclick: () => playFrom(pi),
      }, icon("play", 14)));
    }
    if (showTs || edit) {
      meta.append(hasAudio
        ? h("button", { type: "button", class: "ts", title: "Play from here", text: stamp(p.start), onclick: () => playFrom(pi) })
        : h("span", { class: "ts", text: stamp(p.start) }));
    }

    const timed = markersOn();
    const runs = buildRuns(t, pi, { uncertain, translated, timed });
    const words = [];
    const textEl = h("p", { class: "seg-text" }, renderRuns(runs, hitsByPara.get(pi) || [], words));
    segWords[pi] = words;
    if (edit) {
      textEl.setAttribute("contenteditable", "true");
      textEl.setAttribute("role", "textbox");
      textEl.setAttribute("aria-label", "Segment text");
      textEl.setAttribute("spellcheck", "true");
      textEl.dataset.c = normalize(runsText(runs));
      textEl.addEventListener("focus", () => { lastFocused = pi; });
      textEl.addEventListener("blur", () => commitSegment(pi, textEl));
      textEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); textEl.blur(); }
      });
      textEl.addEventListener("paste", (e) => {
        e.preventDefault();
        const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
        document.execCommand("insertText", false, text.replace(/\s*\n\s*/g, " "));
      });
    }

    const seg = h("div", { class: `seg sp-${Math.abs(spk) % SPEAKER_COLORS}` }, meta, textEl);
    seg.dataset.p = String(pi);
    return seg;
  }

  function renderBody() {
    const s = settings();
    const uncertain = s.highlightUncertain !== false;
    const showTs = s.showTimestamps !== false;
    const translated = shown === "translation";
    recomputeHits(uncertain, translated);
    paraStarts = t.paragraphs.map((p) => Number(p.start) || 0);
    body.classList.toggle("editing", edit);
    lastFocused = -1;
    segWords = [];
    nowEl = null;

    if (!t.paragraphs.length) {
      segEls = [];
      body.replaceChildren(h("p", { class: "muted", text: "No speech was detected in this recording." }));
      updateSearchCount();
      return;
    }
    const showNames = fmt.speakerIndices(t).length > 1 || Object.keys(t.speakerNames || {}).length > 0;
    const frag = document.createDocumentFragment();
    segEls = [];
    let prevSpeaker = null;
    t.paragraphs.forEach((p, pi) => {
      const seg = buildSegment(p, pi, { uncertain, showTs, translated, showNames, prevSpeaker });
      prevSpeaker = Number(p.speaker) || 0;
      segEls.push(seg);
      frag.append(seg);
    });
    body.replaceChildren(frag);
    const keep = playingIdx;
    playingIdx = -1;
    if (keep >= 0) setPlaying(keep, false);
    markCurrentHit(false);
    updateWord(false);
  }

  // Save the text of one segment after it was edited. The text stays as typed, no redraw.
  function commitSegment(pi, el) {
    const text = normalize(el.textContent);
    if (text === el.dataset.c) return;
    const p = t.paragraphs[pi];
    if (!p) return;
    pushUndo();
    const next = { ...p, sentences: [{ text, start: p.start, end: p.end }] };
    t = { ...t, paragraphs: t.paragraphs.map((x, i) => (i === pi ? next : x)) };
    el.dataset.c = text;
    scheduleSave();
  }

  /* Speakers ------------------------------------------------------- */

  function openSpeakerChoice(anchor, pi) {
    if (popoverOpenFor(anchor)) { closePopover(); return; }
    const current = Number(t.paragraphs[pi].speaker) || 0;
    const box = h("div", { class: "menu", role: "menu" },
      menuHeading("Speaker of this segment"),
      ...fmt.speakerIndices(t).map((i) => menuItem({
        label: fmt.speakerName(t, i),
        checked: i === current,
        onclick() { closePopover(); assignSpeaker(pi, i); },
      })),
      menuSeparator(),
      menuItem({ iconName: "plus", label: "New speaker…", onclick() { closePopover(); newSpeaker(pi); } }));
    openPopover(anchor, box);
  }

  function assignSpeaker(pi, idx, name) {
    pushUndo();
    const names = name ? { ...t.speakerNames, [idx]: name } : t.speakerNames;
    t = {
      ...t,
      speakerNames: names,
      paragraphs: t.paragraphs.map((p, i) => (i === pi ? { ...p, speaker: idx } : p)),
    };
    changed();
  }

  function newSpeaker(pi) {
    const name = window.prompt("Name of the new speaker");
    const clean = name ? name.trim() : "";
    if (!clean) return;
    const used = fmt.speakerIndices(t);
    assignSpeaker(pi, (used.length ? Math.max(...used) : -1) + 1, clean);
  }

  function renameSpeaker(idx, name) {
    const clean = name.trim();
    const names = { ...t.speakerNames };
    if (clean) names[idx] = clean;
    else delete names[idx];
    pushUndo();
    t = { ...t, speakerNames: names };
    changed();
  }

  const speakersBtn = iconBtn("users", "Speakers", () => openSpeakers());

  function openSpeakers() {
    if (popoverOpenFor(speakersBtn)) { closePopover(); return; }
    const box = h("div", { class: "menu speakers-menu" }, menuHeading("Speakers"));
    const idxs = fmt.speakerIndices(t);
    if (!idxs.length) box.append(h("p", { class: "muted menu-note", text: "No speakers yet." }));
    for (const idx of idxs) {
      const input = h("input", {
        type: "text",
        value: t.speakerNames[idx] || "",
        placeholder: `Speaker ${idx + 1}`,
        "aria-label": `Name of speaker ${idx + 1}`,
        autocomplete: "off",
        onchange() { renameSpeaker(idx, input.value); },
        onkeydown(e) { if (e.key === "Enter") { e.preventDefault(); input.blur(); } },
      });
      box.append(h("label", { class: `sp-row sp-${Math.abs(idx) % SPEAKER_COLORS}` },
        h("span", { class: "dot", "aria-hidden": "true" }), input));
    }
    openPopover(speakersBtn, box);
  }

  /* Playing highlight ---------------------------------------------- */

  function setPlaying(idx, scroll) {
    if (segEls[playingIdx]) segEls[playingIdx].classList.remove("playing");
    playingIdx = idx;
    const el = segEls[idx];
    if (!el) return;
    el.classList.add("playing");
    // With the word marker the current word is kept in view instead (see updateWord).
    if (scroll && !markersOn() && player.playing && Date.now() - lastUserScroll > 4000) ensureVisible(el);
  }

  /* Word marker ----------------------------------------------------- */

  // Word spans exist only with audio, in the original text and outside edit mode.
  function markersOn() {
    return hasAudio && !edit && shown === "original";
  }

  function clearNow() {
    if (nowEl) nowEl.classList.remove("w-now");
    nowEl = null;
  }

  // Keep the word about 35 percent from the top once it leaves the visible part, unless the user just scrolled.
  function keepWordVisible(el) {
    if (Date.now() - lastUserScroll < 4000) return;
    const r = el.getBoundingClientRect();
    const c = scroller.getBoundingClientRect();
    if (r.top >= c.top + 60 && r.bottom <= c.bottom - 160) return;
    const top = scroller.scrollTop + (r.top - c.top) - c.height * 0.35;
    scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  // Moves w-now to the word at the current time. Only the old and the new element are touched.
  function updateWord(scroll) {
    if (!markersOn() || destroyed) { clearNow(); return; }
    const raw = player.smoothTime();
    if (raw <= 0 && !player.playing) { clearNow(); return; }
    const time = Math.max(0, raw + markerLead);
    const words = segWords[segmentAt(paraStarts, time)];
    const wi = words && words.length ? findWordIndex(words, time) : -1;
    const next = wi >= 0 ? words[wi].el : null;
    if (next === nowEl) return;
    clearNow();
    if (!next) return;
    next.classList.add("w-now");
    nowEl = next;
    if (scroll && player.playing) keepWordVisible(next);
  }

  function frame() {
    rafId = 0;
    if (destroyed || !player.playing) return;
    updateWord(true);
    rafId = requestAnimationFrame(frame);
  }

  function onPlayState(playing) {
    if (playing) {
      if (!rafId) rafId = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(rafId);
      rafId = 0;
      updateWord(false);
    }
  }

  // Tap or click a word to jump there; play or pause state stays as it is.
  body.addEventListener("click", (e) => {
    if (!markersOn()) return;
    const w = e.target && e.target.closest ? e.target.closest(".w") : null;
    if (!w || !body.contains(w)) return;
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && !sel.isCollapsed && String(sel).length) return;
    const s = Number(w.dataset.s);
    if (Number.isFinite(s)) player.seek(s);
  });

  function ensureVisible(el) {
    const r = el.getBoundingClientRect();
    const c = scroller.getBoundingClientRect();
    if (r.top < c.top + 60 || r.bottom > c.bottom - 160) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function onTime(sec) {
    if (!hasAudio) return;
    const eff = markersOn() && player.playing ? Math.max(0, player.smoothTime() + markerLead) : sec;
    const idx = sec > 0 || player.playing ? segmentAt(paraStarts, eff) : -1;
    if (idx !== playingIdx) setPlaying(idx, true);
    // Seek while paused, and a fallback during playback when frames are throttled (e.g. low power mode).
    updateWord(player.playing);
    if (player.playing && !rafId) rafId = requestAnimationFrame(frame);
  }

  function playFrom(pi) {
    if (!hasAudio) return;
    player.seek(paraStarts[pi] ?? 0, { play: true });
  }

  function seekTo(sec) {
    const idx = segmentAt(paraStarts, sec);
    if (idx >= 0 && segEls[idx]) segEls[idx].scrollIntoView({ block: "center", behavior: "smooth" });
    if (hasAudio) player.seek(sec, { play: true });
  }

  function firstVisibleSegment() {
    const top = scroller.getBoundingClientRect().top + 60;
    const i = segEls.findIndex((el) => el.getBoundingClientRect().bottom > top);
    return i < 0 ? 0 : i;
  }

  scroller.addEventListener("wheel", () => { lastUserScroll = Date.now(); }, { passive: true });
  scroller.addEventListener("touchmove", () => { lastUserScroll = Date.now(); }, { passive: true });

  /* ---------------------------------------------------------------- */
  /* Search                                                            */
  /* ---------------------------------------------------------------- */

  let searchTimer = null;
  const searchCount = h("span", { class: "search-count", "aria-live": "polite" });
  const searchInput = h("input", {
    type: "search",
    class: "search-input",
    placeholder: "Search the transcript",
    "aria-label": "Search the transcript",
    autocomplete: "off",
    autocapitalize: "none",
    oninput() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { hitIndex = 0; renderBody(); markCurrentHit(true); }, 120);
    },
    onkeydown(e) {
      if (e.key === "Enter") { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSearch(); }
    },
  });
  const searchPrev = iconBtn("chevronDown", "Previous match", () => stepHit(-1), "ghost flip-v");
  const searchNext = iconBtn("chevronDown", "Next match", () => stepHit(1), "ghost");
  const searchBar = h("div", { class: "search-bar", role: "search", hidden: true },
    icon("search", 18), searchInput, searchCount, searchPrev, searchNext,
    iconBtn("x", "Close search", () => closeSearch(), "ghost"));

  function updateSearchCount() {
    const q = searchOpen ? searchInput.value.trim() : "";
    searchCount.textContent = !q ? "" : hits.length ? `${hitIndex + 1} of ${hits.length}` : "No matches";
    searchPrev.disabled = searchNext.disabled = hits.length === 0;
  }

  function markCurrentHit(scroll) {
    for (const el of body.querySelectorAll(".hit.current")) el.classList.remove("current");
    updateSearchCount();
    if (hitIndex < 0) return;
    const els = body.querySelectorAll(`[data-hit="${hitIndex}"]`);
    for (const el of els) el.classList.add("current");
    if (scroll && els[0]) els[0].scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function stepHit(dir) {
    if (!hits.length) return;
    hitIndex = (hitIndex + dir + hits.length) % hits.length;
    markCurrentHit(true);
  }

  function openSearch() {
    searchOpen = true;
    searchBar.hidden = false;
    searchInput.focus();
    searchInput.select();
  }

  function closeSearch() {
    if (!searchOpen) return;
    const had = hits.length > 0;
    searchOpen = false;
    searchBar.hidden = true;
    searchInput.value = "";
    hits = [];
    hitsByPara = new Map();
    hitIndex = -1;
    updateSearchCount();
    if (had) renderBody();
  }

  /* ---------------------------------------------------------------- */
  /* Edit mode and the floating toolbar                                */
  /* ---------------------------------------------------------------- */

  const editBtn = iconBtn("pencil", "Edit transcript", () => setEdit(!edit));
  editBtn.setAttribute("aria-pressed", "false");
  const listenIcon = h("span", { class: "listen-icon" }, icon("play", 18));
  const listenLabel = h("span", { text: "Listen" });
  const listenBtn = h("button", { type: "button", class: "pill ghost listen", hidden: true, onclick: () => listen() }, listenIcon, listenLabel);
  const floatBar = h("div", { class: "float-bar", role: "toolbar", "aria-label": "Editing tools", hidden: true },
    undoBtn, redoBtn,
    iconBtn("search", "Search", () => openSearch(), "ghost"),
    listenBtn,
    pill("Done", { primary: true, onclick: () => setEdit(false) }));
  const floatSlot = h("div", { class: "float-slot" }, floatBar);

  function setEdit(on) {
    if (on === edit) return;
    commitActive();
    if (on && shown === "translation") { shown = "original"; updateSwitch(); }
    edit = on;
    editBtn.setAttribute("aria-pressed", String(on));
    editBtn.setAttribute("aria-label", on ? "Leave edit mode" : "Edit transcript");
    floatBar.hidden = !on;
    tv.classList.toggle("editing", on);
    updateUndoButtons();
    renderBody();
  }

  function listen() {
    if (!hasAudio) return;
    if (player.playing) { player.pause(); return; }
    const idx = lastFocused >= 0 ? lastFocused : firstVisibleSegment();
    player.seek(paraStarts[idx] ?? 0, { play: true });
  }

  function showListenState(playing) {
    listenIcon.replaceChildren(icon(playing ? "pause" : "play", 18));
    listenLabel.textContent = playing ? "Pause" : "Listen";
  }

  /* ---------------------------------------------------------------- */
  /* Original and translation                                          */
  /* ---------------------------------------------------------------- */

  const origBtn = h("button", { type: "button", class: "seg-btn", text: "Original", onclick: () => setShown("original") });
  const transBtn = h("button", { type: "button", class: "seg-btn", onclick: () => setShown("translation") });
  const switchEl = h("div", { class: "seg-switch", role: "group", "aria-label": "Original or translation", hidden: true }, origBtn, transBtn);

  function hasTranslation() {
    return !!(t.translation && Array.isArray(t.translation.lines) && t.translation.lines.length);
  }

  function updateSwitch() {
    switchEl.hidden = !hasTranslation();
    if (!hasTranslation()) { shown = "original"; return; }
    transBtn.textContent = `Translation (${languageLabel(t.translation.language)})`;
    origBtn.setAttribute("aria-pressed", String(shown === "original"));
    transBtn.setAttribute("aria-pressed", String(shown === "translation"));
  }

  function setShown(which) {
    if (which === "translation" && !hasTranslation()) return;
    if (which === "translation" && edit) setEdit(false);
    shown = which;
    updateSwitch();
    renderBody();
  }

  /* ---------------------------------------------------------------- */
  /* Flow panels: correct with Claude, translate                       */
  /* ---------------------------------------------------------------- */

  const flowHost = h("div", { class: "flow-host" });
  const resultHost = h("div", { class: "flow-host" });

  function flowCard(title, ...content) {
    return h("section", { class: "card stack", "aria-label": title },
      h("div", { class: "card-head" }, h("h2", { text: title }), iconBtn("x", "Close", () => closeFlow(), "ghost")),
      ...content);
  }

  function closeFlow() {
    activeFlow = null;
    flowHost.replaceChildren();
  }

  function openFlow(kind) {
    if (activeFlow === kind) { closeFlow(); return; }
    closeFlow();
    activeFlow = kind;
    const node = kind === "correct" ? buildCorrectFlow() : buildTranslateFlow();
    flowHost.replaceChildren(node);
    node.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function buildCorrectFlow() {
    const flow = createClaudeFlow({
      intro: "Claude never rewrites the transcript. It only suggests small find and replace corrections, and nothing changes until you apply them. Paste the prompt into a new Claude chat (a strong model works best), wait for the JSON answer, then copy the whole answer.",
      getPrompts: () => [corr.buildPrompt(t, { keyterms: t.keyterms })],
      fileBase: () => `${t.title || "transcript"}_claude_prompt`,
      checkLabel: "Check answer",
      onCheck(text) {
        const { corrections, errors } = corr.parseAnswer(text);
        if (!corrections.length) return { errors, info: errors.length ? "" : "Claude found nothing to correct." };
        return { errors, review: buildCorrectionReview({ transcript: t, corrections, onApply: applyNow }) };
      },
    });
    return flowCard("Correct with Claude", flow.el);
  }

  function applyNow(selected) {
    commitActive();
    pushUndo();
    const res = corr.applyCorrections(t, selected);
    t = res.transcript;
    closeFlow();
    resultHost.replaceChildren(correctionResultNode(res, () => resultHost.replaceChildren()));
    changed();
  }

  function buildTranslateFlow() {
    let target = (t.translation && t.translation.language) || (t.language === "de" ? "en" : "de");
    const select = h("select", {
      "aria-label": "Translate into",
      onchange() { target = select.value; flow.refresh(); },
    }, LANGUAGES.map((l) => h("option", { value: l.value, text: l.label })));
    select.value = target;

    const flow = createClaudeFlow({
      intro: "Claude translates the transcript line by line. Long transcripts are split into parts: paste each answer in turn. You can switch between the original and the translation above the text.",
      getPrompts: () => tasks.buildTranslatePrompts(t, { targetLanguage: target }),
      fileBase: () => `${t.title || "transcript"}_translate_prompt`,
      checkLabel: "Save translation",
      onCheck(text) {
        const { lines, errors } = tasks.parseTranslateAnswer(text);
        if (!lines.length) return { errors };
        t = tasks.mergeTranslation(t, target, lines);
        scheduleSave();
        updateSwitch();
        const total = t.paragraphs.reduce((n, p) => n + (p.sentences || []).filter((s) => normalize(s.text)).length, 0);
        const done = t.translation.lines.length;
        if (done >= total) setShown("translation");
        return { errors, accepted: true, info: `Saved. ${done} of ${plural(total, "line", "lines")} translated.` };
      },
    });

    const remove = hasTranslation()
      ? pill("Remove translation", {
        danger: true,
        cls: "small",
        onclick() {
          if (!window.confirm("Remove the saved translation from this transcript?")) return;
          const next = { ...t };
          delete next.translation;
          t = next;
          scheduleSave();
          setShown("original");
          updateSwitch();
          closeFlow();
        },
      })
      : null;

    return flowCard("Translate",
      h("div", { class: "field" }, h("label", { text: "Translate into" }), selectWrap(select)),
      flow.el,
      remove);
  }

  /* ---------------------------------------------------------------- */
  /* Menus                                                             */
  /* ---------------------------------------------------------------- */

  const moreBtn = iconBtn("more", "More", () => openMore());
  const dlBtn = iconBtn("download", "Download", () => openDownload());
  const copyLabel = h("span", { text: "Copy" });
  const copyIcon = h("span", { class: "copy-icon" }, icon("copy", 18));
  const copyBtn = h("button", { type: "button", class: "pill primary", onclick: () => copyAll() }, copyIcon, copyLabel);
  let copyTimer = null;

  function filenameFor(f) {
    return `${exp.safeFilename(t.title || "transcript")}.${f.ext}`;
  }

  function openDownload() {
    if (popoverOpenFor(dlBtn)) { closePopover(); return; }
    const box = h("div", { class: "menu", role: "menu" },
      EXPORT_FORMATS.map((f) => menuItem({
        iconName: "download",
        label: f.label,
        onclick() {
          closePopover();
          try {
            exp.downloadFile(filenameFor(f), f.build(t), f.mime);
            toast(`${f.label} downloaded`);
          } catch (err) {
            alert.show(`Could not create the ${f.label} file. ${errorMessage(err)}`);
          }
        },
      })));
    openPopover(dlBtn, box, { align: "end" });
  }

  function displayedTranscript() {
    if (shown !== "translation") return t;
    return {
      ...t,
      paragraphs: t.paragraphs.map((p, pi) => ({
        ...p,
        sentences: (p.sentences || []).map((s, si) => ({ ...s, text: tasks.translationFor(t, corr.sentenceId(pi, si)) ?? s.text })),
      })),
    };
  }

  async function copyAll() {
    const ok = await copyText(exp.toText(displayedTranscript()));
    if (!ok) { toast("Copying was blocked by the browser. Use a download instead."); return; }
    copyLabel.textContent = "Copied";
    copyIcon.replaceChildren(icon("check", 18));
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyLabel.textContent = "Copy";
      copyIcon.replaceChildren(icon("copy", 18));
    }, 2000);
  }

  async function share() {
    const f = EXPORT_FORMATS[0];
    try {
      const done = await exp.shareFile(filenameFor(f), f.build(t), f.mime);
      if (!done) toast("Sharing is not available here. Use Download instead.");
    } catch (err) {
      alert.show(`Could not share the file. ${errorMessage(err)}`);
    }
  }

  function showInfo() {
    const words = t.paragraphs.flatMap((p) => (p.sentences || []).flatMap((s) => s.words || []));
    const uncertain = words.length ? words.filter(corr.isUncertainWord).length : null;
    const rows = [
      ["Date", formatDateTime(t.createdAt)],
      ["Duration", t.durationSec != null ? fmt.formatDuration(t.durationSec) : ""],
      ["Language", languageLabel(t.language)],
      ["Words", t.stats && t.stats.words != null ? Number(t.stats.words).toLocaleString() : ""],
      ["Uncertain words", uncertain != null ? uncertain.toLocaleString() : ""],
      ["Estimated cost", t.costUsd != null ? `$${Number(t.costUsd).toFixed(2)}` : ""],
      ["Model", [t.engine, t.model].filter(Boolean).join(" ")],
      ["Keyterms", (t.keyterms || []).length ? t.keyterms.join(", ") : "None"],
      ["Audio", hasAudio ? "Stored on this device" : "Not stored"],
    ].filter(([, v]) => v);
    openDialog({
      title: "Info",
      content: h("dl", { class: "info-list" }, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])),
      actions: [{ label: "Close", primary: true }],
    });
  }

  async function deleteThis() {
    if (!window.confirm(`Delete "${t.title || "this transcript"}" from this device? This cannot be undone.`)) return;
    try {
      deleted = true;
      clearTimeout(saveTimer);
      await storage.deleteTranscript(t.id);
      try { await media.deleteAudio(t.audioId || t.id); } catch { /* no audio stored */ }
      if (state.unsaved && state.unsaved.id === t.id) state.unsaved = null;
      ctx.refreshHistory();
      ctx.navigate("#new");
    } catch (err) {
      deleted = false;
      alert.show(`Could not delete the transcript. ${errorMessage(err)}`);
    }
  }

  function revert() {
    if (!window.confirm("Undo all corrections made with Claude and restore the original transcript?")) return;
    commitActive();
    pushUndo();
    t = corr.revertCorrections(t);
    resultHost.replaceChildren();
    changed();
    toast("Corrections reverted");
  }

  function applyTextSize(size) {
    tv.style.setProperty("--t-size", SIZES[size] || SIZES.m);
  }

  function openMore() {
    if (popoverOpenFor(moreBtn)) { closePopover(); return; }
    const s = settings();
    const done = (fn) => () => { closePopover(); fn(); };

    const sizeBtns = ["s", "m", "l"].map((k) => h("button", {
      type: "button",
      class: `size-btn size-${k}`,
      "aria-label": { s: "Small text", m: "Medium text", l: "Large text" }[k],
      "aria-pressed": String((s.textSize || "m") === k),
      text: "A",
      onclick() {
        storage.saveSettings({ textSize: k });
        applyTextSize(k);
        for (const b of sizeBtns) b.setAttribute("aria-pressed", String(b === this));
      },
    }));

    const leadValue = h("span", { class: "lead-value muted", text: formatLead(markerLead), "aria-live": "polite" });
    const stepLead = (delta) => {
      markerLead = clampLead(markerLead + delta);
      storage.saveSettings({ markerLead });
      leadValue.textContent = formatLead(markerLead);
      updateWord(false);
    };

    const box = h("div", { class: "menu", role: "menu" },
      menuItem({ iconName: "pencil", label: "Rename", onclick: done(startRename) }),
      canShare ? menuItem({ iconName: "share", label: "Share", onclick: done(share) }) : null,
      menuItem({ iconName: "info", label: "Info", onclick: done(showInfo) }),
      menuItem({ iconName: "search", label: "Search", onclick: done(openSearch) }),
      menuSeparator(),
      menuItem({ iconName: "sparkle", label: "Correct with Claude", onclick: done(() => openFlow("correct")) }),
      menuItem({ iconName: "globe", label: "Translate", onclick: done(() => openFlow("translate")) }),
      t.originalParagraphs ? menuItem({ iconName: "undo", label: "Revert corrections", onclick: done(revert) }) : null,
      menuItem({ iconName: "trash", label: "Delete", danger: true, onclick: done(deleteThis) }),
      menuSeparator(),
      menuHeading("Display"),
      h("div", { class: "menu-row" },
        h("span", { class: "menu-icon-gap" }),
        h("span", { class: "menu-label-text", text: "Text size" }),
        h("div", { class: "size-group", role: "group", "aria-label": "Text size" }, sizeBtns)),
      switchRow({
        iconName: "clock", label: "Timestamps", checked: s.showTimestamps !== false,
        onchange(on) { storage.saveSettings({ showTimestamps: on }); renderBody(); },
      }),
      switchRow({
        label: "Highlight uncertain words", checked: s.highlightUncertain !== false,
        onchange(on) { storage.saveSettings({ highlightUncertain: on }); renderBody(); },
      }),
      h("div", { class: "menu-row" },
        h("span", { class: "menu-icon-gap" }),
        h("span", { class: "menu-label-text", text: "Marker timing" }),
        leadValue,
        h("div", { class: "size-group", role: "group", "aria-label": "Marker timing" },
          h("button", { type: "button", class: "lead-btn", text: "Earlier", onclick() { stepLead(LEAD_STEP); } }),
          h("button", { type: "button", class: "lead-btn", text: "Later", onclick() { stepLead(-LEAD_STEP); } }))));
    openPopover(moreBtn, box);
  }

  /* ---------------------------------------------------------------- */
  /* Side panel                                                        */
  /* ---------------------------------------------------------------- */

  const panelBtn = iconBtn("panelRight", "Notes, summary and study aids", () => togglePanel());
  panelBtn.setAttribute("aria-pressed", "false");

  const panel = createSidePanel({
    getT: () => t,
    patch,
    player,
    onSeek: seekTo,
    getTime: () => (hasAudio ? player.currentTime : 0),
    onClose: () => { panelSheetOpen = false; syncPanel(); },
  });

  const isWide = () => tv.clientWidth >= WIDE_PANEL_PX;

  function syncPanel() {
    const collapsed = settings().panelOpen === false;
    tv.classList.toggle("panel-collapsed", collapsed);
    tv.classList.toggle("sheet-open", panelSheetOpen);
    panelBtn.setAttribute("aria-pressed", String(isWide() ? !collapsed : panelSheetOpen));
  }

  function togglePanel() {
    if (isWide()) storage.saveSettings({ panelOpen: settings().panelOpen === false });
    else panelSheetOpen = !panelSheetOpen;
    syncPanel();
    if (!panelSheetOpen) return;
    const tab = panel.el.querySelector('[role="tab"][aria-selected="true"]');
    if (tab) tab.focus();
  }

  /* ---------------------------------------------------------------- */
  /* Assembly                                                          */
  /* ---------------------------------------------------------------- */

  const toolbar = h("div", { class: "tv-toolbar" },
    h("div", { class: "tb-group" }, editBtn, speakersBtn, moreBtn, panelBtn),
    h("div", { class: "tb-group" }, dlBtn, copyBtn));

  const inner = h("div", { class: "tv-inner" },
    titleEl, metaEl, toolbar, alert.el, searchBar, flowHost, resultHost, switchEl, body);
  scroller.append(inner);

  const mainCol = h("div", { class: "main-col" }, scroller, floatSlot);
  const sheetBackdrop = h("div", { class: "sheet-backdrop", onclick: () => { panelSheetOpen = false; syncPanel(); } });
  const tv = h("div", { class: "tv" }, mainCol, sheetBackdrop, panel.el);
  applyTextSize(settings().textSize || "m");

  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => syncPanel());
    ro.observe(tv);
  }

  updateMeta();
  updateUndoButtons();
  updateSwitch();
  syncPanel();
  renderBody();

  /* ---------------------------------------------------------------- */
  /* Audio                                                             */
  /* ---------------------------------------------------------------- */

  let bar = null;

  async function loadAudio() {
    player.pause();
    player.unload();
    let record = null;
    try { record = await media.getAudio(t.audioId || t.id); } catch { record = null; }
    if (!record || !record.blob || destroyed) return;
    try {
      await player.load(record.blob);
    } catch {
      if (!destroyed) toast("The stored audio could not be opened.");
      return;
    }
    if (destroyed) return;
    hasAudio = true;
    audioBlob = record.blob;
    bar = createPlayerBar({ player, getStarts: () => paraStarts, getTotal: () => t.durationSec });
    mainCol.append(bar.el);
    tv.classList.add("has-audio");
    listenBtn.hidden = false;
    panel.setBlob(audioBlob);
    renderBody();
  }

  disposers.push(player.on("time", onTime));
  disposers.push(player.on("state", showListenState));
  disposers.push(player.on("state", onPlayState));
  disposers.push(() => { cancelAnimationFrame(rafId); rafId = 0; });
  disposers.push(player.on("error", (e) => toast(errorMessage(e))));
  loadAudio();

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  function onKey(e) {
    if (isDialogOpen()) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key) && !isTyping(e.target)) lastUserScroll = Date.now();
    const mod = e.metaKey || e.ctrlKey;
    const key = (e.key || "").toLowerCase();

    if (mod && key === "f") { e.preventDefault(); openSearch(); return; }

    if (e.key === "Escape") {
      if (isPopoverOpen()) return;
      if (panelSheetOpen) { panelSheetOpen = false; syncPanel(); return; }
      if (searchOpen) closeSearch();
      return;
    }

    if (mod && edit && (key === "z" || key === "y")) {
      const a = document.activeElement;
      const inSeg = a && a.classList && a.classList.contains("seg-text");
      if (inSeg && normalize(a.textContent) !== a.dataset.c) return; // let the browser undo the typing
      if (isTyping(e.target) && !inSeg) return;
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo(); else undo();
      return;
    }

    if (e.key === " " && !e.repeat && !mod && hasAudio && !isTyping(e.target)) {
      if (e.target.closest && e.target.closest("button, a, summary, [role='tab'], [role='slider']")) return;
      e.preventDefault();
      player.toggle();
    }
  }
  document.addEventListener("keydown", onKey);
  disposers.push(() => document.removeEventListener("keydown", onKey));

  return {
    el: tv,
    id: t.id,
    // Rename from outside (sidebar) without losing pending edits.
    async setTitle(value) {
      patch({ title: value });
      titleEl.textContent = value;
      document.title = `${value} · Lecture Transcriber`;
      await flushSave();
    },
    // The transcript is being deleted from outside: never write it again.
    abandon() {
      deleted = true;
      clearTimeout(saveTimer);
    },
    destroy() {
      destroyed = true;
      closePopover();
      commitActive();
      clearTimeout(searchTimer);
      clearTimeout(copyTimer);
      panel.destroy();
      flushSave();
      if (bar) bar.destroy();
      if (ro) ro.disconnect();
      for (const d of disposers) d();
      player.pause();
      player.unload();
    },
  };
}
