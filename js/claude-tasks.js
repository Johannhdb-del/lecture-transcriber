// More "copy and paste with Claude" tasks: summary, flashcards and glossary, translation.
// Same flow as correction.js: build a prompt, the student pastes it into a Claude chat,
// then pastes the answer back. Pure logic, no DOM. The transcript is never mutated.
import { formatDuration, formatTime, speakerName } from "./format.js";
import { sentenceId, findSentence } from "./correction.js";

const LANGUAGE_NAMES = {
  de: "German", en: "English", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese",
  nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian", tr: "Turkish", ar: "Arabic", zh: "Chinese",
};
const MAX_SENTENCES_PER_PART = 300;
const ID_RE = /^p(\d+)\.s(\d+)$/i;

const langName = (code) => LANGUAGE_NAMES[String(code || "").toLowerCase()] || String(code || "the same language");
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function contextLines(t) {
  const lines = [`Title: ${oneLine(t.title) || "Untitled"}`, `Language of the lecture: ${langName(t.language)}`];
  if (t.durationSec != null) lines.push(`Duration: ${formatDuration(t.durationSec)}`);
  const terms = (t.keyterms || []).map(oneLine).filter(Boolean);
  if (terms.length) {
    lines.push("Course terms (correct spellings of names and technical words):");
    lines.push(terms.join(", "));
  }
  return lines;
}

// Running text with a timestamp and speaker name at the start of each paragraph.
function transcriptBlock(t) {
  const out = [];
  let prev = null;
  (t.paragraphs || []).forEach((p) => {
    const text = (p.sentences || []).map((s) => oneLine(s.text)).filter(Boolean).join(" ");
    if (!text) return;
    const speaker = p.speaker == null ? 0 : p.speaker;
    const who = speaker !== prev ? ` ${speakerName(t, speaker)}:` : "";
    prev = speaker;
    out.push(`[${formatTime(p.start || 0)}]${who} ${text}`);
  });
  return out.join("\n\n");
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

// Parse, and as a second try remove trailing commas.
function parseLoose(s) {
  const v = tryParse(s);
  if (v !== undefined) return v;
  return tryParse(s.replace(/,\s*([}\]])/g, "$1"));
}

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

// First JSON value (raw, in fences, or inside prose) for which pick(value) returns something.
function extractJson(text, pick) {
  const whole = pick(parseLoose(text.trim()));
  if (whole) return whole;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const end = findBalancedEnd(text, i);
    if (end < 0) continue;
    const got = pick(parseLoose(text.slice(i, end)));
    if (got) return got;
  }
  return null;
}

const asList = (v, ...keys) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") for (const k of keys) if (Array.isArray(v[k])) return v[k];
  return null;
};

const str = (v) => (typeof v === "string" ? v.trim() : "");

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

const SUMMARY_HEADINGS = {
  de: ["Überblick", "Kernargumente", "Schlüsselbegriffe", "Namen und Daten", "Fragen zur Prüfungsvorbereitung"],
  en: ["Overview", "Key arguments", "Key terms", "Names and dates", "Questions for exam preparation"],
};

export function buildSummaryPrompt(t, { language = t.language } = {}) {
  const lang = langName(language);
  const h = SUMMARY_HEADINGS[language] || SUMMARY_HEADINGS.en;
  const lines = [
    `You are helping a university student prepare for exams. Below is the transcript of a lecture. Write study notes about it in ${lang}.`,
    "",
    "CONTEXT",
    ...contextLines(t),
    "",
    "RULES",
    "- Stay faithful to the lecture. Use only what the lecturer says. Do NOT add facts, dates, names, quotes or interpretations from outside the transcript, and do not invent anything.",
    "- If something is unclear or looks like a recognition error, leave it out or note the uncertainty briefly. Correct obvious misspellings of names and terms (use the course terms if given).",
    `- Write all notes in ${lang}, whatever the language of the transcript.`,
    "- Be concise and concrete. Prefer the lecturer's own concepts and examples over general statements.",
    "",
    "FORMAT",
    "Answer with ONLY one Markdown code block (start with ```markdown and end with ```), with no text before or after it and no other code fences inside. Inside, use exactly these five sections, in this order, with these exact headings:",
    "",
    `## ${h[0]}`,
    "5 to 8 sentences of plain prose: topic, line of argument, conclusion.",
    "",
    `## ${h[1]}`,
    "Bullet list (each line starts with \"- \"), 6 to 12 items, in the order of the lecture. One argument or claim per bullet, with its reasoning in one or two sentences.",
    "",
    `## ${h[2]}`,
    "Bullet list, one line per term in the form \"- **Term**: one line explanation\", as the lecturer uses the term.",
    "",
    `## ${h[3]}`,
    "Bullet list in the form \"- **Name or date**: who or what, and why it matters in this lecture\". Only names, places, dates and numbers that appear in the lecture.",
    "",
    `## ${h[4]}`,
    "Numbered list (\"1. \", \"2. \", ...), 8 to 12 open exam style questions that this lecture lets a student answer. Questions only, no answers.",
    "",
    "TRANSCRIPT",
    "Timestamps in square brackets mark the start of each paragraph. A speaker name appears when the speaker changes.",
    "",
    transcriptBlock(t),
  ];
  return lines.join("\n");
}

export function parseSummaryAnswer(text) {
  let s = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = s.split("\n");
  const isHeading = (l) => /^#{1,6}\s+\S/.test(l);
  const firstHeading = lines.findIndex(isHeading);

  // Unwrap a ```markdown fence that opens before the first heading.
  const open = lines.findIndex((l, i) => /^\s*```\s*(markdown|md)?\s*$/i.test(l) && (firstHeading < 0 || i < firstHeading));
  let body = lines;
  if (open >= 0) {
    let close = -1;
    for (let i = lines.length - 1; i > open; i--) {
      if (/^\s*```\s*$/.test(lines[i])) { close = i; break; }
    }
    body = lines.slice(open + 1, close > open ? close : lines.length);
  }

  // Drop chatty preamble before the first heading.
  const h = body.findIndex(isHeading);
  if (h > 0) body = body.slice(h);

  const md = body.join("\n").trim();
  if (!md) throw new Error("The answer is empty. Paste Claude's whole reply, including the headings.");
  return md;
}

/* ------------------------------------------------------------------ */
/* Flashcards and glossary                                             */
/* ------------------------------------------------------------------ */

export function buildStudyAidsPrompt(t, { language = t.language } = {}) {
  const lang = langName(language);
  const lines = [
    `You are helping a university student prepare for exams. Below is the transcript of a lecture. Create flashcards and a glossary about it in ${lang}.`,
    "",
    "CONTEXT",
    ...contextLines(t),
    "",
    "RULES",
    "- Stay faithful to the lecture. Use only what the lecturer says. Do NOT add facts, dates, names or definitions from outside the transcript, and do not invent anything.",
    "- Correct obvious speech recognition misspellings of names and terms (use the course terms if given). Skip anything unclear.",
    `- Write all questions, answers, terms and explanations in ${lang}.`,
    '- "cards": 10 to 20 flashcards. Each question must make sense on its own, without the lecture at hand. Mix definitions, causes and effects, comparisons, who/what/when and "why" questions. Each answer is one to three sentences.',
    '- "glossary": 8 to 25 key terms as the lecturer uses them, each with a one or two sentence explanation. Do not repeat the card questions.',
    "- Answer with ONLY one JSON code block of exactly this form and nothing before or after it:",
    "```json",
    '{"cards":[{"q":"Question?","a":"Answer."}],"glossary":[{"term":"Term","explanation":"Explanation."}]}',
    "```",
    "- The JSON must be valid: double quotes, no trailing commas, no comments, and quotation marks inside text escaped as \\\".",
    "",
    "TRANSCRIPT",
    "Timestamps in square brackets mark the start of each paragraph. A speaker name appears when the speaker changes.",
    "",
    transcriptBlock(t),
  ];
  return lines.join("\n");
}

export function parseStudyAidsAnswer(text) {
  const errors = [];
  const cards = [];
  const glossary = [];
  const data = extractJson(String(text || ""), (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const c = asList(v, "cards", "flashcards");
    const g = asList(v, "glossary", "terms");
    return c || g ? { c: c || [], g: g || [] } : null;
  });
  if (!data) {
    errors.push('No JSON with "cards" and "glossary" was found in the answer. Paste Claude\'s whole reply.');
    return { cards, glossary, errors };
  }

  const seenQ = new Set();
  data.c.forEach((item, i) => {
    const q = str(item && (item.q ?? item.question));
    const a = str(item && (item.a ?? item.answer));
    if (!q || !a) { errors.push(`Card ${i + 1}: question or answer is missing.`); return; }
    const key = q.toLowerCase();
    if (seenQ.has(key)) return;
    seenQ.add(key);
    cards.push({ q, a });
  });

  const seenT = new Set();
  data.g.forEach((item, i) => {
    const term = str(item && item.term);
    const explanation = str(item && (item.explanation ?? item.definition));
    if (!term || !explanation) { errors.push(`Glossary entry ${i + 1}: term or explanation is missing.`); return; }
    const key = term.toLowerCase();
    if (seenT.has(key)) return;
    seenT.add(key);
    glossary.push({ term, explanation });
  });

  if (!cards.length && !glossary.length) errors.push("The answer contained no usable cards or glossary entries.");
  return { cards, glossary, errors };
}

/* ------------------------------------------------------------------ */
/* Translation                                                         */
/* ------------------------------------------------------------------ */

export function buildTranslatePrompts(t, { targetLanguage } = {}) {
  const source = langName(t.language);
  const target = langName(targetLanguage);
  const terms = (t.keyterms || []).map(oneLine).filter(Boolean);

  const items = [];
  (t.paragraphs || []).forEach((p, pi) => {
    (p.sentences || []).forEach((s, si) => {
      const text = oneLine(s.text);
      if (text) items.push(`${sentenceId(pi, si)} | ${text}`);
    });
  });

  const n = Math.max(1, Math.ceil(items.length / MAX_SENTENCES_PER_PART));
  const prompts = [];
  for (let i = 0; i < n; i++) {
    const part = items.slice(i * MAX_SENTENCES_PER_PART, (i + 1) * MAX_SENTENCES_PER_PART);
    const first = part[0] ? part[0].split(" | ")[0] : "";
    const last = part.length ? part[part.length - 1].split(" | ")[0] : "";
    const lines = [
      `You are translating a university lecture transcript from ${source} into ${target}. This is part ${i + 1} of ${n}.`,
      "",
      "CONTEXT",
      `Title: ${oneLine(t.title) || "Untitled"}`,
      `Part ${i + 1} of ${n}: lines ${first} to ${last} (${part.length} lines)`,
    ];
    if (terms.length) lines.push("Course terms (keep names as they are; use the established translation for technical terms where one exists):", terms.join(", "));
    lines.push(
      "",
      "RULES",
      `- Translate every line into ${target}. Keep the meaning, the register of spoken language and the order. Do not summarize, shorten, explain, add or leave anything out.`,
      "- Translate only what is said. Do not add content that is not in the line.",
      "- Keep each line separate: do not merge, split or reorder lines. The id of a line never changes.",
      "- Return every id of this part exactly once, even for very short lines.",
      "- Answer with ONLY one JSON code block of this form and nothing before or after it:",
      "```json",
      '{"lines":[{"id":"p1.s1","text":"translated sentence"}]}',
      "```",
      "- The JSON must be valid: double quotes, no trailing commas, quotation marks inside text escaped as \\\".",
      "",
      `TRANSCRIPT (part ${i + 1} of ${n})`,
      "One sentence per line: line id | text",
      ...part,
    );
    prompts.push(lines.join("\n"));
  }
  return prompts;
}

export function parseTranslateAnswer(text) {
  const errors = [];
  const byId = new Map();
  const list = extractJson(String(text || ""), (v) => {
    const l = asList(v, "lines");
    return l && l.every((x) => x && typeof x === "object") ? l : null;
  });
  if (!list) {
    errors.push('No JSON with a "lines" list was found in the answer. Paste Claude\'s whole reply.');
    return { lines: [], errors };
  }
  list.forEach((item, i) => {
    const m = ID_RE.exec(String(item.id || "").trim());
    if (!m) { errors.push(`Item ${i + 1}: missing or invalid line id.`); return; }
    const t = typeof item.text === "string" ? oneLine(item.text) : "";
    const id = `p${Number(m[1])}.s${Number(m[2])}`;
    if (!t) { errors.push(`Item ${i + 1} (${id}): the translated text is empty.`); return; }
    byId.set(id, t); // a repeated id: the last one wins
  });
  return { lines: [...byId].map(([id, text]) => ({ id, text })), errors };
}

const idOrder = (id) => {
  const m = ID_RE.exec(id);
  return m ? [Number(m[1]), Number(m[2])] : [Infinity, Infinity];
};
const byIdOrder = (a, b) => {
  const [ap, as] = idOrder(a.id);
  const [bp, bs] = idOrder(b.id);
  return ap - bp || as - bs;
};

export function mergeTranslation(t, targetLanguage, lines) {
  const same = t.translation && t.translation.language === targetLanguage;
  const merged = new Map();
  if (same) for (const l of t.translation.lines || []) merged.set(l.id, l.text);
  for (const l of lines || []) {
    if (l && l.id && typeof l.text === "string" && findSentence(t, l.id)) merged.set(String(l.id).toLowerCase(), l.text);
  }
  const sorted = [...merged].map(([id, text]) => ({ id, text })).sort(byIdOrder);
  return { ...t, translation: { language: targetLanguage, lines: sorted } };
}

const lookupCache = new WeakMap();

export function translationFor(t, id) {
  const lines = t && t.translation && t.translation.lines;
  if (!Array.isArray(lines)) return null;
  let map = lookupCache.get(lines);
  if (!map) {
    map = new Map(lines.map((l) => [String(l.id).toLowerCase(), l.text]));
    lookupCache.set(lines, map);
  }
  const text = map.get(String(id || "").trim().toLowerCase());
  return typeof text === "string" && text ? text : null;
}
