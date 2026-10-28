// 极简 Service Worker：静态资源走缓存，接口与 WebSocket 一律直连
const CACHE = 'dsh-console-v1'
const ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/icon.svg', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/ws') return
  if (event.request.method !== 'GET') return

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {})
        return res
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/index.html'))),
  )
})
