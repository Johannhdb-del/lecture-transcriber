// Media persistence: audio files and in-progress recording chunks in a separate IndexedDB database.
// Kept apart from storage.js so large Blobs never touch the transcript database.

const DB_NAME = "lecture-transcriber-media";
const AUDIO = "audio";
const CHUNKS = "recordingChunks";
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("Local storage is not available in this browser."));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: "id" });
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ["sessionId", "index"] });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Let a newer version or a "clear site data" close the connection cleanly.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error("Could not open local storage."));
      req.onblocked = () => reject(new Error("Local storage is blocked by another tab."));
    });
    dbPromise.catch(() => {
      dbPromise = null; // allow a retry later
    });
  }
  return dbPromise;
}

// Run one request in a transaction; resolves after the transaction completes.
async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeName, mode);
    } catch (e) {
      dbPromise = null; // connection may be stale
      reject(e);
      return;
    }
    let result;
    const req = fn(tx.objectStore(storeName));
    if (req) {
      req.onsuccess = () => {
        result = req.result;
      };
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || (req && req.error));
    tx.onabort = () => reject(tx.error || (req && req.error) || new Error("Storage transaction aborted."));
  });
}

// Key range covering every chunk of one session (numbers sort below Infinity).
function sessionRange(sessionId) {
  return IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
}

// ---- Audio files ----

export async function saveAudio({ id, blob, name, type }) {
  if (!id) throw new Error("saveAudio needs an id.");
  if (!(blob instanceof Blob)) throw new Error("saveAudio needs a Blob.");
  const record = {
    id,
    blob,
    name: name || "",
    type: type || blob.type || "",
    size: blob.size,
    savedAt: new Date().toISOString(),
  };
  await withStore(AUDIO, "readwrite", (s) => s.put(record));
  return record;
}

export async function getAudio(id) {
  const record = await withStore(AUDIO, "readonly", (s) => s.get(id));
  return record || null;
}

export async function deleteAudio(id) {
  await withStore(AUDIO, "readwrite", (s) => s.delete(id));
}

// Metadata only. A cursor still touches each record, but Blob data stays lazy and is never read here.
export async function listAudio() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO, "readonly");
    const out = [];
    const req = tx.objectStore(AUDIO).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      const r = cur.value;
      out.push({ id: r.id, name: r.name, size: r.size, savedAt: r.savedAt });
      cur.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || req.error || new Error("Storage transaction aborted."));
  });
}

// ---- Recording chunks (crash recovery for in-progress recordings) ----

export async function appendRecordingChunk(sessionId, index, blob) {
  const record = { sessionId, index, blob, size: blob.size, savedAt: new Date().toISOString() };
  await withStore(CHUNKS, "readwrite", (s) => s.put(record));
}

export async function getRecordingSessions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNKS, "readonly");
    const sessions = new Map();
    const req = tx.objectStore(CHUNKS).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      const r = cur.value;
      let s = sessions.get(r.sessionId);
      if (!s) {
        s = { sessionId: r.sessionId, chunks: 0, bytes: 0, startedAt: r.savedAt };
        sessions.set(r.sessionId, s);
      }
      s.chunks += 1;
      s.bytes += r.size || 0;
      if (r.savedAt && (!s.startedAt || r.savedAt < s.startedAt)) s.startedAt = r.savedAt;
      cur.continue();
    };
    tx.oncomplete = () => {
      resolve([...sessions.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0)));
    };
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || req.error || new Error("Storage transaction aborted."));
  });
}

// Chunks come back ordered by their composite key, i.e. by index.
export async function assembleRecording(sessionId, type) {
  const records = (await withStore(CHUNKS, "readonly", (s) => s.getAll(sessionRange(sessionId)))) || [];
  if (!records.length) throw new Error("No saved audio found for this recording.");
  return new Blob(
    records.map((r) => r.blob),
    { type: type || "" }
  );
}

export async function deleteRecordingSession(sessionId) {
  await withStore(CHUNKS, "readwrite", (s) => s.delete(sessionRange(sessionId)));
}

// ---- Quota ----

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage || 0, quota: quota || 0 };
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}
