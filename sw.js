/* Me, Inc. — Service Worker v9
   HTML：網路優先（2.5 秒逾時就退回快取）→ 改版後一開就是新版
   程式與圖示：快取優先 + 背景更新 → 秒開
   後台 API：完全不攔截 */
const CACHE = 'meinc-v10';
const ASSETS = [
  './',
  './index.html',
  './app.js?v=10',
  './vendor.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const timeout = (ms) => new Promise((res) => setTimeout(() => res(null), ms));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.url.includes('script.google.com')) return;
  if (new URL(req.url).origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);

    if (isHTML) {
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      const res = await Promise.race([net, timeout(2500)]);
      if (res) return res;
      return (await cache.match(req)) || (await cache.match('./index.html')) || net;
    }

    const hit = await cache.match(req);
    const net = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  })());
});
