// ============================================================
// 泰国行程 PWA Service Worker
// - 离线缓存页面外壳（网络优先，离线回退缓存）
// - 只缓存静态资源，不缓存 /api 接口
// ============================================================
const CACHE = "thailand-trip-v3"; // 换新 logo，强制清理旧缓存
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/style.css",
  "/config.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（地图/图片等）不拦截
  if (url.pathname.startsWith("/api/")) return;    // API 不缓存

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          if (req.mode === "navigate") return caches.match("/index.html");
          return undefined;
        })
      )
  );
});
