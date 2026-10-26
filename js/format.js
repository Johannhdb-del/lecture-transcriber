// Pure helpers for formatting times, sizes, costs and keyterms.

const pad = (n, w = 2) => String(n).padStart(w, "0");

// "HH:MM:SS" (seconds are floored)
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// "HH:MM:SS,mmm" for SRT (sep ","), "HH:MM:SS.mmm" for VTT (sep ".")
export function formatTimestamp(sec, sep = ",") {
  // Round to whole milliseconds first so 59.9996 carries into the next second.
  const totalMs = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}${sep}${pad(ms, 3)}`;
}

// "1 h 32 min" / "18 min 45 s" / "45 s"
export function formatDuration(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

// "9.1 MB"
export function formatBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

// Custom name if set and non-empty, else "Speaker N" with N = idx + 1
export function speakerName(transcript, idx) {
  const custom = transcript && transcript.speakerNames && transcript.speakerNames[String(idx)];
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  return `Speaker ${Number(idx) + 1}`;
}

// Sorted unique speaker numbers used in the paragraphs
export function speakerIndices(transcript) {
  const set = new Set();
  for (const p of (transcript && transcript.paragraphs) || []) set.add(Number(p.speaker) || 0);
  return [...set].sort((a, b) => a - b);
}

// Estimated USD cost: minutes * (0.0043 + keyterm surcharge 0.0013)
export function estimateCost(durationSec, hasKeyterms) {
  const min = Math.max(0, Number(durationSec) || 0) / 60;
  return min * (0.0043 + (hasKeyterms ? 0.0013 : 0));
}

// One term per line; skips blanks and "#" comments; case-insensitive dedupe
export function parseKeyterms(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || "").replace(/﻿/g, "").split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

// Text of one paragraph: its sentences joined by a space
export function paragraphText(p) {
  return ((p && p.sentences) || [])
    .map((s) => String(s.text || "").trim())
    .filter(Boolean)
    .join(" ");
}

// Paragraphs joined by a blank line, no labels
export function transcriptPlainText(transcript) {
  return ((transcript && transcript.paragraphs) || [])
    .map(paragraphText)
    .filter(Boolean)
    .join("\n\n");
}
