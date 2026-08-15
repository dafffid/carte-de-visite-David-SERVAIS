const CACHE = "carte-symbotis-v2";
const FICHIERS = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

// Hôtes analytics : jamais interceptés, jamais mis en cache (network-only).
const ANALYTICS = ["goatcounter.com", "gc.zgo.at"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const hote = new URL(e.request.url).hostname;
  // On laisse passer la requête au réseau sans y toucher : le service worker
  // ne répond pas, le navigateur gère lui-même (et l'échec hors-ligne est
  // silencieux côté page).
  if (ANALYTICS.some((a) => hote === a || hote.endsWith("." + a))) return;

  // ignoreSearch : la carte s'ouvre aussi avec ?src=qr / ?src=partage /
  // ?src=vcard / ?src=sig — ces variantes doivent servir la page en cache.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((rep) => rep || fetch(e.request))
  );
});
