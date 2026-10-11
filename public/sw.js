// Service worker mínimo: guarda la "cáscara" de la app para que abra rápido.
// Los datos (API y archivos) siempre van a la red.
const CACHE = 'cadio-shell-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/clinical.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) return;
  // Red primero, caché como respaldo sin conexión.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});

// Notificaciones push: alertas al médico y recordatorios al paciente.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Cadio-sup', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Cadio-sup', {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag,
    renotify: Boolean(data.tag),
    requireInteraction: Boolean(data.urgent),
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.location.origin));
    if (open) return open.navigate(url).then((c) => (c || open).focus());
    return self.clients.openWindow(url);
  }));
});
