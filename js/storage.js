// Persistence: localStorage for key/settings/keyterm lists, IndexedDB for transcripts.

const KEY_API = "lt.apiKey";
const KEY_SETTINGS = "lt.settings";
const KEY_LISTS = "lt.keytermLists";

// In-memory fallback so the app still works when localStorage is blocked (private mode).
const memory = new Map();

function lsGet(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch (e) {
    /* storage unavailable */
  }
  return memory.has(key) ? memory.get(key) : null;
}

function lsSet(key, value) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* quota or private mode: memory copy remains */
  }
}

function lsRemove(key) {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch (e) {
    /* ignore */
  }
}

function lsGetJSON(key, fallback) {
  const raw = lsGet(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

// ---- API key ----

export function getApiKey() {
  return lsGet(KEY_API) || "";
}

export function setApiKey(key) {
  lsSet(KEY_API, String(key || "").trim());
}

export function clearApiKey() {
  lsRemove(KEY_API);
}

// ---- Settings ----

const DEFAULT_SETTINGS = {
  language: "de",
  diarizer: "v1",
  keytermListId: "",
  smoothSpeakers: true,
  liveTranscript: true,   // show live text while recording (needs the key; costs a little extra)
  highlightUncertain: true,
  textSize: "m",          // "s" | "m" | "l"
  showTimestamps: true,
  markerLead: 0.12,       // seconds the word marker runs ahead of the audio (-0.5 to 1.0)
  sidebarOpen: null,      // null = decide by screen width on first start
  panelOpen: null,        // null = open on wide screens
  panelTab: "notes",
  playbackRate: 1,
};

export function getSettings() {
  const saved = lsGetJSON(KEY_SETTINGS, {});
  return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}) };
}

export function saveSettings(partial) {
  const merged = { ...getSettings(), ...(partial || {}) };
  lsSet(KEY_SETTINGS, JSON.stringify(merged));
  return merged;
}

// ---- Keyterm lists ----

function readLists() {
  const lists = lsGetJSON(KEY_LISTS, []);
  return Array.isArray(lists) ? lists : [];
}

export function listKeytermLists() {
  return readLists()
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
}

export function saveKeytermList(list) {
  const item = { ...list };
  if (!item.id) item.id = crypto.randomUUID();
  if (!Array.isArray(item.terms)) item.terms = [];
  const lists = readLists();
  const i = lists.findIndex((l) => l.id === item.id);
  if (i >= 0) lists[i] = item;
  else lists.push(item);
  lsSet(KEY_LISTS, JSON.stringify(lists));
  return item;
}

export function deleteKeytermList(id) {
  lsSet(KEY_LISTS, JSON.stringify(readLists().filter((l) => l.id !== id)));
  // Forget the default selection if it pointed at the deleted list.
  if (getSettings().keytermListId === id) saveSettings({ keytermListId: "" });
}

// ---- Transcripts (IndexedDB) ----

const DB_NAME = "lecture-transcriber";
const STORE = "transcripts";
const DOC_STORE = "documents"; // course documents: { id, courseId, name, kind, pages, addedAt, text, emphasis, terms }
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(DOC_STORE)) {
          db.createObjectStore(DOC_STORE, { keyPath: "id" }).createIndex("courseId", "courseId");
        }
      };
      req.onsuccess = () => resolve(req.result);
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
async function withStore(mode, fn, store = STORE) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result;
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => {
      result = req.result;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || req.error || new Error("Storage transaction aborted."));
  });
}

export async function saveTranscript(t) {
  await withStore("readwrite", (s) => s.put(t));
  return t;
}

export async function listTranscripts() {
  const all = (await withStore("readonly", (s) => s.getAll())) || [];
  return all
    .map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      durationSec: t.durationSec,
      language: t.language,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function getTranscript(id) {
  const t = await withStore("readonly", (s) => s.get(id));
  return t || null;
}

export async function deleteTranscript(id) {
  await withStore("readwrite", (s) => s.delete(id));
}

// ---- Course documents (IndexedDB) ----
// A course is a keyterm list; its documents give extra terms (see doc-terms.js).

export async function saveDocument(doc) {
  const item = { ...doc };
  if (!item.id) item.id = crypto.randomUUID();
  if (!item.addedAt) item.addedAt = new Date().toISOString();
  await withStore("readwrite", (s) => s.put(item), DOC_STORE);
  return item;
}

export async function listDocuments(courseId) {
  if (!courseId) return [];
  const all = (await withStore("readonly", (s) => s.index("courseId").getAll(courseId), DOC_STORE)) || [];
  return all.sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0));
}

export async function deleteDocument(id) {
  await withStore("readwrite", (s) => s.delete(id), DOC_STORE);
}

export async function deleteCourseDocuments(courseId) {
  for (const d of await listDocuments(courseId)) await deleteDocument(d.id);
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return Boolean(await navigator.storage.persist());
  } catch (e) {
    /* ignore */
  }
  return false;
}
