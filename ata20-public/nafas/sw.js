// نَفَس — service worker: offline shell, font cache, background reminders
const VERSION = "nafas-v3.0.1";
const SHELL = ["./", "styles.css", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png"];
const FONT_CACHE = "nafas-fonts", STATE_CACHE = "nafas-state", STATE_URL = "./__state.json";
const KEEP = [VERSION, FONT_CACHE, STATE_CACHE];
const DAY = 864e5, MIN = 6e4, HOUR = 36e5;
const MILESTONES = [
  [20 * MIN, "٢٠ دقيقة", "النبض وضغط الدم يبدون ينزلون"],
  [12 * HOUR, "١٢ ساعة", "أول أكسيد الكربون بالدم يرجع لمستواه الطبيعي"],
  [2 * DAY, "يومين", "النيكوتين يطلع من جسمك، والشم والتذوق يتحسنون"],
  [3 * DAY, "٣ أيام", "التنفس أسهل والشعب الهوائية ترتخي"],
  [14 * DAY, "أسبوعين", "الدورة الدموية تتحسن والمشي أخف"],
  [90 * DAY, "٣ شهور", "وظائف الرئة تتحسن بشكل واضح"],
  [270 * DAY, "٩ شهور", "الكحة وضيق النفس يقلّون كثير"],
  [365 * DAY, "سنة", "خطر أمراض القلب التاجية صار نص خطر المدخن"],
  [5 * 365 * DAY, "٥ سنوات", "خطر الجلطة الدماغية ينزل بشكل كبير"],
  [10 * 365 * DAY, "١٠ سنوات", "خطر سرطان الرئة تقريباً نص خطر المدخن"],
  [15 * 365 * DAY, "١٥ سنة", "خطر أمراض القلب مثل اللي عمره ما دخّن"]
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    // only touch this app's caches: the origin may host other apps
    .then(keys => Promise.all(keys.filter(k => k.startsWith("nafas-") && !KEEP.includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONT_CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/__state.json")) return;

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(r => {
      if (r.ok && !r.redirected) { const copy = r.clone(); caches.open(VERSION).then(c => c.put("./", copy)); }
      return r;
    }).catch(() => caches.match("./")));
    return;
  }

  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return r;
  })));
});

// Background reminders (Chrome on Android, installed app)
self.addEventListener("periodicsync", e => {
  if (e.tag === "nafas-daily") e.waitUntil(backgroundCheck());
});

async function backgroundCheck() {
  const c = await caches.open(STATE_CACHE);
  const r = await c.match(STATE_URL);
  if (!r) return;
  let s; try { s = await r.json(); } catch { return; }
  if (!s || !Number.isFinite(s.quit)) return;
  const now = new Date(), el = Math.max(0, now - s.quit);
  const pad = n => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const opts = { lang: "ar", dir: "rtl", icon: "icons/icon-192.png", badge: "icons/icon-192.png" };
  let changed = false;

  if (s.rem && s.rem.on && s.lastDaily !== today) {
    const [h, m] = String(s.rem.time || "21:00").split(":").map(Number);
    if (now.getHours() * 60 + now.getMinutes() >= h * 60 + m) {
      const saved = el / DAY * s.perDay * (s.price / s.packSize);
      await self.registration.showNotification("نَفَس", { ...opts, tag: "daily",
        body: `صار لك ${Math.floor(el / DAY)} يوم بدون تدخين ووفّرت ${saved.toFixed(3)} ${s.cur}. كمّل!` });
      s.lastDaily = today; changed = true;
    }
  }
  if (s.rem && s.rem.ms && Number.isFinite(s.seenMs) && s.seenMs >= 0) {
    const reached = MILESTONES.filter(x => el >= x[0]).length;
    if (reached > s.seenMs) {
      const m = MILESTONES[reached - 1];
      await self.registration.showNotification(`نَفَس · ${m[1]}`, { ...opts, tag: "ms", body: m[2] });
      s.seenMs = reached; changed = true;
    }
  }
  if (changed) await c.put(STATE_URL, new Response(JSON.stringify(s), { headers: { "Content-Type": "application/json" } }));
}

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const w of list) if ("focus" in w) return w.focus();
    return self.clients.openWindow("./");
  }));
});
