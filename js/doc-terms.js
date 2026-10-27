// Course documents: read PDF / text files and pull out the key terms (names, acronyms, technical terms).
// Pure logic apart from the lazy pdf.js import, no DOM. Terms feed Deepgram keyterms and the correction prompt.

/* ------------------------------------------------------------------ */
/* pdf.js (loaded lazily from a CDN, pinned, legacy build for older Safari) */
/* ------------------------------------------------------------------ */

const PDFJS_VERSION = "4.10.38";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/`;
const PDFJS_URL = `${PDFJS_BASE}pdf.min.mjs`;
const PDFJS_WORKER_URL = `${PDFJS_BASE}pdf.worker.min.mjs`;

const MSG_TYPE = "Only PDF, .txt and .md files can be added.";
const MSG_NO_TEXT = "This PDF has no text layer (it is probably scanned), so no terms can be read from it.";
const MSG_PASSWORD = "This PDF is password protected, so no terms can be read from it.";
const MSG_LOAD = "The PDF reader could not be loaded. Check the internet connection and try again.";
const MSG_BROKEN = "This PDF could not be opened. The file may be damaged.";

const MAX_TERMS = 150;
const MAX_EMPHASIS_WORDS = 6;
const BOLD_RE = /bold|black|heavy|semibold|demi/i;

let pdfjsPromise = null;

// Cached import promise; reset on failure so a retry works.
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL)
      .then((mod) => {
        const lib = mod && mod.getDocument ? mod : mod && mod.default;
        if (!lib || !lib.getDocument) throw new Error("pdf.js has no getDocument");
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return lib;
      })
      .catch(() => {
        pdfjsPromise = null;
        throw new Error(MSG_LOAD);
      });
  }
  return pdfjsPromise;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const isWordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);
const wordCount = (s) => String(s || "").split(/\s+/).filter(Boolean).length;
const round3 = (n) => Math.round(n * 1000) / 1000;
const setOf = (s) => new Set(s.split(/\s+/).filter(Boolean));

// Whole word, case sensitive occurrences of needle in hay.
function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return n;
    if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + needle.length])) n++;
    from = i + needle.length;
  }
}

// Line key that ignores digits, so "Seite 3" and "Seite 4" count as the same running header.
const lineKey = (line) => line.toLowerCase().replace(/\d+/g, "#").trim();
const PAGE_NUMBER_RE = /^(?:page|seite|s\.)?\s*\d{1,4}(?:\s*(?:of|von|\/)\s*\d{1,4})?$/i;

/* ------------------------------------------------------------------ */
/* Word lists                                                          */
/* ------------------------------------------------------------------ */

const STOP = setOf(
  // German
  "der die das den dem des ein eine einer eines einem einen und oder aber auch dann denn doch noch nur schon ja nein " +
  "also mal eben halt so wie wo was wer wen wem wessen welche welcher welches welchen welchem ich du er sie es wir ihr " +
  "mich dich ihn uns euch ihnen mir dir ihm ihre ihrer ihrem ihren ihres sein seine seiner seinem seinen seines mein " +
  "meine unser unsere euer dein deine man sich selbst in im an am auf aus bei mit von vom vor zu zum zur zwischen " +
  "durch für gegen ohne um über unter nach seit bis während wegen trotz statt innerhalb außerhalb entlang gegenüber " +
  "neben hinter dass daß ob wenn weil da obwohl damit sodass sowie sowohl weder entweder jedoch sondern dennoch " +
  "deshalb daher darum dadurch dabei dafür dagegen dazu davon hier dort dies diese dieser dieses diesem diesen jene " +
  "jener jenes nicht kein keine keiner keinen keinem nichts nie immer oft manchmal bereits jetzt nun heute damals " +
  "wieder weiter sehr mehr weniger viel viele vielen wenig wenige ganz fast etwa ca circa nämlich zudem außerdem " +
  "ebenfalls ebenso zwar bzw usw etc ggf vgl alle allen aller alles jede jeder jedes jeden andere anderen anderer " +
  "anderes beide beiden einige einigen manche mancher solche solchen " +
  // English
  "the a an and or but if of to in on at by for with from as into onto over under about against between through " +
  "during before after above below up down out off again further then once here there when where why how all any " +
  "both each few more most other some such no nor not only own same so than too very just now it its he she they we " +
  "you i me him her them us my your his their our this that these those who whom which what whose also however " +
  "therefore thus hence yet still even while although though because since until unless whether either neither per " +
  "via among within without upon toward towards across along around behind beside beyond despite except like near"
);

// Auxiliary and modal verbs: a phrase that contains one is a sentence fragment, not a term.
const VERBS = setOf(
  "ist sind war waren wäre wären sei seien bin bist seid wird werden wurde wurden worden geworden würde würden hat " +
  "haben hatte hatten hätte hätten kann können konnte konnten könnte könnten muss müssen musste mussten soll sollen " +
  "sollte sollten darf dürfen durfte will wollen wollte wollten mag möchte gibt gab geht ging steht stand zeigt " +
  "zeigen bleibt blieb macht machen lässt lassen sagt " +
  "is are was were be been being am has have had having do does did can could may might must shall should will would"
);

// Very common nouns and adjectives (plus section words) that are never useful as terms.
const COMMON = setOf(
  "jahr jahre jahren zeit zeiten teil teile teilen beispiel beispiele frage fragen punkt punkte punkten seite seiten " +
  "kapitel abbildung abbildungen tabelle tabellen text texte autor autoren autorin zusammenfassung literatur sitzung " +
  "vorlesung prüfung thema themen inhalt inhalte überblick ergebnis ergebnisse bedeutung rolle grund gründe fall " +
  "fälle art weise form formen ende anfang beginn einleitung fazit hinweis hinweise definition merke wichtig wichtige " +
  "wichtiger wichtiges zentral zentrale zentraler ziel ziele ansatz ansätze möglichkeit möglichkeiten entwicklung " +
  "veränderung unterschied unterschiede mensch menschen leute problem probleme ebene bereich bereiche ding dinge " +
  "sache sachen verhältnis zusammenhang beziehung rahmen lage situation fokus kritik zahl zahlen tag tage woche " +
  "monat quelle quellen anmerkung achtung tipp antwort abstract kernpunkte schluss gesamt weitere weiterer weiteres " +
  "erste erster erstes zweite zweiter zweites dritte dritter drittes neue neuer neues neuen große großer großes " +
  "kleine kleiner kleines gute guter gutes hohe hoher hohes mögliche möglicher einzelne einzelnen verschiedene " +
  "verschiedenen unterschiedliche unterschiedlichen zentralen wesentliche wesentlichen " +
  "summary chapter chapters author authors figure figures table tables page pages session lecture exam overview " +
  "introduction conclusion example examples question questions point points key time year years part parts way " +
  "ways form case cases role reason end beginning start result results meaning importance topic topics content " +
  "contents text texts literature reading readings thing things remember note notes number numbers problem " +
  "problems issue issues people world work important main new first second third other another"
);

// Section headings and boxes that repeat in generated summaries.
const BOILERPLATE = new Set([
  "key points", "key point", "ten things to remember", "things to remember", "10 things to remember",
  "key terms", "key takeaways", "table of contents", "contents", "references", "bibliography", "glossary",
  "glossar", "inhalt", "inhaltsverzeichnis", "literaturverzeichnis", "zusammenfassung", "kernpunkte",
  "wichtige punkte", "zehn dinge zum merken", "fazit", "überblick", "einleitung", "summary", "overview",
  "introduction", "conclusion"
]);

const DETERMINERS = setOf("der die das den dem des ein eine einer eines einem einen the a an");
const TITLES = setOf(
  "herr frau dr prof general oberst präsident kanzler minister admiral generalmajor oberstleutnant major hauptmann " +
  "leutnant mr mrs ms president gen col sir lord"
);
// Inside a capitalised word sequence: names ("Carl von Clausewitz") and genitive phrases ("Kampf der Kulturen").
const NAME_PARTICLES = setOf("von vom van de al bin ibn la le el da di dos");
const PHRASE_PARTICLES = setOf("der des of");
// Abbreviations whose full stop does not end a sentence.
const ABBREVIATIONS = setOf(
  "vgl z b bzw ca usw etc ggf sog bspw inkl evtl zb dr prof st nr abb tab kap hrsg ebd u a d h s o i e g cf eg ie"
);
const ACRONYM_STOP = setOf("PDF DOCX ISBN URL TAB ABB KAP VGL SEITE INHALT TEIL ID OK");

const GENERIC_SUFFIX = /(ung|ungen|keit|heit|schaft|tion|tionen|ität|ismus|ment|ments)$/i;

/* ------------------------------------------------------------------ */
/* Reading documents                                                   */
/* ------------------------------------------------------------------ */

/**
 * Reads a File (PDF, .txt, .md). Returns { name, kind, pages, text, emphasis }.
 * Throws an Error with a friendly message when the file cannot be used.
 */
export async function readDocument(file, { onProgress } = {}) {
  const name = String((file && file.name) || "document");
  const lower = name.toLowerCase();
  const type = String((file && file.type) || "").toLowerCase();
  if (type === "application/pdf" || lower.endsWith(".pdf")) return readPdf(file, name, onProgress);
  if (/\.(txt|md|markdown)$/.test(lower)) return readTextFile(file, name, /\.(md|markdown)$/.test(lower), onProgress);
  throw new Error(MSG_TYPE);
}

async function readTextFile(file, name, isMarkdown, onProgress) {
  let raw = await file.text();
  raw = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let emphasis = [];
  let text = raw;
  if (isMarkdown) {
    const found = [];
    for (const m of raw.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) found.push([m.index, m[1]]);
    for (const m of raw.matchAll(/\*\*([^*\n]+?)\*\*/g)) found.push([m.index, m[1]]);
    for (const m of raw.matchAll(/__([^_\n]+?)__/g)) found.push([m.index, m[1]]);
    found.sort((a, b) => a[0] - b[0]);
    emphasis = uniqueInOrder(found.map((f) => cleanEmphasis(f[1])));
    // Plain text: drop the markup but keep the words and the line structure.
    text = raw
      .replace(/^#{1,6}[ \t]+/gm, "")
      .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
      .replace(/\*\*|__|`/g, "");
  }
  if (onProgress) onProgress(1);
  return { name, kind: "text", pages: 1, text, emphasis };
}

// Short phrase (1 to 6 words) from a bold run or heading, or "" when unusable.
function cleanEmphasis(s) {
  let t = String(s || "")
    .replace(/[­​]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^(?:[•·▪◦●○■□*>\-–—]\s*)+/, "").replace(/^\(?\d{1,2}(?:\.\d{1,2})*[.)]?\s+/, "");
  t = t.replace(/^[\s"'„“”‚‘’»«(\[]+|[\s"'„“”‚‘’»«)\]:;,.!?]+$/g, "");
  if (!/\p{L}/u.test(t) || t.length > 60) return "";
  const n = wordCount(t);
  return n >= 1 && n <= MAX_EMPHASIS_WORDS ? t : "";
}

function uniqueInOrder(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function readPdf(file, name, onProgress) {
  const pdfjs = await loadPdfJs();
  let pdf;
  try {
    const data = await file.arrayBuffer();
    pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    if (err && err.name === "PasswordException") throw new Error(MSG_PASSWORD);
    throw new Error(MSG_BROKEN);
  }
  try {
    const fontBold = new Map();
    const pageLines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // Loading the operator list makes pdf.js resolve the real font names (e.g. "Calibri-Bold").
      try {
        await page.getOperatorList();
      } catch {
        /* bold detection then falls back to size heuristics */
      }
      pageLines.push(buildLines(page, content, fontBold));
      try {
        page.cleanup();
      } catch {
        /* ignore */
      }
      if (onProgress) onProgress(p / pdf.numPages);
    }
    return finishPdf(name, pdf.numPages, pageLines);
  } finally {
    try {
      await pdf.destroy();
    } catch {
      /* ignore */
    }
  }
}

// Is this font bold? Looks at the real font name, pdf.js flags and the CSS family. Cached per font.
function isBoldFont(page, fontName, styles, cache) {
  const cached = cache.get(fontName);
  if (cached !== undefined) return cached;
  const family = String((styles && styles[fontName] && styles[fontName].fontFamily) || "");
  let real = "";
  let flag = false;
  let known = false;
  try {
    if (page.commonObjs.has(fontName)) {
      const f = page.commonObjs.get(fontName);
      real = String((f && f.name) || "");
      flag = !!(f && (f.bold || f.black));
      known = true;
    }
  } catch {
    /* font not resolved yet */
  }
  const bold = flag || BOLD_RE.test(real) || BOLD_RE.test(family);
  if (known || BOLD_RE.test(family)) cache.set(fontName, bold);
  return bold;
}

// Text items of one page -> lines { text, size, chars, boldChars, segs }, grouped by y position.
function buildLines(page, content, fontBold) {
  const lines = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    // Dominant size by character count.
    let best = 0;
    let bestN = -1;
    for (const [size, n] of cur.sizes) {
      if (n > bestN) {
        best = size;
        bestN = n;
      }
    }
    const text = cur.segs.map((s) => s.str).join("").replace(/\s+/g, " ").trim();
    if (text) lines.push({ text, size: best, chars: cur.chars, boldChars: cur.boldChars, segs: cur.segs });
    cur = null;
  };
  for (const it of content.items || []) {
    if (typeof it.str !== "string" || !it.transform) continue;
    const size = Math.hypot(it.transform[2], it.transform[3]) || Math.abs(it.transform[3]) || 0;
    const x = it.transform[4];
    const y = it.transform[5];
    if (it.str === "") {
      if (it.hasEOL) flush();
      continue;
    }
    if (cur && Math.abs(y - cur.y) > Math.max(1.5, 0.45 * Math.min(size, cur.lastSize))) flush();
    if (!cur) cur = { y, endX: null, lastSize: size, segs: [], sizes: new Map(), chars: 0, boldChars: 0 };
    const bold = isBoldFont(page, it.fontName, content.styles, fontBold);
    // pdf.js often omits the space between words; add one when there is a visible gap.
    if (cur.endX !== null && x - cur.endX > size * 0.2) {
      const prevStr = cur.segs.length ? cur.segs[cur.segs.length - 1].str : "";
      if (!/\s$/.test(prevStr) && !/^\s/.test(it.str)) cur.segs.push({ str: " ", bold: false });
    }
    cur.segs.push({ str: it.str, bold });
    const nonSpace = it.str.replace(/\s/g, "").length;
    cur.chars += nonSpace;
    if (bold) cur.boldChars += nonSpace;
    const key = Math.round(size * 2) / 2;
    cur.sizes.set(key, (cur.sizes.get(key) || 0) + nonSpace);
    cur.endX = x + (Number(it.width) || 0);
    cur.lastSize = size;
    cur.y = y;
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}

// Bold runs of a line as phrases (whitespace between bold pieces stays inside the run).
function boldRuns(segs) {
  const runs = [];
  let cur = "";
  for (const s of segs) {
    if (s.bold) cur += s.str;
    else if (!s.str.trim()) {
      if (cur) cur += s.str;
    } else {
      if (cur.trim()) runs.push(cur);
      cur = "";
    }
  }
  if (cur.trim()) runs.push(cur);
  return runs;
}

// Joins lines; "Kriegs-" + "führung" -> "Kriegsführung" only when the next line starts lowercase.
function joinLines(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && /\p{L}-$/u.test(prev) && /^\p{Ll}/u.test(line)) {
      const first = (line.match(/^[\p{L}]+/u) || [""])[0].toLowerCase();
      // "Ost- und Westeuropa" keeps its hyphen.
      if (!STOP.has(first)) {
        out[out.length - 1] = prev.slice(0, -1) + line;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

function finishPdf(name, pages, pageLines) {
  // Drop page numbers (first and last lines) and running headers (same line on most pages).
  const seen = new Map();
  for (const lines of pageLines) {
    for (const k of new Set(lines.filter((l) => l.text.length <= 80).map((l) => lineKey(l.text)))) {
      seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
  const repeatMin = Math.max(3, Math.ceil(pages * 0.6));
  const cleaned = pageLines.map((lines) =>
    lines.filter((l, i) => {
      const edge = i < 2 || i >= lines.length - 2;
      if (edge && PAGE_NUMBER_RE.test(l.text)) return false;
      if (pages >= 3 && l.text.length <= 80 && (seen.get(lineKey(l.text)) || 0) >= repeatMin) return false;
      return true;
    })
  );

  const text = cleaned.map((lines) => joinLines(lines.map((l) => l.text)).join("\n")).join("\n\n");
  if (text.replace(/\s/g, "").length < 20 * pages) throw new Error(MSG_NO_TEXT);

  // Body size = most common font size by character count.
  const sizeChars = new Map();
  for (const lines of cleaned) {
    for (const l of lines) sizeChars.set(l.size, (sizeChars.get(l.size) || 0) + l.chars);
  }
  let body = 0;
  let bodyN = -1;
  for (const [size, n] of sizeChars) {
    if (n > bodyN || (n === bodyN && size > body)) {
      body = size;
      bodyN = n;
    }
  }

  const found = [];
  for (const lines of cleaned) {
    for (const l of lines) {
      const words = wordCount(l.text);
      const big = body > 0 && l.size >= body * 1.15 && l.size - body >= 1;
      const allBold = l.chars > 0 && l.boldChars >= l.chars * 0.95;
      if ((big || allBold) && words <= 8) found.push(cleanEmphasis(l.text));
      else for (const run of boldRuns(l.segs)) found.push(cleanEmphasis(run));
    }
  }
  return { name, kind: "pdf", pages, text, emphasis: uniqueInOrder(found) };
}

/* ------------------------------------------------------------------ */
/* Term extraction                                                     */
/* ------------------------------------------------------------------ */

// Signal weights: how strongly a way of finding a term suggests that it is a real key term.
const W = {
  emphasis: 3, // bold or heading
  definition: 2.8, // "Term: explanation" at line start
  acronym: 2,
  nameParticle: 2.2, // "Carl von Clausewitz"
  surname: 2,
  titled: 1.8, // "General Gerassimow"
  mixed: 1.4, // "Nova-3", "COVID-19"
  seq: 1.6, // capitalised words in mid sentence
  seqParticle: 1.2, // "Kampf der Kulturen"
  enName: 1.3, // English capitalised word, not at sentence start
  seqStart: 1,
  hyphen: 1.2, // "Cyber-Angriff"
  long: 1
};

const ACRONYM_RE = /^[A-ZÄÖÜ][A-ZÄÖÜ0-9]{1,5}$/;
const ACRONYM_SLASH_RE = /^[A-Z][A-Z0-9]{0,3}\/[A-Z0-9]{2,4}$/;
const ROMAN_RE = /^[IVXLCDM]+$/;
const TOKEN_RE = /[\p{L}\p{N}]+(?:[-\/'’][\p{L}\p{N}]+)*/gu;

/**
 * Returns a cleaned term, or "" when it is not usable: trims punctuation, strips leading articles and
 * prepositions, rejects sentence fragments, boilerplate and common words, max 5 words / 40 characters.
 */
function cleanTerm(raw) {
  let s = String(raw || "").replace(/[­​]/g, "");
  s = s.replace(/^[\s"'„“”‚‘’»«()\[\]{}•·▪◦●○■□*>\-–—:;,.!?]+/, "");
  s = s.replace(/^\(?\d{1,2}(?:\.\d{1,2})*[.)]?\s+/, "");
  s = s.replace(/[\s"'„“”‚‘’»«()\[\]{}*:;,.!?\-–—]+$/, "").replace(/\s+/g, " ");
  if (!s || /https?:|www\.|@/i.test(s)) return "";
  let words = s.split(" ");
  while (words.length > 1 && (DETERMINERS.has(words[0].toLowerCase()) || STOP.has(words[0].toLowerCase()))) words.shift();
  if (words.length > 5) return "";
  const lows = words.map((w) => w.toLowerCase());
  if (lows.some((w) => VERBS.has(w))) return "";
  if (STOP.has(lows[lows.length - 1])) return "";
  if (words.some((w) => !/[\p{L}\p{N}]/u.test(w))) return "";
  if (!words.some((w) => /\p{L}/u.test(w))) return "";
  if (lows.every((w) => STOP.has(w) || COMMON.has(w))) return "";
  const term = words.join(" ");
  if (term.length < 2 || term.length > 40) return "";
  if (/^[\d\s.,]+$/.test(term)) return "";
  if (BOILERPLATE.has(term.toLowerCase())) return "";
  if (words.length === 1 && (ROMAN_RE.test(term) || ACRONYM_STOP.has(term))) return "";
  return term;
}

// Lines without page numbers, boilerplate headings and running headers.
function prepareLines(doc) {
  const raw = String(doc.text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim());
  const pages = Math.max(1, Number(doc.pages) || 1);
  const freq = new Map();
  for (const l of raw) if (l && l.length <= 80) freq.set(lineKey(l), (freq.get(lineKey(l)) || 0) + 1);
  const repeatMin = Math.max(4, Math.ceil(pages * 0.6));
  return raw.map((l) => {
    if (!l || PAGE_NUMBER_RE.test(l)) return "";
    if (BOILERPLATE.has(l.toLowerCase().replace(/[\s:]+$/, ""))) return "";
    if (pages >= 3 && l.length <= 80 && freq.get(lineKey(l)) >= repeatMin) return "";
    return l;
  });
}

// Joins wrapped lines (lines that reach the right margin without ending a sentence) into paragraphs.
function reflow(lines) {
  const lens = lines.filter(Boolean).map((l) => l.length).sort((a, b) => a - b);
  const p90 = lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.9))] : 0;
  const wrapLen = p90 >= 40 ? p90 * 0.8 : Infinity;
  const paras = [];
  let cur = "";
  for (const line of lines) {
    if (!line) {
      if (cur) paras.push(cur);
      cur = "";
      continue;
    }
    cur = cur ? `${cur} ${line}` : line;
    if (!(line.length >= wrapLen && !/[.!?:;]$/.test(line))) {
      paras.push(cur);
      cur = "";
    }
  }
  if (cur) paras.push(cur);
  return paras;
}

// Tokens of a paragraph with sentence start flags. Pure numbers do not change the start state.
function tokenize(par) {
  const out = [];
  const re = new RegExp(TOKEN_RE.source, "gu");
  let m;
  let prevEnd = 0;
  let prev = null;
  let atStart = true;
  while ((m = re.exec(par))) {
    const sep = par.slice(prevEnd, m.index);
    if (prev && (/[!?…]/.test(sep) || /[.:;]\s/.test(sep)) && !ABBREVIATIONS.has(prev.lower)) atStart = true;
    const rawTok = m[0];
    const skip = rawTok.includes("/") && !ACRONYM_SLASH_RE.test(rawTok);
    const t = rawTok.replace(/['’]s$/, "");
    const tok = { t, lower: t.toLowerCase(), start: atStart, sep, num: /^\d+$/.test(t), skip };
    out.push(tok);
    if (!tok.num) atStart = false;
    prev = tok;
    prevEnd = m.index + rawTok.length;
  }
  return out;
}

const isAcronymTok = (t) => ACRONYM_RE.test(t) || ACRONYM_SLASH_RE.test(t);
const isCapTok = (tok) => !tok.skip && /^\p{Lu}/u.test(tok.t) && tok.t.length >= 2 && (/\p{Ll}/u.test(tok.t) || isAcronymTok(tok.t));

// "Dr. Müller": the full stop after a title does not break a sequence.
function sepOk(prev, sep) {
  return /^\s+$/.test(sep) || (TITLES.has(prev.lower) && /^\.\s+$/.test(sep));
}

/**
 * Key terms of a document, best first (at most 150).
 * doc = result of readDocument. Returns [{ term, score, count, kind: "name"|"acronym"|"term"|"phrase" }].
 */
export function extractTerms(doc, { language = "de" } = {}) {
  const de = /^de/i.test(String(language));
  const lines = prepareLines(doc || {});
  const paras = reflow(lines);
  const flat = paras.join(" ");
  const parsed = paras.map(tokenize);

  // Candidates by lowercase key. Each signal keeps its own count; `total` counts cover every occurrence,
  // the others only standalone occurrences, which matters when a longer phrase swallows a shorter term.
  const cands = new Map();
  const add = (raw, sig, weight, kind, n, total) => {
    const term = cleanTerm(raw);
    if (!term || n <= 0) return;
    const key = term.toLowerCase();
    let c = cands.get(key);
    if (!c) {
      c = { forms: new Map(), weight: 0, kind, signals: new Map(), words: key.split(" ") };
      cands.set(key, c);
    }
    c.forms.set(term, (c.forms.get(term) || 0) + n);
    const s = c.signals.get(sig) || { n: 0, total };
    s.n += n;
    c.signals.set(sig, s);
    if (weight > c.weight) {
      c.weight = weight;
      c.kind = kind;
    }
  };

  // First pass: token frequencies and spellings, used to tell nouns from names and adjectives.
  const tokFreq = new Map();
  const lowerSeen = new Set();
  const midCap = new Set();
  for (const toks of parsed) {
    for (const tok of toks) {
      if (tok.skip) continue;
      tokFreq.set(tok.t, (tokFreq.get(tok.t) || 0) + 1);
      if (/^\p{Ll}/u.test(tok.t)) lowerSeen.add(tok.lower);
      else if (!tok.start && isCapTok(tok)) midCap.add(tok.t);
    }
  }

  // Emphasis (bold, headings) and "Term: explanation" line starts.
  for (const phrase of (doc && doc.emphasis ? doc.emphasis : []).slice(0, 500)) {
    // "Carl von Clausewitz: Vom Kriege" is a heading with two terms.
    for (const part of String(phrase).split(/\s*:\s+|\s+[–—-]\s+/)) {
      const term = cleanTerm(part);
      // A title like "Vom Kriege" must not turn into the plain word "Kriege".
      if (term && wordCount(term) === 1 && wordCount(part.trim()) > 1) continue;
      if (term) add(term, "emphasis", W.emphasis, wordCount(term) > 1 ? "phrase" : "term", Math.max(1, countOccurrences(flat, term)), true);
    }
  }
  const defRe = /^\s*(?:(?:[•·▪◦●○■□*>\-–—]\s+|\(?\d{1,2}(?:\.\d{1,2})*[.)]?\s+)+)?([^:\n]{2,60}?):\s+\S/u;
  for (const line of lines) {
    const m = defRe.exec(line);
    if (!m || !/^[\p{L}]/u.test(m[1].replace(/^["„“'‚»«(]+/, ""))) continue;
    const term = cleanTerm(m[1]);
    if (term) add(term, "definition", W.definition, wordCount(term) > 1 ? "phrase" : "term", Math.max(1, countOccurrences(flat, term)), true);
  }

  const surnames = new Set();
  const longCounts = new Map();

  for (let p = 0; p < paras.length; p++) {
    const toks = parsed[p];
    const letters = paras[p].replace(/[^\p{L}]/gu, "");
    const upper = letters.replace(/[^\p{Lu}]/gu, "");
    // Shouting headings carry no capitalisation signal.
    if (letters.length > 8 && upper.length / letters.length > 0.7) continue;

    // Single word signals.
    for (const tok of toks) {
      if (tok.skip || tok.num) continue;
      const t = tok.t;
      if (isAcronymTok(t)) {
        if (!ROMAN_RE.test(t) && !ACRONYM_STOP.has(t)) add(t, "acronym", W.acronym, "acronym", 1, true);
      } else if (/^\p{L}+-?\d+[\p{L}\d]*$/u.test(t)) {
        add(t, "mixed", W.mixed, "term", 1, true);
      } else if (/^\p{L}{2,}(?:-\p{L}{2,})+$/u.test(t)) {
        const parts = tok.lower.split("-");
        if ((de ? /^\p{Lu}/u.test(t) : t.length >= 7) && !parts.some((x) => STOP.has(x) || VERBS.has(x))) {
          add(t, "hyphen", W.hyphen, "term", 1, true);
        }
      } else if (de ? /^\p{Lu}\p{Ll}{8,}$/u.test(t) : /^\p{L}{10,}$/u.test(t) && t !== t.toUpperCase()) {
        // Long, probably rare word. In German only nouns that are not just a capitalised sentence start.
        const ok = de ? !lowerSeen.has(tok.lower) && (midCap.has(t) || !tok.start) : true;
        if (ok) longCounts.set(t, (longCounts.get(t) || 0) + 1);
      }
    }

    // Capitalised word sequences: names and multi word terms.
    for (let i = 0; i < toks.length; i++) {
      if (!isCapTok(toks[i])) continue;
      let j = i;
      const words = [toks[i].t];
      let caps = 1;
      let particle = "";
      while (j + 1 < toks.length && sepOk(toks[j], toks[j + 1].sep)) {
        const next = toks[j + 1];
        if (isCapTok(next)) {
          words.push(next.t);
          caps++;
          j++;
        } else if (
          (NAME_PARTICLES.has(next.lower) || PHRASE_PARTICLES.has(next.lower)) &&
          j + 2 < toks.length &&
          isCapTok(toks[j + 2]) &&
          sepOk(next, toks[j + 2].sep)
        ) {
          if (NAME_PARTICLES.has(next.lower)) particle = "name";
          else if (!particle) particle = "phrase";
          words.push(next.t, toks[j + 2].t);
          caps++;
          j += 2;
        } else break;
      }
      const startFlag = toks[i].start;
      i = j;
      if (caps > 4) continue; // lists and headings, not a term

      let lead = 0;
      let titled = false;
      while (lead < words.length - 1 && (STOP.has(words[lead].toLowerCase()) || TITLES.has(words[lead].toLowerCase()))) {
        if (TITLES.has(words[lead].toLowerCase())) titled = true;
        lead++;
      }
      const kept = words.slice(lead);
      while (kept.length > 1 && STOP.has(kept[kept.length - 1].toLowerCase())) kept.pop();
      // "Widerstandsfähigkeit von Staat" is a German noun phrase, not a name: name parts are short and not abstract nouns.
      if (particle === "name" && de && kept.some((w) => !NAME_PARTICLES.has(w.toLowerCase()) && (w.length > 12 || GENERIC_SUFFIX.test(w)))) continue;
      if (kept.length >= 2) {
        const term = kept.join(" ");
        if (particle === "name") {
          add(term, "seq", W.nameParticle, "name", 1, false);
          surnames.add(kept[kept.length - 1]);
        } else if (particle === "phrase") add(term, "seq", W.seqParticle, "phrase", 1, false);
        else if (startFlag && lead === 0) add(term, "seq", W.seqStart, "phrase", 1, false);
        else add(term, "seq", W.seq, "phrase", 1, false);
      } else if (kept.length === 1) {
        if (titled) add(kept[0], "titled", W.titled, "name", 1, false);
        else if (!de && !startFlag && lead === 0 && !lowerSeen.has(kept[0].toLowerCase())) add(kept[0], "enName", W.enName, "name", 1, false);
      }
    }
  }

  // Long words: rare compounds need two occurrences unless they are very long.
  for (const [t, n] of longCounts) {
    if (n < (de && t.length >= 12 ? 1 : 2)) continue;
    const weight = (GENERIC_SUFFIX.test(t) ? 0.6 : W.long) + (t.length >= 12 ? 0.3 : 0);
    add(t, "long", weight, "term", n, true);
  }
  // Surnames of "Carl von Clausewitz" style names also count when they appear alone.
  for (const s of surnames) add(s, "surname", W.surname, "name", tokFreq.get(s) || 0, true);

  // Longer phrases win: a single word loses the occurrences that sit inside a longer candidate.
  const multiCount = (c) => {
    let best = 0;
    for (const s of c.signals.values()) if (s.n > best) best = s.n;
    return best;
  };
  const byWord = new Map();
  for (const c of cands.values()) {
    if (c.words.length < 2) continue;
    c.count = multiCount(c);
    for (const w of new Set(c.words)) {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(c);
    }
  }
  const out = [];
  for (const c of cands.values()) {
    let count;
    if (c.words.length >= 2) count = c.count;
    else {
      const inside = (byWord.get(c.words[0]) || []).reduce((sum, m) => sum + m.count, 0);
      count = 0;
      // Bold and defined terms were marked as key terms by the author, so they keep all their occurrences.
      for (const [sig, s] of c.signals) {
        const marked = sig === "emphasis" || sig === "definition";
        count = Math.max(count, s.total && !marked ? s.n - inside : s.n);
      }
    }
    if (count <= 0) continue;
    let term = "";
    let best = -1;
    for (const [form, n] of c.forms) {
      if (n > best || (n === best && form < term)) {
        term = form;
        best = n;
      }
    }
    const bonus = Math.min(1, 0.4 * (c.signals.size - 1));
    let kind = c.kind;
    if (isAcronymTok(term)) kind = "acronym";
    else if (c.words.length > 1) kind = kind === "name" || c.words.some((w) => NAME_PARTICLES.has(w)) ? "name" : "phrase";
    else if (kind === "phrase") kind = "term";
    out.push({ term, score: round3(c.weight * Math.log(1 + count) + bonus), count, kind });
  }
  out.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  return out.slice(0, MAX_TERMS);
}

/* ------------------------------------------------------------------ */
/* Merging several documents                                           */
/* ------------------------------------------------------------------ */

/**
 * Merges the term lists of several documents. A term that is off in any document is dropped, spellings
 * are merged case insensitively (most frequent spelling wins), scores add up, best first.
 */
export function mergeTerms(docs, { limit = Infinity } = {}) {
  const off = new Set();
  for (const d of docs || []) {
    for (const t of (d && d.terms) || []) if (t && t.off) off.add(String(t.term).toLowerCase());
  }
  const map = new Map();
  for (const d of docs || []) {
    for (const t of (d && d.terms) || []) {
      if (!t || t.off || !t.term) continue;
      const key = String(t.term).toLowerCase();
      if (off.has(key)) continue;
      const score = Number(t.score) || 0;
      const count = Number(t.count) || 0;
      let e = map.get(key);
      if (!e) {
        e = { forms: new Map(), score: 0, count: 0, kind: t.kind, top: -Infinity };
        map.set(key, e);
      }
      e.forms.set(t.term, (e.forms.get(t.term) || 0) + Math.max(1, count));
      e.score += score;
      e.count += count;
      if (score > e.top) {
        e.top = score;
        e.kind = t.kind;
      }
    }
  }
  const out = [];
  for (const e of map.values()) {
    let term = "";
    let best = -1;
    for (const [form, n] of e.forms) {
      if (n > best || (n === best && form < term)) {
        term = form;
        best = n;
      }
    }
    out.push({ term, score: round3(e.score), count: e.count, kind: e.kind });
  }
  out.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  return Number.isFinite(limit) ? out.slice(0, Math.max(0, limit)) : out;
}
