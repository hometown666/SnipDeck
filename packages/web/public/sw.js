/**
 * SnipDeck service worker
 *
 * 只做两件事：给外壳（HTML / 静态资源）做缓存，让「加到主屏」之后能秒开；
 * API 一律不缓存（/api/* 直接放行走网络），否则会拿到过期片段或假的执行结果。
 *
 * 注意：SW 只能在安全上下文里注册（https 或 localhost）。
 * 手机经 http://100.x.x.x:7878 访问时不是安全上下文，浏览器会跳过注册——
 * 想要完整 PWA，需要 tailscale serve 上 HTTPS（见 PLAN §12）。
 */
const VERSION = 'v1'
const CACHE = `snipdeck-shell-${VERSION}`
const CORE = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-maskable.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting()),
  )
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
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  // 导航请求：网络优先，断网回退到缓存的外壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./index.html', copy))
          return res
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || Response.error())),
    )
    return
  }

  // 静态资源：缓存优先（文件名带 hash，过期由 VERSION 控制）
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
        }
        return res
      })
    }),
  )
})
