// Word times for the playback marker. Pure logic, no DOM.
// Real times come from Deepgram (word.s / word.e). Old transcripts and edited sentences have none,
// so they are spread over the sentence time, proportional to word length.

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round2 = (v) => Math.round(v * 100) / 100;
const letters = (t) => String(t || "").replace(/[^\p{L}\p{N}]/gu, "").length;

// Boundaries start..end for texts, weight = letters + 1. Returns [{ s, e }] with s ascending, e >= s.
function distribute(texts, start, end) {
  const n = texts.length;
  const weights = texts.map((t) => letters(t) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const out = [];
  let acc = 0;
  let prev = start;
  for (let i = 0; i < n; i++) {
    acc += weights[i];
    const b = i === n - 1 ? end : Math.min(end, Math.max(prev, round2(start + ((end - start) * acc) / total)));
    out.push({ s: prev, e: b });
    prev = b;
  }
  return out;
}

/** Words of a sentence with numeric s/e (seconds), never empty for a non empty sentence. */
export function timedWords(sentence) {
  const s = sentence || {};
  const words = Array.isArray(s.words) ? s.words.filter((w) => w && String(w.t || "") !== "") : [];

  // 1. Real times on every word.
  if (words.length && words.every((w) => isNum(w.s) && isNum(w.e))) {
    return words.map((w) => ({ ...w, e: Math.max(w.e, w.s) }));
  }

  // 2./3. Interpolate over the sentence time.
  const items = words.length
    ? words.map((w) => ({ ...w }))
    : String(s.text || "").split(/\s+/).filter(Boolean).map((t) => ({ t, c: undefined }));
  if (!items.length) return [];

  let start = isNum(s.start) ? s.start : isNum(words[0]?.s) ? words[0].s : 0;
  let end = isNum(s.end) ? s.end : NaN;
  if (!isNum(end) || end < start) end = start + items.length * 0.3; // no usable end: assume 0.3 s per word
  const spans = distribute(items.map((w) => w.t), start, end);
  return items.map((w, i) => ({ ...w, s: spans[i].s, e: spans[i].e }));
}

/** Index i with timed[i].s <= time < timed[i+1].s. -1 before the first word, last index after the last start. */
export function findWordIndex(timed, time) {
  const n = timed ? timed.length : 0;
  if (!n || !(time >= timed[0].s)) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timed[mid].s <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
