/* BluvIA — service worker
   Cachea los archivos estáticos para que la app abra rápido y funcione
   sin conexión. Los datos del usuario viven en IndexedDB, no acá. */

const CACHE_NAME = "bluvia-cache-v6";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

/* Al tocar una notificación, lleva a BluvIA (la abre si estaba cerrada,
   o la enfoca si ya estaba abierta en una pestaña). */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./index.html");
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Estrategia: network-first para TODO. Así, cada vez que hay conexión,
   BluvIA siempre muestra la versión publicada en ese momento — nada de
   quedarse "pegada" en una versión vieja por el caché. Sin conexión, usa
   la última copia guardada para que la app siga funcionando igual. */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() =>
        caches.match(req).then((r) => r || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );
});
