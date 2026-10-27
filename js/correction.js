// "Correct with Claude": build a prompt, read Claude's JSON answer, apply find/replace corrections.
// Pure logic, no DOM. The transcript is never mutated; every function returns new data.
import { formatDuration, speakerName } from "./format.js";

/* ------------------------------------------------------------------ */
/* Uncertain words (shared by the highlight in app.js and the prompt)  */
/* ------------------------------------------------------------------ */

const UNCERTAIN_BELOW = 0.6;
const MAX_CORRECTIONS = 200;
const TYPES = ["fix", "guess", "format"];
const MARK_OPEN = "⟦"; // ⟦
const MARK_CLOSE = "⟧"; // ⟧
const MARKS = /[⟦⟧]/g;

// Short function words are often low confidence but rarely wrong, so they are not marked.
const COMMON_WORDS = new Set((
  "und oder aber auch dann denn doch noch nur schon ja nein genau also mal eben halt so wie wo was wer " +
  "der die das den dem des ein eine einer eines einem einen im in am an auf aus bei mit von vor zu zum zur " +
  "es er sie wir ihr ich du man sich ist sind war hat haben wird kann muss soll nicht kein dass ob wenn weil " +
  "geht gibt dies diese dieser hier da dort sehr mehr ganz the a an and or of to in on at is it that this"
).split(" "));

/** True when the recognizer was unsure about this word ({t, c}) and it is worth a second look. */
export function isUncertainWord(w) {
  const c = Number(w.c);
  if (!Number.isFinite(c) || c >= UNCERTAIN_BELOW) return false;
  const bare = String(w.t || "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  if (/\d/.test(bare)) return true;
  return bare.length > 3 && !COMMON_WORDS.has(bare);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const clone = (v) => JSON.parse(JSON.stringify(v));
const tokenize = (text) => String(text || "").split(/\s+/).filter(Boolean);

/** Line id such as "p12.s3". Both numbers are 1 based. */
export function sentenceId(pIndex, sIndex) {
  return `p${pIndex + 1}.s${sIndex + 1}`;
}

/** The sentence with this id, or null. */
export function findSentence(transcript, id) {
  const m = /^p(\d+)\.s(\d+)$/i.exec(String(id || "").trim());
  if (!m) return null;
  const p = (transcript.paragraphs || [])[Number(m[1]) - 1];
  const s = p && (p.sentences || [])[Number(m[2]) - 1];
  return s || null;
}

const isWordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

// First occurrence of needle in hay that is not glued to other letters or digits.
function indexOfWhole(hay, needle) {
  const needStart = isWordChar(needle[0]);
  const needEnd = isWordChar(needle[needle.length - 1]);
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return -1;
    const before = hay[i - 1];
    const after = hay[i + needle.length];
    if ((!needStart || !isWordChar(before)) && (!needEnd || !isWordChar(after))) return i;
    from = i + 1;
  }
}

/**
 * Where does `find` occur in `text`? Whole word matches win over matches inside a word,
 * exact case wins over case insensitive. Returns { index, length } or null.
 */
export function locateText(text, find) {
  text = String(text || "");
  find = String(find || "");
  if (!find) return null;
  let i = indexOfWhole(text, find);
  if (i < 0) i = text.indexOf(find);
  if (i >= 0) return { index: i, length: find.length };
  const lowText = text.toLowerCase();
  const lowFind = find.toLowerCase();
  if (lowText.length !== text.length || lowFind.length !== find.length) return null; // odd characters, give up
  i = indexOfWhole(lowText, lowFind);
  if (i < 0) i = lowText.indexOf(lowFind);
  return i >= 0 ? { index: i, length: find.length } : null;
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

const LANGUAGE_NAMES = { de: "German", en: "English" };

// The line text. Uncertain words are wrapped in marks, but only when the words
// still add up to the sentence text, so "find" always matches sentence.text.
function markedText(s) {
  const text = String(s.text || "").replace(/\s+/g, " ").trim();
  const words = Array.isArray(s.words) ? s.words : [];
  if (!words.length || tokenize(text).join(" ") !== words.map((w) => String(w.t)).join(" ")) return text;
  return words.map((w) => (isUncertainWord(w) ? `${MARK_OPEN}${w.t}${MARK_CLOSE}` : String(w.t))).join(" ");
}

// Terms joined with ", " and wrapped into lines of about `width` characters.
function wrapTerms(list, width = 100) {
  const lines = [];
  let line = "";
  list.forEach((t, i) => {
    const piece = i < list.length - 1 ? `${t},` : t;
    if (line && line.length + 1 + piece.length > width) { lines.push(line); line = piece; }
    else line = line ? `${line} ${piece}` : piece;
  });
  if (line) lines.push(line);
  return lines;
}

export function buildPrompt(transcript, { keyterms, docTerms } = {}) {
  const terms = (keyterms ?? transcript.keyterms ?? []).map((k) => String(k).trim()).filter(Boolean);
  const known = new Set(terms.map((k) => k.toLowerCase()));
  const literature = [];
  for (const k of docTerms || []) {
    const t = String(k).trim();
    if (!t || known.has(t.toLowerCase())) continue;
    known.add(t.toLowerCase());
    literature.push(t);
  }
  literature.length = Math.min(literature.length, 150);
  const language = LANGUAGE_NAMES[transcript.language] || transcript.language || "unknown";

  const lines = [
    `You are correcting an automatic speech recognition transcript of a university lecture in ${language}. Fix only recognition errors.`,
    "",
    "CONTEXT",
    `Title: ${String(transcript.title || "Untitled").trim()}`,
    `Language: ${language}`,
  ];
  if (transcript.durationSec != null) lines.push(`Duration: ${formatDuration(transcript.durationSec)}`);
  if (terms.length) {
    lines.push("Course terms (correct spellings of names and technical words, one per line):");
    lines.push(...terms);
  }
  if (literature.length) {
    lines.push("Terms from the course literature (correct spellings, use them to check names and technical words):");
    lines.push(...wrapTerms(literature));
  }
  lines.push(
    "",
    "RULES",
    "- Correct misheard words, names, technical terms, foreign words (English loanwords, Latin), place names and obvious garbled phrases.",
    ...(literature.length ? ["- Words that sound like a term from the course literature are probably that term; correct them, but only when the context fits."] : []),
    "- Do NOT change style, the grammar of spoken language, filler words, repetitions or word order. Do not improve the lecture.",
    `- Words marked ${MARK_OPEN}like this${MARK_CLOSE} were uncertain for the recognizer. Check them first, but they may be correct. Do not include the ${MARK_OPEN} ${MARK_CLOSE} marks in "find" or "replace".`,
    '- "find" must be an exact substring of that line\'s text (without the line id, the speaker name and the marks), as short as possible but unique within that line. Include a neighbouring word if needed.',
    "- If the same error appears in several lines, give one correction per line, each with its own id.",
    '- Use type "guess" when the correct word is not certain, or when you insert a word that seems to be missing. Use "fix" only when you are confident.',
    '- Use type "format" to write spoken years and numbers as digits where that clearly helps reading (years, percentages, dates), for example "zwanzig zweiundzwanzig" to "2022". Do not convert words like "eines" or "einer".',
    `- At most ${MAX_CORRECTIONS} corrections, most important first. If nothing needs fixing, return an empty list.`,
    '- Give a short reason for each correction.',
    '- Answer with ONLY one JSON code block of this form and nothing else:',
    '```json',
    '{"corrections":[{"id":"p12.s3","find":"Klauselitz","replace":"Clausewitz","type":"fix","reason":"name of the theorist"}]}',
    '```',
    "",
    "TRANSCRIPT",
    "One sentence per line: line id | speaker (only after a speaker change) | text",
  );

  let prevSpeaker = null;
  (transcript.paragraphs || []).forEach((p, pi) => {
    const speaker = p.speaker == null ? 0 : p.speaker;
    (p.sentences || []).forEach((s, si) => {
      const text = markedText(s);
      if (!text) return;
      const name = speaker !== prevSpeaker ? speakerName(transcript, speaker) : "";
      prevSpeaker = speaker;
      lines.push(`${sentenceId(pi, si)} | ${name} | ${text}`);
    });
  });
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Reading Claude's answer                                             */
/* ------------------------------------------------------------------ */

// End index (exclusive) of the JSON value that starts at `start`, or -1.
function findBalancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// A parsed value counts when it is {corrections:[...]} or an array of objects.
function pickList(value) {
  const list = Array.isArray(value) ? value : value && Array.isArray(value.corrections) ? value.corrections : null;
  if (!list) return null;
  return list.every((x) => x && typeof x === "object") ? list : null;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

// Raw JSON, JSON in fences, or JSON somewhere inside prose.
function extractList(text) {
  const whole = pickList(tryParse(text.trim()));
  if (whole) return whole;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const end = findBalancedEnd(text, i);
    if (end < 0) continue;
    const list = pickList(tryParse(text.slice(i, end)));
    if (list) return list;
  }
  return null;
}

export function parseAnswer(text) {
  const errors = [];
  const corrections = [];
  const list = extractList(String(text || ""));
  if (!list) {
    errors.push("No JSON with a corrections list was found in the answer. Paste Claude's whole reply.");
    return { corrections, errors };
  }

  const seen = new Set();
  list.forEach((item, i) => {
    const label = `Item ${i + 1}`;
    const m = /^p(\d+)\.s(\d+)$/i.exec(String(item.id || "").trim());
    if (!m) { errors.push(`${label}: missing or invalid line id.`); return; }
    const find = typeof item.find === "string" ? item.find.replace(MARKS, "") : "";
    if (!find.trim()) { errors.push(`${label} (${item.id}): "find" is empty.`); return; }
    if (typeof item.replace !== "string") { errors.push(`${label} (${item.id}): "replace" is not text.`); return; }
    const replace = item.replace.replace(MARKS, "");
    if (replace === find) { errors.push(`${label} (${item.id}): nothing to change.`); return; }

    let type = String(item.type || "fix").trim().toLowerCase();
    if (!TYPES.includes(type)) type = "guess"; // unknown type: treat as uncertain
    const correction = {
      id: `p${Number(m[1])}.s${Number(m[2])}`,
      find,
      replace,
      type,
      reason: typeof item.reason === "string" ? item.reason.trim() : "",
    };
    const key = JSON.stringify([correction.id, find, replace, type]);
    if (seen.has(key)) return;
    seen.add(key);
    corrections.push(correction);
  });
  return { corrections, errors };
}

/* ------------------------------------------------------------------ */
/* Applying corrections                                                */
/* ------------------------------------------------------------------ */

// Words for the new text: tokens that survive keep their word object (and confidence),
// changed or new tokens become { t, c: 1, fixed: true, s, e } with times interpolated between the kept
// neighbours. Alignment is a longest common subsequence.
function realignWords(oldWords, newText, bounds = {}) {
  const newTokens = tokenize(newText);
  const n = oldWords.length;
  const m = newTokens.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldWords[i].t === newTokens[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && oldWords[i].t === newTokens[j]) { out.push({ ...oldWords[i] }); i++; j++; }
    else if (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else { out.push({ t: newTokens[j], c: 1, fixed: true, _new: true }); j++; }
  }
  // Times: new tokens share the gap between the neighbouring kept tokens (or the sentence bounds) evenly.
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  for (let a = 0; a < out.length; ) {
    if (!out[a]._new) { a++; continue; }
    let b = a;
    while (b < out.length && out[b]._new) b++;
    const lo = a > 0 ? out[a - 1].e : bounds.start;
    let hi = b < out.length ? out[b].s : bounds.end;
    if (isNum(lo) && isNum(hi)) {
      if (hi < lo) hi = lo;
      const k = b - a;
      for (let x = 0; x < k; x++) {
        out[a + x].s = x === 0 ? lo : Math.round((lo + ((hi - lo) * x) / k) * 100) / 100;
        out[a + x].e = x === k - 1 ? hi : Math.round((lo + ((hi - lo) * (x + 1)) / k) * 100) / 100;
      }
    }
    a = b;
  }
  for (const w of out) delete w._new;
  return out;
}

function currentWords(sentence) {
  const tokens = tokenize(sentence.text);
  const words = Array.isArray(sentence.words) ? sentence.words : [];
  if (words.length === tokens.length && words.every((w, i) => w.t === tokens[i])) return words;
  return tokens.map((t) => ({ t, c: 1 })); // words missing or out of sync with the text
}

export function applyCorrections(transcript, corrections) {
  const next = clone(transcript);
  const original = transcript.originalParagraphs ? null : clone(transcript.paragraphs || []);
  const failed = [];
  let applied = 0;

  for (const correction of corrections || []) {
    const sentence = findSentence(next, correction.id);
    if (!sentence) { failed.push({ correction, reason: "line not found" }); continue; }
    const hit = locateText(sentence.text, correction.find);
    if (!hit) { failed.push({ correction, reason: "text not found" }); continue; }

    const oldWords = currentWords(sentence);
    const text = sentence.text.slice(0, hit.index) + correction.replace + sentence.text.slice(hit.index + hit.length);
    sentence.text = tokenize(text).join(" ");
    sentence.words = realignWords(oldWords, sentence.text, { start: sentence.start, end: sentence.end });

    if (!next.originalParagraphs && original) next.originalParagraphs = original;
    if (!Array.isArray(next.corrections)) next.corrections = [];
    next.corrections.push({ ...correction, appliedAt: new Date().toISOString() });
    applied++;
  }
  return { transcript: next, applied, failed };
}

export function revertCorrections(transcript) {
  const next = clone(transcript);
  if (next.originalParagraphs) next.paragraphs = next.originalParagraphs;
  delete next.originalParagraphs;
  delete next.corrections;
  return next;
}
