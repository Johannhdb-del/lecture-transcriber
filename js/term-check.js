// "Term check": finds words in a transcript that look like misheard course terms and suggests corrections.
// Pure logic, no DOM. The result is shaped like the corrections of correction.js, so it can go straight into
// the review list and applyCorrections. Precision matters more than recall: when in doubt, stay silent.
import { sentenceId, locateText } from "./correction.js";

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const MAX_CORRECTIONS = 200;
const LOW_CONFIDENCE = 0.6;   // below: the recognizer was unsure, the bar is one edit lower
const HIGH_CONFIDENCE = 0.9;  // above: the recognizer was sure, distance 2 or more needs a phonetic match
const MIN_TERM_LENGTH = 5;    // compact length; shorter terms are never fuzzy matched
const MIN_ACRONYM = 3;
const MAX_ACRONYM = 8;
const MAX_NGRAM = 6;
const MIN_PHONETIC_KEY = 3;
const KINDS = ["name", "acronym", "term", "phrase"];

// Allowed edits by compact term length: 5 to 7 chars: 1, 8 to 12: 2, longer: 3.
const maxEdits = (len) => (len < MIN_TERM_LENGTH ? -1 : len <= 7 ? 1 : len <= 12 ? 2 : 3);

/* ------------------------------------------------------------------ */
/* Common words (never corrected into a term)                          */
/* ------------------------------------------------------------------ */

const COMMON_DE = (
  "und oder aber auch dann denn doch noch nur schon ja nein genau also mal eben halt so wie wo was wer wen wem wessen " +
  "der die das den dem des ein eine einer eines einem einen im in am an auf aus bei mit von vor zu zum zur nach über " +
  "unter durch für gegen ohne um bis seit während wegen zwischen hinter neben vom beim ans ins " +
  "es er sie wir ihr ich du man sich mich mir dir ihm ihn uns euch ihnen mein dein sein unser euer meine deine seine " +
  "unsere ihre ihren ihrer ihrem ihres seiner seinen seinem seines meinen meiner dieser diese dieses diesem diesen " +
  "jeder jede jedes jedem jeden jener jene jenes alle alles allem allen aller manche mancher manches einige einiger " +
  "ist sind war waren hat haben hatte hatten wird werden wurde wurden kann können konnte konnten muss müssen musste " +
  "soll sollen sollte sollten will wollen wollte darf dürfen mag möchte möchten sei seien gewesen worden geworden " +
  "nicht kein keine keiner keinen keinem dass ob wenn weil als obwohl damit sodass falls indem bevor nachdem solange " +
  "geht gibt gehen gegeben sagen sagt sagte gesagt machen macht gemacht kommt kommen kam gekommen sieht sehen sah " +
  "gesehen steht stehen stand liegt liegen lag bleibt bleiben blieb zeigt zeigen zeigte nimmt nehmen nahm genommen " +
  "bringt bringen brachte gilt gelten galt geben gab lässt lassen ließ findet finden fand gefunden denkt denken dachte " +
  "weiß wissen wusste glaube glauben meint meinen heißt heißen nennt nennen nannte bedeutet bedeuten dient dienen " +
  "dies hier da dort sehr mehr ganz viel viele vielen vieler vieles wenig wenige weniger meist meisten meisten " +
  "immer nie niemals oft manchmal heute gestern morgen jetzt damals früher später bereits zunächst zuerst danach " +
  "davor dabei dazu dafür dagegen darauf daraus darin darum darüber darunter davon dadurch deshalb deswegen daher " +
  "trotzdem außerdem allerdings jedoch sondern sowie sowohl entweder weder zwar eigentlich überhaupt natürlich " +
  "vielleicht wahrscheinlich tatsächlich eher besonders gerade ungefähr etwa fast kaum nämlich folglich somit " +
  "gut gute guten guter gutes besser beste neu neue neuen neuer neues alt alte alten alter altes groß große großen " +
  "großer großes klein kleine kleinen kleiner lang lange langen langer kurz kurze erste ersten erster erstes zweite " +
  "zweiten zweiter dritte dritten letzte letzten letzter andere anderen anderer anderes anderem eigene eigenen " +
  "gleich gleiche gleichen ganze ganzen ganzer ganzes ganzem jahr jahre jahren jahres jahrhundert jahrhunderts " +
  "zeit zeiten tag tage tagen woche monat mensch menschen leute frau mann kind kinder leben lebens welt land länder " +
  "ländern landes stadt städte stadt staat staates staaten staats volk völker volkes gesellschaft gesellschaften " +
  "krieg kriege krieges kriegen kriegs kriegen frieden macht mächte gewalt politik politische politischen " +
  "politischer politisches politisch politiker regierung regierungen recht rechte rechts system systeme systems " +
  "ordnung ordnungen interesse interessen frage fragen antwort problem probleme beispiel beispiele fall fälle " +
  "grund gründe punkt punkte thema themen teil teile teilen weise art arten form formen rolle ebene ebenen ziel " +
  "ziele weg wege mittel ergebnis ergebnisse prozess prozesse entwicklung ansatz theorie theorien annahme annahmen " +
  "begriff begriffe bereich bereiche beziehung beziehungen verhältnis situation lage möglichkeit möglichkeiten " +
  "aufgabe aufgaben maßnahmen sicherheit wirtschaft kultur geschichte zukunft gegenwart vergangenheit ende anfang " +
  "beginn mitte seite seiten sache sachen ding dinge stelle stellen platz raum räume hand hände kopf haus häuser " +
  "arbeit arbeiten werk wort worte wörter worten sinn sinne wert werte zahl zahlen ganz herr herren gruppe gruppen " +
  "mehrere mehrheit minderheit unterschied unterschiede schon schnell stark starke starken starker wichtig wichtige " +
  "wichtigen wichtiger möglich mögliche möglichen notwendig nötig klar klare klaren sicher sichere offen frei " +
  "wirklich richtig falsch falsche falschen real reale realen konkret konkrete allgemein allgemeine besondere " +
  "verschiedene verschiedenen verschiedener einzelne einzelnen einzelner bestimmte bestimmten bestimmter " +
  "zusammen zurück weiter weitere weiteren weiterer sogar sofort selbst selber gar wohl denn ebenso ebenfalls " +
  "beispielsweise sprich sozusagen quasi grob kurz lang hoch hohe hohen hoher höher niedrig nah nahe weit " +
  "unsere unseren unserer heißt ersten frage fragen schauen schaut schauen gucken guckt anschauen betrachten"
).split(/\s+/);

const COMMON_EN = (
  "the a an and or but of to in on at is it that this these those with for from by as are was were be been being " +
  "have has had having do does did done not no yes so if then than there here when where what which who whom whose " +
  "why how all any some each every both few more most other another such only own same too very just can could " +
  "will would shall should may might must also into out up down over under again further once about above below " +
  "between through during before after against without within along across behind beyond among around near " +
  "he she him her his hers they them their theirs we us our ours you your yours i me my mine its itself himself " +
  "themselves ourselves myself yourself one two three four five six seven eight nine ten first second third last " +
  "next new old good great small large long short high low early late young big little many much less least " +
  "said say says saying see sees saw seen make makes made making get gets got getting go goes went gone going " +
  "come comes came coming take takes took taken taking give gives gave given giving know knows knew known think " +
  "thinks thought thinking want wants wanted use uses used using find finds found tell tells told ask asks asked " +
  "work works worked working seem seems seemed feel feels felt try tries tried leave leaves left call calls " +
  "called keep keeps kept let lets begin begins began begun show shows showed shown hear hears heard play plays " +
  "run runs ran move moves moved live lives lived believe believes bring brings brought happen happens happened " +
  "write writes wrote written provide provides sit stand lose pay meet include includes included continue set " +
  "learn change lead understand watch follow stop create speak read allow add spend grow open walk win offer " +
  "remember love consider appear buy wait serve die send expect build stay fall cut reach kill remain " +
  "time times year years day days way ways man men woman women child children world life lives hand part place " +
  "case point week company system program question work government number night mile home water room mother area " +
  "money story fact month lot right study book eye job word business issue side kind head house service friend " +
  "father power hour game line end member law car city community name president team minute idea body information " +
  "back parent face others level office door health person art war history party result change morning reason " +
  "research girl guy moment air teacher force education foot boy age policy process music market sense nation " +
  "plan college interest death experience effect class control care field development role effort rate heart drug " +
  "show leader light voice wife police mind price report decision son view relationship town road arm difference " +
  "value building action model season society tax director position player record paper space ground form event " +
  "official matter center couple site project activity star table need court oil situation cost industry figure " +
  "street image phone data theory example theories states state political politics politic people country countries " +
  "general important different possible available likely certain public social national international military " +
  "economic common whole real clear sure free full special major local recent human strong able early young " +
  "however therefore thus hence because although though while whereas whether since unless until already still " +
  "yet even ever never always often sometimes usually perhaps maybe quite rather really actually basically " +
  "simply exactly especially generally particularly probably certainly almost nearly together apart away " +
  "something anything nothing everything someone anyone everyone nobody somebody another others whatever whenever " +
  "wherever whoever however well like likes liked okay right now today yesterday tomorrow later soon"
).split(/\s+/);

/* ------------------------------------------------------------------ */
/* Normalising and comparing                                           */
/* ------------------------------------------------------------------ */

const FOLD_AE = { "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss" }; // ä -> ae
const FOLD_A = { "ä": "a", "ö": "o", "ü": "u", "ß": "s" };      // ä -> a

// Lowercase, fold umlauts and accents, keep only letters and digits (so hyphens and spaces vanish).
function fold(text, map) {
  return String(text || "")
    .toLowerCase()
    .replace(/[äöüß]/g, (ch) => map[ch])
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}
const foldAe = (text) => fold(text, FOLD_AE);
const foldA = (text) => fold(text, FOLD_A);

const COMMON = new Set();
for (const w of [...COMMON_DE, ...COMMON_EN]) {
  COMMON.add(foldAe(w));
  COMMON.add(foldA(w));
}
const isCommon = (ae, a) => COMMON.has(ae) || COMMON.has(a);

// Damerau-Levenshtein (optimal string alignment). Returns limit + 1 as soon as it is clear the limit is exceeded.
function distance(a, b, limit) {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > limit) return limit + 1;
  let p2 = [];
  let p1 = [];
  let cur = [];
  for (let j = 0; j <= lb; j++) p1[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    [p2, p1, cur] = [p1, cur, p2];
  }
  return Math.min(p1[lb], limit + 1);
}

// Inflection endings. A word that differs from a term only by one of them is normal grammar, not an error.
const ENDINGS = ["ing", "ern", "en", "er", "es", "em", "ed", "ly", "e", "s", "n"];
function stem(w) {
  for (const e of ENDINGS) if (w.length - e.length >= 3 && w.endsWith(e)) return w.slice(0, -e.length);
  return w;
}
// "friktionen" vs "friktion": the term itself may end in a letter that looks like an ending, so compare both ways.
const sameStem = (a, b) => stem(a) === stem(b) || stem(a) === b || stem(b) === a;

/* ------------------------------------------------------------------ */
/* Phonetic keys                                                       */
/* ------------------------------------------------------------------ */

const has = (chars, ch) => ch !== "" && chars.includes(ch);

// Kölner Phonetik on a lowercase a-z string (umlauts already folded).
function koelner(w) {
  let out = "";
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const p = i > 0 ? w[i - 1] : "";
    const n = i + 1 < w.length ? w[i + 1] : "";
    let code = "";
    if ("aeijouy".includes(c)) code = "0";
    else if (c === "b") code = "1";
    else if (c === "p") code = n === "h" ? "3" : "1";
    else if (c === "d" || c === "t") code = has("csz", n) ? "8" : "2";
    else if (c === "f" || c === "v" || c === "w") code = "3";
    else if (c === "g" || c === "k" || c === "q") code = "4";
    else if (c === "c") {
      if (i === 0) code = has("ahkloqrux", n) ? "4" : "8";
      else code = has("sz", p) ? "8" : has("ahkoqux", n) ? "4" : "8";
    } else if (c === "x") code = has("ckq", p) ? "8" : "48";
    else if (c === "l") code = "5";
    else if (c === "m" || c === "n") code = "6";
    else if (c === "r") code = "7";
    else if (c === "s" || c === "z") code = "8";
    out += code; // "h" and anything else adds nothing
  }
  out = out.replace(/(.)\1+/g, "$1");
  return out.slice(0, 1) + out.slice(1).replace(/0/g, "");
}

// A small Metaphone like key for English: similar sounding spellings share a key.
function english(w) {
  let s = w
    .replace(/^(kn|gn|pn|wr)/, (m) => (m === "wr" ? "r" : "n"))
    .replace(/^x/, "s")
    .replace(/x/g, "ks")
    .replace(/ph/g, "f")
    .replace(/(sch|ch|sh|tch)/g, "x")
    .replace(/ck/g, "k")
    .replace(/th/g, "t")
    .replace(/wh/g, "w")
    .replace(/dg/g, "j")
    .replace(/gh(?=t|$)/g, "")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/z/g, "s")
    .replace(/v/g, "f");
  s = s.replace(/^[aeiouy]/, "a");
  s = s.slice(0, 1) + s.slice(1).replace(/[aeiouyhw]/g, "");
  return s.replace(/(.)\1+/g, "$1");
}

/* ------------------------------------------------------------------ */
/* Terms                                                               */
/* ------------------------------------------------------------------ */

function guessKind(term) {
  if (/\s/.test(term)) return "phrase";
  const letters = term.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 2 && letters.length <= MAX_ACRONYM && letters === letters.toUpperCase() && /\p{Lu}/u.test(letters)) return "acronym";
  return "term"; // a capitalised single word may be a German noun, so it is not guessed to be a name
}

// Array<string | {term, score, count, kind}> -> unique {term, score, count, kind}; case insensitive, first wins.
function normalizeTermList(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const raw = item && typeof item === "object" ? item : { term: item };
    const term = String(raw.term ?? "").trim().replace(/\s+/g, " ");
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push({
      term,
      score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : 0,
      count: Number.isFinite(Number(raw.count)) ? Number(raw.count) : 0,
      kind: KINDS.includes(raw.kind) ? raw.kind : guessKind(term),
    });
  }
  return out;
}

/** Array<string | {term}> -> unique, trimmed strings (the student's keyterms and extracted terms alike). */
export function termStrings(list) {
  return normalizeTermList(list).map((t) => t.term);
}

/* ------------------------------------------------------------------ */
/* The check                                                           */
/* ------------------------------------------------------------------ */

const isLetter = (ch) => /\p{L}/u.test(ch);

// Whitespace tokens (same split as correction.js) with the position of the core between edge punctuation.
function tokenizeSentence(text, words) {
  const aligned = Array.isArray(words) && words.length > 0;
  const tokens = [];
  for (const m of text.matchAll(/\S+/g)) {
    const raw = m[0];
    const lead = raw.search(/[\p{L}\p{N}]/u);
    let tail = raw.length;
    while (tail > 0 && !/[\p{L}\p{N}]/u.test(raw[tail - 1])) tail--;
    const tok = { raw, skip: lead < 0, trail: lead < 0 ? raw : raw.slice(tail), conf: null };
    if (lead >= 0) {
      tok.start = m.index + lead;
      tok.end = m.index + tail;
      tok.core = raw.slice(lead, tail);
      tok.ae = foldAe(tok.core);
      tok.a = foldA(tok.core);
      tok.common = isCommon(tok.ae, tok.a);
    }
    tokens.push(tok);
  }
  // Confidence only when the words add up to the text, like markedText in correction.js.
  if (aligned && tokens.length === words.length && tokens.every((t, i) => String(words[i].t) === t.raw)) {
    tokens.forEach((t, i) => { const c = Number(words[i].c); t.conf = Number.isFinite(c) ? c : null; });
  }
  return tokens;
}

function meanConfidence(tokens) {
  const values = tokens.map((t) => t.conf).filter((c) => c != null);
  return values.length === tokens.length && values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// Keep the case style of the sentence: a capitalised phrase stays capitalised when the term is written lower case.
function matchCase(found, term, kind) {
  if (kind === "name" || kind === "acronym") return term;
  const f = found[0];
  const t = term[0];
  if (f && t && isLetter(f) && f === f.toUpperCase() && f !== f.toLowerCase() && t === t.toLowerCase() && t !== t.toUpperCase()) {
    return f + term.slice(1);
  }
  return term;
}

function prepareEntries(terms, lang) {
  const entries = [];
  const acronyms = new Map(); // compact form -> entry, for spaced out letters and case variants
  const byLen = new Map();
  const compacts = new Set();
  const nGramSizes = new Set([1]);
  const phonetic = lang === "de" ? koelner : english;
  for (const t of terms) {
    const ae = foldAe(t.term);
    const a = foldA(t.term);
    const words = t.term.split(/[\s\-–]+/).filter(Boolean);
    const e = {
      ...t,
      ae,
      a,
      len: ae.length,
      maxD: maxEdits(ae.length),
      key: phonetic(a),
      words,
      wordAe: words.map(foldAe),
      sizes: new Set([words.length - 1, words.length, words.length + 1].filter((n) => n >= 1 && n <= MAX_NGRAM)),
      usable: false,
    };
    if (e.kind === "acronym" && ae.length >= MIN_ACRONYM && ae.length <= MAX_ACRONYM && !isCommon(ae, a)) {
      if (!acronyms.has(ae)) acronyms.set(ae, e);
      e.usable = true;
    }
    if (e.maxD >= 1) {
      e.usable = true;
      if (!byLen.has(e.len)) byLen.set(e.len, []);
      byLen.get(e.len).push(e);
      compacts.add(ae);
      for (const n of e.sizes) nGramSizes.add(n);
    }
    if (e.usable) entries.push(e);
  }
  return { entries, acronyms, byLen, compacts, maxN: Math.max(...nGramSizes), phonetic };
}

export function checkTerms(transcript, terms, { language = transcript.language } = {}) {
  const lang = language === "de" ? "de" : "en";
  const { entries, acronyms, byLen, compacts, maxN, phonetic } = prepareEntries(normalizeTermList(terms), lang);
  if (!entries.length) return { corrections: [], checkedTerms: 0 };

  const keyCache = new Map();
  const phoneKey = (a) => {
    if (!keyCache.has(a)) keyCache.set(a, phonetic(a));
    return keyCache.get(a);
  };

  // Best term for a candidate (n words, compact forms ae and a), cached because spoken words repeat a lot.
  const matchCache = new Map();
  function bestMatch(ae, a, n) {
    const cacheKey = `${n}|${ae}`;
    if (matchCache.has(cacheKey)) return matchCache.get(cacheKey);
    let best = null;
    const l = ae.length;
    let key = null;
    for (let len = Math.max(MIN_TERM_LENGTH, l - 4); len <= l + 4; len++) {
      for (const e of byLen.get(len) || []) {
        if (!e.sizes.has(n)) continue;
        const limit = e.maxD + 1;
        const d = Math.min(distance(ae, e.ae, limit), distance(a, e.a, limit));
        if (d > limit) continue;
        if (d > 0) {
          if (compacts.has(ae)) continue;       // the candidate is itself a course term
          if (sameStem(ae, e.ae)) continue;     // only an inflection ending differs
        }
        let phoneEq = false;
        if (d > 0) {
          if (key === null) key = phoneKey(a);
          phoneEq = key.length >= MIN_PHONETIC_KEY && key === e.key;
        }
        const better = !best || d < best.d || (d === best.d && ((phoneEq && !best.phoneEq) || (phoneEq === best.phoneEq && e.score > best.e.score)));
        if (better) best = { e, d, phoneEq };
      }
    }
    matchCache.set(cacheKey, best);
    return best;
  }

  // Is this candidate good enough? Returns { type, reason } or null.
  function decide(m, conf, a) {
    const { e, d, phoneEq } = m;
    if (d === 0) return { type: "fix", reason: `Course term "${e.term}" (spelling)` };
    const low = conf != null && conf < LOW_CONFIDENCE;
    const high = conf != null && conf > HIGH_CONFIDENCE;
    const sameFirst = a[0] === e.a[0];
    if (!sameFirst && !phoneEq) return null;
    if (e.len <= 6 && !(phoneEq && sameFirst)) return null; // short terms: only when it also sounds alike
    const limit = e.maxD + (low ? 1 : 0);
    const phoneCap = e.len <= 6 ? limit : Math.min(limit + 1, Math.floor(e.len * 0.4));
    const byEdit = d <= limit;
    const byPhone = phoneEq && d <= phoneCap;
    if (!byEdit && !byPhone) return null;
    if (high && d >= 2 && !phoneEq) return null;
    const sure = e.len >= 7 && (d <= 1 || (low && d <= 2 && phoneEq));
    const alike = phoneEq && (d >= 2 || !byEdit);
    return { type: sure ? "fix" : "guess", reason: `Course term "${e.term}" (${alike ? "sounds alike" : "similar spelling"})` };
  }

  // Word by word check for a phrase of the same length as the term: "kalten Krieg" vs "Kalter Krieg" is grammar.
  function onlyInflected(e, tokens) {
    if (tokens.length !== e.words.length) return false;
    let differs = false;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].ae === e.wordAe[i]) continue;
      if (!sameStem(tokens[i].ae, e.wordAe[i])) return false;
      differs = true;
    }
    return differs;
  }

  const hits = []; // { order: [p, s, start], find, replace, type, reason, d, score }
  (transcript.paragraphs || []).forEach((p, pi) => {
    (p.sentences || []).forEach((s, si) => {
      const text = String(s.text || "");
      if (!text) return;
      const tokens = tokenizeSentence(text, s.words);
      const found = [];

      const emit = (from, to, e, decision, d) => {
        const first = tokens[from];
        const last = tokens[to];
        const find = text.slice(first.start, last.end);
        const replace = matchCase(find, e.term, e.kind);
        if (find === replace) return;
        if (d === 0 && find.toLowerCase() === replace.toLowerCase() && e.kind !== "name" && e.kind !== "acronym") return; // case only
        found.push({ start: first.start, end: last.end, find, replace, type: decision.type, reason: decision.reason, d, score: e.score });
      };

      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].skip) continue;

        // Acronyms: "Nato", "N.A.T.O." and "N A T O" for NATO.
        if (acronyms.size) {
          const single = acronyms.get(tokens[i].ae);
          if (single && !tokens[i].common && tokens[i].core !== single.term) {
            emit(i, i, single, { type: "fix", reason: `Course term "${single.term}" (spelling)` }, 0);
          }
          let acc = "";
          for (let j = i; j < tokens.length && j - i < MAX_ACRONYM; j++) {
            const t = tokens[j];
            if (t.skip || t.core.length !== 1 || !isLetter(t.core)) break;
            acc += t.ae;
            const e = j > i ? acronyms.get(acc) : null;
            if (e) emit(i, j, e, { type: "fix", reason: `Course term "${e.term}" (spelling)` }, 0);
            if (/[,;:!?…]/.test(t.trail)) break;
          }
        }

        // Words and word groups (n words, also one more or fewer than the term has).
        let ae = "";
        let a = "";
        for (let n = 1; n <= maxN && i + n <= tokens.length; n++) {
          const t = tokens[i + n - 1];
          if (t.skip) break;
          if (n > 1 && /[,.;:!?…)]/.test(tokens[i + n - 2].trail)) break; // punctuation inside the group
          ae += t.ae;
          a += t.a;
          if (ae.length < 4 || /\d/.test(ae)) continue;
          const group = tokens.slice(i, i + n);
          if (group.every((g) => g.common)) continue;
          const m = bestMatch(ae, a, n);
          if (!m || onlyInflected(m.e, group)) continue;
          // More words than the term only for split words ("Hy bride"): a common word means the term plus its neighbour.
          if (n > m.e.words.length && (m.d > 1 || group.some((g) => g.common))) continue;
          const decision = decide(m, meanConfidence(group), a);
          if (decision) emit(i, i + n - 1, m.e, decision, m.d);
        }
      }

      // Best first within the sentence, no overlaps, one correction per find text.
      found.sort((x, y) => x.d - y.d || (x.type === "fix" ? 0 : 1) - (y.type === "fix" ? 0 : 1) || (y.end - y.start) - (x.end - x.start));
      const taken = [];
      const finds = new Set();
      for (const f of found) {
        if (finds.has(f.find) || taken.some((t) => f.start < t.end && t.start < f.end)) continue;
        const hit = locateText(text, f.find);
        if (!hit || text.slice(hit.index, hit.index + hit.length) !== f.find) continue;
        taken.push(f);
        finds.add(f.find);
        hits.push({ ...f, id: sentenceId(pi, si), order: [pi, si, f.start] });
      }
    });
  });

  // Keep the best ones when there are too many, then read in transcript order.
  hits.sort((x, y) => x.d - y.d || (x.type === "fix" ? 0 : 1) - (y.type === "fix" ? 0 : 1) || y.score - x.score);
  const kept = hits.slice(0, MAX_CORRECTIONS);
  kept.sort((x, y) => x.order[0] - y.order[0] || x.order[1] - y.order[1] || x.order[2] - y.order[2]);
  return {
    corrections: kept.map(({ id, find, replace, type, reason }) => ({ id, find, replace, type, reason })),
    checkedTerms: entries.length,
  };
}
