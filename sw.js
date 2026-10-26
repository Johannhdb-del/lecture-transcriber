// Service worker: always load the newest app files when online, fall back to the saved copy offline.
// Only the app's own files are handled; Deepgram, Claude and blob: URLs are never touched.

const CACHE = "lecture-transcriber-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has("range")) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // "no-cache" makes the browser ask the server every time instead of using its 10 minute copy.
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") {
      const shell = await cache.match(new URL("./", self.location).href);
      if (shell) return shell;
    }
    throw err;
  }
}
