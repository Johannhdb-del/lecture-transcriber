// Turning transcript paragraphs into styled text runs, and search highlights into DOM nodes.
import { isUncertainWord, sentenceId } from "../correction.js";
import { translationFor } from "../claude-tasks.js";
import { h } from "./dom.js";

const tokens = (text) => String(text || "").split(/\s+/).filter(Boolean);

function wordsMatchText(words, text) {
  return words.length > 0 && tokens(text).join(" ") === words.map((w) => String(w.t)).join(" ");
}

function pushRun(runs, run) {
  const last = runs[runs.length - 1];
  if (last && !last.cls && !run.cls && !last.title && !run.title) last.text += run.text;
  else runs.push(run);
}

/**
 * Runs for one paragraph: [{ text, cls, title }]. cls is "", "uncertain" or "fixed".
 * With translated = true the translated sentences are used (original where missing).
 */
export function buildRuns(t, pi, { uncertain = true, translated = false } = {}) {
  const p = t.paragraphs[pi];
  const runs = [];
  (p.sentences || []).forEach((s, si) => {
    if (si) pushRun(runs, { text: " ", cls: "" });
    if (translated) {
      const tr = translationFor(t, sentenceId(pi, si));
      pushRun(runs, { text: tr == null ? String(s.text || "") : tr, cls: "" });
      return;
    }
    const words = Array.isArray(s.words) ? s.words : [];
    if (!wordsMatchText(words, s.text)) {
      pushRun(runs, { text: String(s.text || ""), cls: "" });
      return;
    }
    words.forEach((w, i) => {
      if (i) pushRun(runs, { text: " ", cls: "" });
      if (w.fixed) {
        pushRun(runs, { text: String(w.t), cls: "fixed", title: "Corrected with Claude" });
      } else if (uncertain && isUncertainWord(w)) {
        pushRun(runs, { text: String(w.t), cls: "uncertain", title: `Uncertain (${Math.round(Number(w.c) * 100)}%)` });
      } else {
        pushRun(runs, { text: String(w.t), cls: "" });
      }
    });
  });
  return runs;
}

export function runsText(runs) {
  return runs.map((r) => r.text).join("");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** All case insensitive matches of query in text as [{ start, end }]. */
export function findMatches(text, query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const re = new RegExp(escapeRe(q), "gi");
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function piece(run, text, hit) {
  if (!run.cls && !hit) return document.createTextNode(text);
  const classes = [run.cls, hit ? "hit" : ""].filter(Boolean).join(" ");
  const el = h("span", { class: classes, title: run.title || null, text });
  if (hit) el.dataset.hit = String(hit.idx);
  return el;
}

/** Render runs to a fragment. matches: [{ start, end, idx }] sorted, relative to the runs text. */
export function renderRuns(runs, matches = []) {
  const frag = document.createDocumentFragment();
  let pos = 0;
  let mi = 0;
  for (const run of runs) {
    const runEnd = pos + run.text.length;
    let cursor = pos;
    while (cursor < runEnd) {
      while (mi < matches.length && matches[mi].end <= cursor) mi++;
      const m = matches[mi];
      let segEnd = runEnd;
      let hit = null;
      if (m && m.start < runEnd) {
        if (m.start > cursor) segEnd = m.start;
        else { segEnd = Math.min(m.end, runEnd); hit = m; }
      }
      frag.append(piece(run, run.text.slice(cursor - pos, segEnd - pos), hit));
      cursor = segEnd;
    }
    pos = runEnd;
  }
  return frag;
}

/** Index of the last start that is at or before time, or -1. Starts must be sorted. */
export function segmentAt(starts, time) {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= time + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
