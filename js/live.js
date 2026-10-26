// Live transcript while recording: streams 16 kHz mono Int16 audio to Deepgram's live API.
// Browser auth: the API key travels as WebSocket subprotocols ["token", key]
// (Sec-WebSocket-Protocol: token, <key>), because browsers cannot set an Authorization header.

const ENDPOINT = "wss://api.deepgram.com/v1/listen";
const MODEL = "nova-3";
const SAMPLE_RATE = 16000;
const RING_MAX_SAMPLES = 30 * SAMPLE_RATE; // 30 s of audio kept while connecting / reconnecting
const KEEPALIVE_MS = 4000;
const IDLE_BEFORE_KEEPALIVE_MS = 3000;
const DRAIN_MS = 80; // backlog is sent at 1.25x realtime (100 ms chunks), the maximum Deepgram accepts
const OPEN_TIMEOUT_MS = 10000;
const STOP_WAIT_MS = 5000;
const BACKOFF_MS = [1000, 2000, 4000, 4000, 4000];
const PARAGRAPH_PAUSE_SEC = 2;
const PARAGRAPH_WORDS = 120;
const LIVE_PRICE_PER_MIN = 0.0048;
const KEYTERM_PRICE_PER_MIN = 0.0013;

const KEY_MESSAGE = "Live text unavailable: Deepgram did not accept the key";
const NET_MESSAGE = "Live text unavailable: no connection to Deepgram";

const round2 = (v) => Math.round(v * 100) / 100;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// --- result grouping (pure, testable) ----------------------------------------------------------

// Collects Results / UtteranceEnd messages into utterances. Deepgram sends several is_final results
// per utterance; their words are appended and the utterance closes on speech_final or UtteranceEnd.
export function createLiveAccumulator() {
  const finals = [];
  let cur = []; // words of the open utterance
  let interim = "";

  function wordsOf(msg, offset) {
    const alt = msg?.channel?.alternatives?.[0];
    if (!alt) return [];
    const out = [];
    if (Array.isArray(alt.words) && alt.words.length) {
      for (const w of alt.words) {
        const t = String(w.punctuated_word || w.word || "").trim();
        if (!t) continue;
        const c = Number(w.confidence);
        const s = Number(w.start) + offset;
        const e = Number(w.end) + offset;
        out.push({
          t,
          c: Number.isFinite(c) ? round2(c) : 1,
          s: round2(Number.isFinite(s) ? s : offset),
          e: round2(Number.isFinite(e) ? Math.max(e, s) : offset),
        });
      }
      return out;
    }
    // No word list: spread the transcript over the result time.
    const parts = String(alt.transcript || "").split(/\s+/).filter(Boolean);
    const start = (isNum(msg.start) ? msg.start : 0) + offset;
    const dur = isNum(msg.duration) ? msg.duration : parts.length * 0.3;
    parts.forEach((t, i) => {
      out.push({ t, c: 1, s: round2(start + (dur * i) / parts.length), e: round2(start + (dur * (i + 1)) / parts.length) });
    });
    return out;
  }

  function toUtterance(words, open) {
    const u = {
      text: words.map((w) => w.t).join(" "),
      start: words[0].s,
      end: words[words.length - 1].e,
      words: words.slice(),
    };
    if (open) u.open = true;
    return u;
  }

  function closeUtterance() {
    if (cur.length) {
      finals.push(toUtterance(cur, false));
      cur = [];
    }
  }

  function handle(msg, offset = 0) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "Results") {
      const alt = msg.channel?.alternatives?.[0];
      const transcript = String(alt?.transcript || "").trim();
      if (msg.is_final) {
        const words = wordsOf(msg, offset);
        if (words.length) cur.push(...words);
        interim = "";
        if (msg.speech_final) closeUtterance();
      } else {
        interim = transcript;
      }
      return true;
    }
    if (msg.type === "UtteranceEnd") {
      closeUtterance();
      return true;
    }
    return false; // Metadata, SpeechStarted, errors, unknown: ignored
  }

  return {
    handle,
    closeUtterance,
    clearInterim() {
      interim = "";
    },
    // finals includes the still open utterance as the last entry (with open: true).
    snapshot() {
      const list = finals.slice();
      if (cur.length) list.push(toUtterance(cur, true));
      return { finals: list, interim };
    },
    result() {
      return finals.slice();
    },
  };
}

// --- transcriber ---------------------------------------------------------------------------------

export function createLiveTranscriber({ apiKey, language, keyterms = [], onUpdate, onStatus } = {}) {
  const acc = createLiveAccumulator();
  const terms = (Array.isArray(keyterms) ? keyterms : []).map((t) => String(t).trim()).filter(Boolean);

  let state = "idle"; // idle | connecting | open | reconnecting | closed | failed
  let ws = null;
  let wsSerial = 0; // identifies the current socket so late events of old sockets are ignored
  let paused = false;
  let stopping = false;
  let everOpened = false;
  let offsetSec = 0; // audio timeline position at which the current connection started

  const queue = []; // ArrayBuffers not yet sent
  let queuedSamples = 0;
  let receivedSamples = 0; // all audio handed to sendPcm
  let sentSamples = 0; // audio written to a socket
  let droppedSamples = 0; // audio lost to the 30 s ring limit

  let drainTimer = null;
  let keepAliveTimer = null;
  let reconnectTimer = null;
  let openTimer = null;
  let attempts = 0;
  let lastAudioAt = 0;
  let lastKeepAliveAt = 0;
  let startPromiseHandlers = null;
  let stopWaiter = null;

  const emitStatus = (message) => {
    try {
      if (typeof onStatus === "function") onStatus({ state, message });
    } catch (e) {
      /* UI errors never break streaming */
    }
  };
  const emitUpdate = () => {
    try {
      if (typeof onUpdate === "function") onUpdate(acc.snapshot());
    } catch (e) {
      /* UI errors never break streaming */
    }
  };
  const setState = (next, message) => {
    state = next;
    emitStatus(message);
  };

  function buildUrl() {
    const p = new URLSearchParams();
    p.append("model", MODEL);
    p.append("language", language || "de");
    p.append("encoding", "linear16");
    p.append("sample_rate", String(SAMPLE_RATE));
    p.append("channels", "1");
    p.append("punctuate", "true");
    p.append("interim_results", "true");
    p.append("endpointing", "300");
    p.append("utterance_end_ms", "1000");
    p.append("vad_events", "true");
    p.append("mip_opt_out", "true");
    for (const t of terms) p.append("keyterm", t); // one param per term, never comma joined
    return `${ENDPOINT}?${p.toString()}`;
  }

  function clearTimers() {
    for (const t of [drainTimer, keepAliveTimer, reconnectTimer, openTimer]) {
      if (t) {
        clearInterval(t);
        clearTimeout(t);
      }
    }
    drainTimer = keepAliveTimer = reconnectTimer = openTimer = null;
  }

  // --- audio queue ------------------------------------------------------------------------------
  function enqueue(buf) {
    queue.push(buf);
    queuedSamples += buf.byteLength >> 1;
    while (queuedSamples > RING_MAX_SAMPLES && queue.length > 1) {
      const dropped = queue.shift();
      queuedSamples -= dropped.byteLength >> 1;
      droppedSamples += dropped.byteLength >> 1;
    }
  }

  function isOpenSocket() {
    return !!ws && ws.readyState === 1;
  }

  function sendOne() {
    if (!isOpenSocket() || !queue.length) return false;
    const buf = queue.shift();
    queuedSamples -= buf.byteLength >> 1;
    try {
      ws.send(buf);
      sentSamples += buf.byteLength >> 1;
      lastAudioAt = Date.now();
    } catch (e) {
      /* the close event drives reconnecting; the chunk is lost */
    }
    return true;
  }

  function ensureDrain() {
    if (drainTimer) return;
    drainTimer = setInterval(() => {
      if (!isOpenSocket() || paused) {
        if (!queue.length) stopDrain();
        return;
      }
      sendOne();
      if (!queue.length) stopDrain();
    }, DRAIN_MS);
  }
  function stopDrain() {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = null;
  }

  function pump() {
    if (!isOpenSocket()) return;
    // Live audio goes out immediately; a backlog (after a reconnect) is paced by the drain timer.
    if (!drainTimer && queue.length <= 1) sendOne();
    else ensureDrain();
  }

  // --- keep alive ---------------------------------------------------------------------------------
  function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      if (!isOpenSocket()) return;
      const now = Date.now();
      const idle = paused || now - lastAudioAt >= IDLE_BEFORE_KEEPALIVE_MS;
      if (idle && now - lastKeepAliveAt >= KEEPALIVE_MS - 500) {
        lastKeepAliveAt = now;
        try {
          ws.send(JSON.stringify({ type: "KeepAlive" })); // TEXT frame
        } catch (e) {
          /* close event follows */
        }
      }
    }, 1000);
  }

  // --- connection -----------------------------------------------------------------------------------
  function failNow(message) {
    clearTimers();
    const sock = ws;
    ws = null;
    wsSerial++;
    if (sock) {
      try {
        sock.close();
      } catch (e) {
        /* ignore */
      }
    }
    queue.length = 0;
    queuedSamples = 0;
    acc.closeUtterance();
    setState("failed", message);
    emitUpdate();
    if (startPromiseHandlers) {
      const h = startPromiseHandlers;
      startPromiseHandlers = null;
      h.reject(new Error(message));
    }
    if (stopWaiter) stopWaiter();
  }

  function connect() {
    const serial = ++wsSerial;
    let socket;
    try {
      socket = new WebSocket(buildUrl(), ["token", String(apiKey || "").trim()]);
    } catch (e) {
      failNow(NET_MESSAGE);
      return;
    }
    socket.binaryType = "arraybuffer";
    ws = socket;
    let opened = false;

    openTimer = setTimeout(() => {
      if (serial !== wsSerial || opened) return;
      try {
        socket.close();
      } catch (e) {
        /* ignore */
      }
    }, OPEN_TIMEOUT_MS);

    socket.onopen = () => {
      if (serial !== wsSerial) return;
      opened = true;
      everOpened = true;
      attempts = 0;
      if (openTimer) clearTimeout(openTimer);
      openTimer = null;
      // Timestamps of this connection start at 0: the first audio it receives is at this timeline position.
      offsetSec = (sentSamples + droppedSamples) / SAMPLE_RATE;
      lastAudioAt = Date.now();
      lastKeepAliveAt = Date.now();
      setState("open", "Live text connected");
      startKeepAlive();
      if (startPromiseHandlers) {
        const h = startPromiseHandlers;
        startPromiseHandlers = null;
        h.resolve();
      }
      if (queue.length) ensureDrain();
    };

    socket.onmessage = (ev) => {
      if (serial !== wsSerial) return;
      try {
        if (typeof ev.data !== "string") return;
        const msg = JSON.parse(ev.data);
        if (acc.handle(msg, offsetSec)) emitUpdate();
      } catch (e) {
        /* never throw from onmessage */
      }
    };

    socket.onerror = () => {
      /* details are not exposed to scripts; onclose follows */
    };

    socket.onclose = (ev) => {
      if (serial !== wsSerial) return;
      if (openTimer) clearTimeout(openTimer);
      openTimer = null;
      ws = null;
      stopDrain();
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      acc.closeUtterance(); // the next connection restarts its clock
      acc.clearInterim();

      if (stopping || state === "closed" || state === "failed") {
        if (state !== "failed") state = "closed";
        emitUpdate();
        if (stopWaiter) stopWaiter();
        return;
      }
      const code = ev && ev.code;
      if (code === 1008 || (!opened && !everOpened)) {
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        failNow(code === 1008 || !offline ? KEY_MESSAGE : NET_MESSAGE);
        return;
      }
      emitUpdate();
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (attempts >= BACKOFF_MS.length) {
      failNow("Live text stopped: connection to Deepgram lost. The recording continues.");
      return;
    }
    const wait = BACKOFF_MS[attempts++];
    setState("reconnecting", "Connection lost, reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopping || state !== "reconnecting") return;
      connect();
    }, wait);
  }

  // --- public API -----------------------------------------------------------------------------------
  function start() {
    if (state !== "idle") return Promise.reject(new Error("Live text was already started."));
    if (!apiKey || !String(apiKey).trim()) {
      state = "failed";
      emitStatus("Live text unavailable: no API key");
      return Promise.reject(new Error("Live text unavailable: no API key"));
    }
    if (typeof WebSocket !== "function") {
      state = "failed";
      emitStatus("Live text unavailable: this browser has no WebSocket support");
      return Promise.reject(new Error("Live text unavailable: this browser has no WebSocket support"));
    }
    return new Promise((resolve, reject) => {
      startPromiseHandlers = { resolve, reject };
      setState("connecting", "Connecting live text");
      connect();
    });
  }

  function sendPcm(buf) {
    if (!buf || state === "idle" || state === "closed" || state === "failed" || stopping) return;
    const ab = buf instanceof ArrayBuffer ? buf : buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : null;
    if (!ab || ab.byteLength < 2) return;
    receivedSamples += ab.byteLength >> 1;
    enqueue(ab);
    pump();
  }

  function pause() {
    paused = true;
  }
  function resume() {
    paused = false;
    lastAudioAt = Date.now();
    pump();
  }

  function stop() {
    if (stopping) return stopPromise;
    stopping = true;
    stopPromise = new Promise((resolve) => {
      const finish = () => {
        clearTimers();
        const sock = ws;
        ws = null;
        wsSerial++;
        if (sock) {
          try {
            sock.close();
          } catch (e) {
            /* ignore */
          }
        }
        acc.closeUtterance();
        acc.clearInterim();
        if (state !== "failed") state = "closed";
        stopWaiter = null;
        if (startPromiseHandlers) {
          const h = startPromiseHandlers;
          startPromiseHandlers = null;
          h.reject(new Error("Live text was stopped before it connected."));
        }
        emitUpdate();
        resolve({ finals: acc.result(), durationSec: round2(receivedSamples / SAMPLE_RATE) });
      };

      if (!isOpenSocket()) return finish();

      stopDrain();
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const backlogSec = queuedSamples / SAMPLE_RATE;
      while (queue.length && isOpenSocket()) sendOne();
      try {
        ws.send(JSON.stringify({ type: "CloseStream" })); // TEXT frame; server flushes, sends Metadata, closes
      } catch (e) {
        return finish();
      }
      const timer = setTimeout(finish, STOP_WAIT_MS + Math.min(25000, backlogSec * 800));
      stopWaiter = () => {
        clearTimeout(timer);
        finish();
      };
    });
    return stopPromise;
  }
  let stopPromise = null;

  return {
    start,
    sendPcm,
    pause,
    resume,
    stop,
    get state() {
      return state;
    },
  };
}

// --- Transcript -----------------------------------------------------------------------------------

const SENTENCE_END = /[.!?]["'»“”’)\]]*$/;
const ABBREVIATION = /\p{L}\.\p{L}\.$/u; // "z.B." does not end a sentence

function splitSentences(words) {
  const out = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const last = i === words.length - 1;
    if (last || (SENTENCE_END.test(w.t) && !ABBREVIATION.test(w.t))) {
      out.push(cur);
      cur = [];
    }
  });
  return out;
}

export function liveToTranscript(liveResult, { title, language, keyterms } = {}) {
  const finals = Array.isArray(liveResult?.finals) ? liveResult.finals : [];
  const terms = Array.isArray(keyterms) ? keyterms.slice() : [];

  const paragraphs = [];
  let para = null;
  let paraWords = 0;
  let allWords = 0;
  let confSum = 0;
  let lowConfidence = 0;
  let lastEnd = null;

  for (const u of finals) {
    const words = (Array.isArray(u.words) ? u.words : [])
      .filter((w) => w && String(w.t || "") !== "")
      .map((w) => {
        const o = { t: String(w.t), c: isNum(w.c) ? round2(w.c) : 1 };
        if (isNum(w.s) && isNum(w.e)) {
          o.s = round2(w.s);
          o.e = Math.max(o.s, round2(w.e));
        }
        return o;
      });
    if (!words.length) continue;
    for (const sentWords of splitSentences(words)) {
      const first = sentWords[0];
      const last = sentWords[sentWords.length - 1];
      const start = isNum(first.s) ? first.s : (lastEnd ?? 0);
      const end = isNum(last.e) ? last.e : start;
      const gap = lastEnd === null ? 0 : start - lastEnd;
      if (!para || gap > PARAGRAPH_PAUSE_SEC || paraWords >= PARAGRAPH_WORDS) {
        para = { speaker: 0, start, end, sentences: [] };
        paragraphs.push(para);
        paraWords = 0;
      }
      para.sentences.push({ text: sentWords.map((w) => w.t).join(" "), start, end, words: sentWords });
      para.end = end;
      paraWords += sentWords.length;
      lastEnd = end;
      for (const w of sentWords) {
        allWords++;
        confSum += w.c;
        if (w.c < 0.6) lowConfidence++;
      }
    }
  }

  const reported = Number(liveResult?.durationSec);
  const lastWordEnd = paragraphs.length ? paragraphs[paragraphs.length - 1].end : 0;
  const durationSec = round2(Number.isFinite(reported) && reported > 0 ? reported : lastWordEnd);
  const cost = (durationSec / 60) * (LIVE_PRICE_PER_MIN + (terms.length ? KEYTERM_PRICE_PER_MIN : 0));

  return {
    id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: title || "Untitled",
    createdAt: new Date().toISOString(),
    engine: "deepgram-live",
    model: MODEL,
    language: language || "de",
    keyterms: terms,
    durationSec,
    speakerNames: {},
    paragraphs,
    stats: {
      words: allWords,
      avgConfidence: allWords ? Math.round((confSum / allWords) * 10000) / 10000 : 0,
      lowConfidence,
    },
    costUsd: Math.round(cost * 10000) / 10000,
  };
}
