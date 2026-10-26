// Deepgram engine: key test, upload/transcribe via XHR, response normalization.
import { estimateCost } from "../format.js";

export const ENGINE_ID = "deepgram";
const API = "https://api.deepgram.com/v1";
const MODEL = "nova-3";

// Half a second of silence as a 16 kHz mono WAV, used to test a key.
function silentWav(seconds = 0.5, rate = 16000) {
  const samples = Math.round(seconds * rate);
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + samples * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples * 2, true);
  return new Blob([buf], { type: "audio/wav" });
}

// Only /v1/listen allows browser (CORS) requests, so the key is tested with a tiny transcription.
export async function testKey(apiKey) {
  try {
    const res = await fetch(`${API}/listen?model=${MODEL}&mip_opt_out=true`, {
      method: "POST",
      headers: { Authorization: `Token ${String(apiKey || "").trim()}`, "Content-Type": "audio/wav" },
      body: silentWav(),
    });
    if (res.ok) return { ok: true, message: "Key accepted." };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Key not accepted." };
    return { ok: false, message: `Deepgram answered with status ${res.status}.` };
  } catch (e) {
    return { ok: false, message: "Network error. Check the connection and try again." };
  }
}

const MIME_BY_EXT = {
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mov: "video/quicktime",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

function contentTypeFor(file) {
  if (file.type === "audio/x-m4a") return "audio/mp4"; // Safari's name for Voice Memos files
  if (file.type) return file.type;
  const ext = (file.name || "").split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function makeError(message, name) {
  const err = new Error(message);
  if (name) err.name = name;
  return err;
}

function errorForStatus(xhr) {
  const status = xhr.status;
  if (status === 0) return makeError("Network error. Check the connection and keep this tab open.");
  if (status === 401) return makeError("Deepgram did not accept the API key. Check it in Settings.");
  if (status === 402) return makeError("Deepgram credit used up.");
  if (status === 413) return makeError("File too large for Deepgram (max 2 GB).");
  if (status === 429) return makeError("Too many requests, try again in a minute.");
  if (status === 504) return makeError("Deepgram took too long (over 10 minutes of processing).");
  let detail = "";
  try {
    const body = JSON.parse(xhr.responseText);
    detail = body.err_msg || body.error || body.message || "";
  } catch (e) {
    /* body is not JSON */
  }
  if (!detail) detail = xhr.getResponseHeader("dg-error") || "";
  if (status === 400) return makeError(`Deepgram rejected the file or settings${detail ? ": " + detail : "."}`);
  return makeError(`Deepgram error ${status}${detail ? ": " + detail : "."}`);
}

export function transcribe({
  file,
  apiKey,
  language,
  keyterms = [],
  diarizer = "v1",
  smartFormat = false,
  onUploadProgress,
}) {
  const xhr = new XMLHttpRequest();
  let aborted = false;

  const params = new URLSearchParams();
  params.append("model", MODEL);
  params.append("language", language);
  params.append("punctuate", "true");
  params.append("paragraphs", "true");
  params.append("diarize_model", diarizer);
  params.append("mip_opt_out", "true");
  if (smartFormat) params.append("smart_format", "true");
  for (const term of keyterms) params.append("keyterm", term); // one param per term, never comma joined

  const promise = new Promise((resolve, reject) => {
    xhr.open("POST", `${API}/listen?${params.toString()}`);
    xhr.setRequestHeader("Authorization", `Token ${String(apiKey || "").trim()}`);
    xhr.setRequestHeader("Content-Type", contentTypeFor(file));
    xhr.timeout = 0; // long files can take minutes

    if (xhr.upload && typeof onUploadProgress === "function") {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onUploadProgress(Math.min(1, e.loaded / e.total));
      };
      xhr.upload.onload = () => onUploadProgress(1);
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(errorForStatus(xhr));
      try {
        const json = JSON.parse(xhr.responseText);
        const title = (file.name || "").replace(/\.[^.]+$/, "") || "Untitled";
        resolve(normalizeDeepgramResponse(json, { title, language, keyterms }));
      } catch (e) {
        reject(makeError("Could not read the answer from Deepgram."));
      }
    };
    xhr.onerror = () => reject(errorForStatus(xhr));
    xhr.onabort = () => reject(makeError("Cancelled", "AbortError"));

    xhr.send(file);
  });

  return {
    promise,
    abort: () => {
      aborted = true;
      xhr.abort();
    },
    get aborted() {
      return aborted;
    },
  };
}

const PAUSE_SPLIT_SEC = 2;

// Fallback when Deepgram sends no paragraphs: group words by speaker and pauses.
function paragraphsFromWords(words) {
  const out = [];
  let cur = null;
  for (const w of words) {
    const text = w.punctuated_word || w.word || "";
    if (!text) continue;
    const speaker = w.speaker ?? 0;
    if (!cur || cur.speaker !== speaker || w.start - cur.lastEnd > PAUSE_SPLIT_SEC) {
      cur = { speaker, start: w.start, end: w.end, lastEnd: w.end, parts: [], sentStart: w.start };
      out.push(cur);
    }
    cur.parts.push(text);
    cur.end = w.end;
    cur.lastEnd = w.end;
  }
  return out.map((p) => ({
    speaker: p.speaker,
    start: p.start,
    end: p.end,
    sentences: [{ text: p.parts.join(" "), start: p.start, end: p.end }],
  }));
}

export function normalizeDeepgramResponse(json, { title, language, keyterms } = {}) {
  const alt = json?.results?.channels?.[0]?.alternatives?.[0] || {};
  const words = Array.isArray(alt.words) ? alt.words : [];
  const dgParagraphs = alt.paragraphs?.paragraphs;

  let paragraphs;
  if (Array.isArray(dgParagraphs) && dgParagraphs.length) {
    paragraphs = dgParagraphs
      .map((p) => {
        const sentences = (p.sentences || [])
          .map((s) => ({ text: String(s.text || "").trim(), start: s.start, end: s.end }))
          .filter((s) => s.text);
        if (!sentences.length) return null;
        return {
          speaker: p.speaker ?? 0,
          start: p.start ?? sentences[0].start,
          end: p.end ?? sentences[sentences.length - 1].end,
          sentences,
        };
      })
      .filter(Boolean);
  } else {
    paragraphs = paragraphsFromWords(words);
  }

  const terms = Array.isArray(keyterms) ? keyterms.slice() : [];
  let durationSec = Number(json?.metadata?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    durationSec = words.length ? words[words.length - 1].end : 0;
  }
  const confSum = words.reduce((sum, w) => sum + (Number(w.confidence) || 0), 0);

  return {
    id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: title || "Untitled",
    createdAt: new Date().toISOString(),
    engine: ENGINE_ID,
    model: MODEL,
    language: language || "de",
    keyterms: terms,
    durationSec,
    speakerNames: {},
    paragraphs,
    stats: {
      words: words.length,
      avgConfidence: words.length ? Math.round((confSum / words.length) * 10000) / 10000 : 0,
    },
    costUsd: Math.round(estimateCost(durationSec, terms.length > 0) * 10000) / 10000,
  };
}
