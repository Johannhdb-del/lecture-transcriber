// Terms of a course: the student's keyterm list first, then the best terms from the course documents.
import { listDocuments } from "./storage.js";
import { mergeTerms } from "./doc-terms.js";

export const DEEPGRAM_TERM_LIMIT = 50; // Deepgram works best with about 50 keyterms per request
export const CHECK_TERM_LIMIT = 150;   // terms used by the term check and the Claude correction prompt

/** Ranked document terms of a course as strings, best first. Never throws. */
export async function courseDocTerms(courseId, { limit = CHECK_TERM_LIMIT } = {}) {
  if (!courseId) return [];
  try {
    return mergeTerms(await listDocuments(courseId), { limit }).map((t) => t.term);
  } catch {
    return [];
  }
}

/** The list terms in full, then document terms up to `limit` in total, without case-insensitive duplicates. */
export function combineTerms(listTerms, docTerms, limit = DEEPGRAM_TERM_LIMIT) {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    const term = String(t || "").trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };
  for (const t of listTerms || []) add(t);
  for (const t of docTerms || []) {
    if (out.length >= limit) break;
    add(t);
  }
  return out;
}
