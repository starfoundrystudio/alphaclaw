// Retires the root-scoped OpenClaw Control UI service worker used before the
// managed UI moved to /openclaw. The current upstream worker is served and
// acknowledgement-gated inside that namespace.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name)))),
      self.registration.unregister(),
    ]).then(() => self.clients.claim()),
  );
});
