/* ======================================================================
   SERVICE WORKER — Impulsa Tu Vida
   Cachea el "shell" de la app (HTML, manifest, íconos) para que abra rápido.
   Tus gastos, ingresos, presupuesto y metas viven en tu cuenta de Supabase
   (no en este caché), así que registrar o ver movimientos requiere conexión;
   la sesión iniciada sí se recuerda en este dispositivo sin conexión.

   Si en el futuro editás index.html y los cambios no se ven al reabrir la
   app instalada, subí el número de CACHE_NAME (ej: "v2" -> "v3") para que
   el service worker descarte la caché vieja.
   ====================================================================== */
const CACHE_NAME = "impulsa-tu-vida-v3";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-48.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_NAME)
          .map((nombre) => caches.delete(nombre))
      )
    )
  );
  self.clients.claim();
});

// Estrategia: responde rápido desde la caché si existe, y en paralelo pide la
// versión de red para dejarla guardada (así la próxima vez ya está actualizada).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (!event.request.url.startsWith(self.location.origin)) return; // deja pasar Google Fonts, etc.

  event.respondWith(
    caches.match(event.request).then((cacheada) => {
      const desdeRed = fetch(event.request)
        .then((respuesta) => {
          if (respuesta && respuesta.ok) {
            const copia = respuesta.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
          }
          return respuesta;
        })
        .catch(() => cacheada);

      return cacheada || desdeRed;
    })
  );
});
