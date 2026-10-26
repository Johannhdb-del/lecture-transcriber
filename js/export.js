// Export a normalized transcript to TXT, Markdown, SRT, VTT and hand files to the user.
import {
  formatTime,
  formatTimestamp,
  formatDuration,
  speakerName,
  paragraphText,
} from "./format.js";

const MAX_CUE_CHARS = 84; // two lines of about 42 characters
const MAX_CUE_SEC = 7;
const LINE_CHARS = 42;
const MIN_CUE_SEC = 0.5; // used when a cue would end at or before its start

// ---- Plain text and Markdown ----

export function toText(t) {
  const blocks = [String(t.title || "").trim() || "Transcript"];
  let prev = null;
  for (const p of t.paragraphs || []) {
    const text = paragraphText(p);
    if (!text) continue;
    const stamp = `[${formatTime(p.start)}]`;
    const head = p.speaker !== prev ? `${stamp} ${speakerName(t, p.speaker)}:` : stamp;
    prev = p.speaker;
    blocks.push(`${head}\n${text}`);
  }
  return blocks.join("\n\n") + "\n";
}

const LANGUAGE_LABELS = { de: "German", en: "English" };

function localDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toMarkdown(t) {
  const meta = [
    localDate(t.createdAt),
    formatDuration(t.durationSec),
    LANGUAGE_LABELS[t.language] || t.language || "",
  ].filter(Boolean);
  const blocks = [`# ${String(t.title || "").trim() || "Transcript"}`, `*${meta.join(" | ")}*`];
  let prev = null;
  for (const p of t.paragraphs || []) {
    const text = paragraphText(p);
    if (!text) continue;
    const stamp = `[${formatTime(p.start)}]`;
    const head = p.speaker !== prev ? `**${speakerName(t, p.speaker)}** ${stamp}` : stamp;
    prev = p.speaker;
    blocks.push(`${head}\n\n${text}`);
  }
  return blocks.join("\n\n") + "\n";
}

// ---- Subtitle cues ----

// Split one sentence into cues of at most ~84 chars / 7 s, at word boundaries.
// Times are interpolated by each chunk's share of the characters.
function splitSentence(text, start, end) {
  const dur = Math.max(0, end - start);
  if (text.length <= MAX_CUE_CHARS && dur <= MAX_CUE_SEC) return [{ text, start, end }];

  const words = text.split(/\s+/).filter(Boolean);
  const n = Math.min(
    words.length,
    Math.max(Math.ceil(text.length / MAX_CUE_CHARS), Math.ceil(dur / MAX_CUE_SEC))
  );
  const target = Math.ceil(text.length / n);

  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const w of words) {
    const added = curLen === 0 ? w.length : curLen + 1 + w.length;
    if (cur.length && added > target && added > 0 && chunks.length < n - 1) {
      chunks.push(cur.join(" "));
      cur = [w];
      curLen = w.length;
    } else {
      cur.push(w);
      curLen = added;
    }
  }
  if (cur.length) chunks.push(cur.join(" "));

  const total = chunks.reduce((s, c) => s + c.length, 0) || 1;
  let done = 0;
  return chunks.map((c) => {
    const s = start + (dur * done) / total;
    done += c.length;
    return { text: c, start: s, end: start + (dur * done) / total };
  });
}

// Break text into at most two balanced lines of about 42 chars.
function wrapLines(text) {
  if (text.length <= LINE_CHARS) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

// Build ordered cues: { start, end, speaker, speakerChange, text }
function buildCues(t) {
  const cues = [];
  let prevSpeaker = null;
  for (const p of t.paragraphs || []) {
    let change = p.speaker !== prevSpeaker;
    prevSpeaker = p.speaker;
    for (const s of p.sentences || []) {
      const text = String(s.text || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const start = Number.isFinite(s.start) ? s.start : p.start || 0;
      const end = Number.isFinite(s.end) ? s.end : Math.max(start, p.end || start);
      for (const part of splitSentence(text, start, end)) {
        cues.push({ ...part, speaker: p.speaker, speakerChange: change });
        change = false;
      }
    }
  }
  // Enforce time order, no overlap, and end > start for every cue.
  let prevEnd = 0;
  for (const c of cues) {
    c.start = Math.max(c.start, prevEnd);
    if (c.end - c.start < 0.05) c.end = c.start + MIN_CUE_SEC;
    prevEnd = c.end;
  }
  return cues;
}

export function toSRT(t) {
  return (
    buildCues(t)
      .map((c, i) => {
        const text = wrapLines(c.speakerChange ? `${speakerName(t, c.speaker)}: ${c.text}` : c.text);
        return `${i + 1}\n${formatTimestamp(c.start, ",")} --> ${formatTimestamp(c.end, ",")}\n${text}`;
      })
      .join("\n\n") + "\n"
  );
}

const vttEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function toVTT(t) {
  const cues = buildCues(t).map((c) => {
    const name = speakerName(t, c.speaker).replace(/[>\r\n]+/g, " ");
    const text = vttEscape(wrapLines(c.text));
    return `${formatTimestamp(c.start, ".")} --> ${formatTimestamp(c.end, ".")}\n<v ${name}>${text}`;
  });
  return "WEBVTT\n\n" + cues.join("\n\n") + (cues.length ? "\n" : "");
}

// ---- Files ----

const TRANSLITERATION = { "ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss" };

export function safeFilename(title) {
  const name = String(title || "")
    .replace(/[äöüÄÖÜß]/g, (c) => TRANSLITERATION[c])
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // drop accents, e.g. é -> e
    .replace(/[^\x20-\x7E]/g, "") // strip any remaining non ASCII
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .slice(0, 80)
    .replace(/[_.]+$/g, "");
  return name || "transcript";
}

// Works in iPad Safari: Blob URL + anchor with download attribute attached to the DOM.
export function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function canShareFiles() {
  try {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
    if (typeof navigator.canShare !== "function") return false;
    return navigator.canShare({ files: [new File(["x"], "x.txt", { type: "text/plain" })] });
  } catch (e) {
    return false;
  }
}

// Returns true if shared (or the user cancelled the sheet), false if unsupported or failed.
export async function shareFile(filename, content, mime) {
  try {
    const file = new File([content], filename, { type: mime || "text/plain" });
    if (!navigator.canShare || !navigator.canShare({ files: [file] })) return false;
    await navigator.share({ files: [file], title: filename });
    return true;
  } catch (e) {
    return e && e.name === "AbortError";
  }
}
