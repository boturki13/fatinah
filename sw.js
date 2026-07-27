// ─── Service Worker: تشغيل اللعبة كاملة دون اتصال ─────────────────────────────
// يخزّن هيكل التطبيق (الصفحة + ملفات JS + الخطوط) حتى تعمل اللعبة بلا إنترنت.
// لا يخزّن أبداً طلبات /api — تلك تبقى شبكية دائماً.
const CACHE_NAME = 'fatinah-shell-v2';
const SHELL = [
  '/',
  '/server-config.js',
  '/firebase-config.js',
  '/vendor/firebase-app.js',
  '/vendor/firebase-auth.js',
  '/fonts/tajawal.css',
  '/fonts/tajawal-400-arabic.woff2',
  '/fonts/tajawal-400-latin.woff2',
  '/fonts/tajawal-500-arabic.woff2',
  '/fonts/tajawal-500-latin.woff2',
  '/fonts/tajawal-700-arabic.woff2',
  '/fonts/tajawal-700-latin.woff2',
  '/fonts/tajawal-800-arabic.woff2',
  '/fonts/tajawal-800-latin.woff2',
  '/fonts/tajawal-900-arabic.woff2',
  '/fonts/tajawal-900-latin.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // addAll يفشل كله لو فشل ملف واحد — خزّن كل ملف على حدة
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // طلبات API: شبكة فقط — لا تخزين (البيانات حيّة)
  if (url.pathname.startsWith('/api/')) return;

  // خطوط Google: cache-first (تبقى متاحة دون اتصال بعد أول زيارة)
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // الصفحة والملفات المحلية: network-first مع سقوط للكاش عند انقطاع الاتصال
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req).then((hit) => hit || (url.pathname === '/index.html' ? caches.match('/') : undefined))
    )
  );
});
