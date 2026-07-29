/* Randy's Guide service worker — works at / or /randyGuide/ */
const CACHE = "randys-guide-v14";

self.addEventListener("install", (event) => {
  const base = new URL(self.registration.scope).pathname;
  const PRECACHE = [
    base,
    `${base}index.html`,
    `${base}styles.css?v=14`,
    `${base}app.js?v=14`,
    `${base}kml-client.js?v=14`,
    `${base}manifest.webmanifest`,
    `${base}icons/app/icon-192.png`,
    `${base}icons/app/icon-512.png`,
    `${base}icons/app/icon-180.png`,
  ];
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn("Precache failed", err))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const base = new URL(self.registration.scope).pathname;

  // Live place data / APIs: network-first
  if (
    url.pathname.startsWith(`${base}api/`) ||
    url.pathname.startsWith(`${base}data/`) ||
    url.pathname.endsWith("/map.kml")
  ) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
